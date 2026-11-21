// Electron main process: serves the static web app from app://rt/ and adds what a browser tab
// cannot do on its own: system audio without the share dialog, a caption overlay that floats
// above full-screen apps and secrets encrypted by the operating system. The rules themselves live
// in policy.js, system-audio.js, secrets.js and shortcuts.js (unit-tested without Electron).

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import {
  allowPermission,
  CAPTION_WINDOW,
  isAppUrl,
  isExternalUrl,
  resolveAppFile,
  SCHEME,
  START_URL,
  windowOpenAction,
} from './policy.js';
import { createSecretStore } from './secrets.js';
import { createShortcuts } from './shortcuts.js';
import { createSampleFramer, endReason, helperPath, isSystemAudioCaller } from './system-audio.js';

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

// macOS: Electron's loopback audio delivers no samples there, so "PC音声" comes from a native
// helper (ScreenCaptureKit) instead, streamed to the page through the preload script.
let helper = null; // { proc, contents }

function stopSystemAudio() {
  if (!helper) return;
  const { proc } = helper;
  helper = null; // an exit we asked for is not reported to the page
  proc.stdin.destroy();
  proc.kill('SIGTERM');
}

function startSystemAudio(contents) {
  stopSystemAudio();
  const file = helperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: ROOT });
  const proc = spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const current = { proc, contents };
  helper = current;
  const frame = createSampleFramer();
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    const samples = frame(chunk);
    if (samples && helper === current && !contents.isDestroyed()) contents.send('system-audio:data', samples);
  });
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-1000);
  });
  proc.stdin.on('error', () => {}); // the helper may exit before we close its stdin
  const ended = (code) => {
    if (helper !== current) return;
    helper = null;
    if (stderr.trim()) console.error(`system-audio: ${stderr.trim()}`);
    if (!contents.isDestroyed()) contents.send('system-audio:end', endReason(code));
  };
  proc.on('exit', (code) => ended(code));
  // Not starting at all (e.g. the helper is missing) rejects start(); a later failure is an end.
  let spawned = false;
  return new Promise((resolve, reject) => {
    proc.once('spawn', () => {
      spawned = true;
      resolve();
    });
    proc.once('error', (err) => {
      if (spawned) return ended(null);
      if (helper === current) helper = null;
      reject(err);
    });
  });
}

// Only the app's own page in the main window's top frame may use the IPC handlers below.
const allowed = (event) =>
  isSystemAudioCaller({
    url: event.senderFrame?.url,
    isMainFrame: event.senderFrame === event.sender.mainFrame,
    isMainWindow: !!mainWindow && event.sender === mainWindow.webContents,
  });

function handleSystemAudio() {
  ipcMain.handle('system-audio:start', async (event) => {
    if (!allowed(event)) throw new Error('not allowed');
    await startSystemAudio(event.sender);
  });
  ipcMain.handle('system-audio:stop', (event) => {
    if (!allowed(event)) throw new Error('not allowed');
    stopSystemAudio();
  });
  app.on('will-quit', stopSystemAudio);
}

// The API key, encrypted with safeStorage. Nothing is written when encryption is unavailable.
function handleSecrets() {
  const secrets = createSecretStore({
    file: join(app.getPath('userData'), 'secrets.json'),
    encryption: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (bytes) => safeStorage.decryptString(bytes),
    },
  });
  ipcMain.handle('secret:get', (event, name) => {
    if (!allowed(event)) throw new Error('not allowed');
    return secrets.get(name);
  });
  ipcMain.handle('secret:set', (event, name, value) => {
    if (!allowed(event)) throw new Error('not allowed');
    return secrets.set(name, value);
  });
}

// The caption overlay, while open, and whether mouse events pass through it to the app below.
let captionOverlay = null;
let clickThrough = false;

function applyClickThrough() {
  if (captionOverlay && !captionOverlay.isDestroyed())
    captionOverlay.setIgnoreMouseEvents(clickThrough, { forward: true });
}

function openCaptionOverlay(win) {
  captionOverlay = win;
  win.on('closed', () => {
    if (captionOverlay === win) captionOverlay = null;
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyClickThrough();
}

function handleCaptionOverlay() {
  ipcMain.handle('caption-overlay:click-through', (event, on) => {
    if (!allowed(event)) throw new Error('not allowed');
    clickThrough = on === true;
    applyClickThrough();
  });
}

// Global shortcuts (start / stop, show / hide the caption window): the page performs the action
// as if its button had been pressed. A key taken by another app is reported, not fatal.
function handleShortcuts() {
  const shortcuts = createShortcuts({
    register: (accelerator, fn) => globalShortcut.register(accelerator, fn),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    platform: process.platform,
    onCommand: (command) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('shortcut:command', command);
    },
  });
  shortcuts.setEnabled(true);
  ipcMain.handle('shortcut:status', (event) => {
    if (!allowed(event)) throw new Error('not allowed');
    return shortcuts.status();
  });
  ipcMain.handle('shortcut:set-enabled', (event, on) => {
    if (!allowed(event)) throw new Error('not allowed');
    return shortcuts.setEnabled(on === true);
  });
  // A shortcut that needs the user's attention (start without an API key) brings the app forward.
  ipcMain.handle('shortcut:focus-app', (event) => {
    if (!allowed(event)) throw new Error('not allowed');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    if (process.platform === 'darwin') app.focus({ steal: true });
    mainWindow.focus();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 420,
    title: 'Twinscript',
    // Primer bgColor-default of the light / dark theme, so the window does not flash before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(ROOT, 'app', 'preload.js'),
    },
  });
  const contents = mainWindow.webContents;
  // A reload or a crashed page no longer listens to the capture it started.
  contents.on('did-navigate', stopSystemAudio);
  contents.on('render-process-gone', stopSystemAudio);
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
    stopSystemAudio();
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
  if (process.platform === 'darwin') handleSystemAudio();
  handleSecrets();
  handleCaptionOverlay();
  handleShortcuts();
  createMainWindow();
  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
