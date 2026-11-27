// Pure rules for the desktop app's main process: which files are served, which URLs stay in the
// app, which windows may open and which permissions are granted. No Electron imports, so this can
// be unit-tested with node:test.

export const SCHEME = 'app';
export const HOST = 'rt';
export const ORIGIN = `${SCHEME}://${HOST}`;
export const START_URL = `${ORIGIN}/`;
export const CAPTION_WINDOW = 'captions';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// The same files the web app is made of; everything else (app/, test/, package.json, ...) is 404. Of
// node_modules, only the one file of the runtime dependency that the page imports
// (src/session/audio-reader.js).
const ALLOWED = [
  /^index\.html$/,
  /^styles\.css$/,
  /^icons\/[\w-][\w.-]*\.(svg|png)$/,
  /^src\/[\w-][\w.-]*\.js$/,
  /^src\/(speech|translation|session|storage|usage|ui|debug)\/[\w-][\w.-]*\.js$/,
  /^src\/ui\/locales\/[\w-][\w.-]*\.js$/,
  /^node_modules\/mediabunny\/dist\/bundles\/mediabunny\.mjs$/,
];

// Maps a request URL on the app's own origin to a file relative to the app root.
// Returns { path, type } or null when the request must be answered with 404.
export function resolveAppFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return null;
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, '') || 'index.html';
  if (path.includes('..') || path.includes('\\') || path.includes('\0')) return null;
  if (!ALLOWED.some((re) => re.test(path))) return null;
  return { path, type: TYPES[path.slice(path.lastIndexOf('.'))] };
}

export function isAppUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
}

export function isExternalUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// What to do with window.open / target=_blank: 'captions' opens the caption overlay, 'external'
// hands the link to the system browser, 'deny' blocks it.
export function windowOpenAction({ url, frameName }) {
  if (frameName === CAPTION_WINDOW && (url === '' || url === 'about:blank')) return 'captions';
  if (isExternalUrl(url)) return 'external';
  return 'deny';
}

// Only the app's own page in the main window's top frame may use the IPC handlers.
export function isAppCaller({ url, isMainFrame, isMainWindow }) {
  return !!isMainWindow && !!isMainFrame && isAppUrl(url ?? '');
}

// What stands in for the video when getDisplayMedia ("PC音声") is answered without a picker; the
// audio is always the system loopback. 'frame': the requesting page itself (macOS, where only
// the "System Audio Recording" permission is then needed). 'screen': the primary screen.
export function displayMediaVideo(platform) {
  return platform === 'darwin' ? 'frame' : 'screen';
}

// 'display-capture' is asked before session.setDisplayMediaRequestHandler runs (checked on
// Electron 45); denying it makes getDisplayMedia fail, so "PC音声" needs it.
const GRANTED = new Set(['media', 'display-capture', 'screen-wake-lock']);

// Microphone, screen/system audio capture and keeping the screen on, for the app's own pages only.
export function allowPermission(permission, origin) {
  if (!GRANTED.has(permission)) return false;
  return isAppUrl(origin);
}
