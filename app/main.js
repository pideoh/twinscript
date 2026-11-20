// Electron main process: serves the static web app from app://rt/ and adds what a browser tab
// cannot do on its own: system audio without the share dialog and a caption overlay that floats
// above full-screen apps. The rules themselves live in policy.js (unit-tested without Electron).
import { app, BrowserWindow, desktopCapturer, protocol, screen, session, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEME, START_URL, CAPTION_WINDOW, resolveAppFile, isAppUrl, isExternalUrl, windowOpenAction, allowPermission,
} from './policy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Lets the smoke test (test/app/) run against a throwaway profile instead of the user's data.
if (process.env.RT_USER_DATA) app.setPath('userData', process.env.RT_USER_DATA);

// A standard, secure scheme gives the app a stable origin (so localStorage and IndexedDB persist)
// and the same rules as https: ES modules, AudioWorklet, getUserMedia, fetch.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;

function serveAppFiles(ses) {
  ses.protocol.handle(SCHEME, async (request) => {
    const file = resolveAppFile(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(join(ROOT, file.path));
      return new Response(body, { headers: { 'Content-Type': file.type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function guardPermissions(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermission(permission, details.requestingUrl ?? ''));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowPermission(permission, requestingOrigin));
}

// Answers getDisplayMedia ("PC音声") with the primary screen and system audio, without a picker.
function handleDisplayMedia(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isAppUrl(request.securityOrigin ?? request.frame?.url ?? '')) return callback(null);
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const primary = String(screen.getPrimaryDisplay().id);
      const video = sources.find((s) => s.display_id === primary) ?? sources[0];
      if (!video) return callback(null);
      callback({ video, audio: 'loopback' });
    } catch {
      callback(null);
    }
  });
}

function openCaptionOverlay(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 420,
    title: 'Realtime Translate',
    backgroundColor: '#0b1120',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler((details) => {
    const action = windowOpenAction(details);
    if (action === 'external') shell.openExternal(details.url);
    if (action !== 'captions') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 720,
        height: 220,
        minWidth: 240,
        minHeight: 80,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        resizable: true,
        skipTaskbar: true,
        title: '字幕',
      },
    };
  });
  contents.on('did-create-window', (win, details) => {
    if (details.frameName === CAPTION_WINDOW) openCaptionOverlay(win);
  });
  mainWindow.on('closed', () => {
    // The overlay holds the caption zone of this page; it has nothing to show without it.
    for (const win of BrowserWindow.getAllWindows()) win.close();
    mainWindow = null;
  });
  mainWindow.loadURL(START_URL);
}

// Every page (main window and overlay) stays on app://rt/; web links go to the system browser.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
});

app.whenReady().then(() => {
  const ses = session.defaultSession;
  serveAppFiles(ses);
  guardPermissions(ses);
  handleDisplayMedia(ses);
  createMainWindow();
  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
