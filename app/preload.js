// Preload of the main window. Exposes the secret store (the API key, encrypted by the main
// process; see app/secrets.js), click-through of the caption overlay and the global shortcuts
// (see app/shortcuts.js) on every platform and, on macOS, the native system-audio capture (see
// startSystemAudio in main.js). Nothing else. Sandboxed preloads run as plain scripts, hence
// require().
const { contextBridge, ipcRenderer } = require('electron');

// get(name) -> { value, available }; set(name, value) -> { persisted }. An empty value deletes.
contextBridge.exposeInMainWorld('secretStore', {
  get: (name) => ipcRenderer.invoke('secret:get', name),
  set: (name, value) => ipcRenderer.invoke('secret:set', name, value),
});

// Mouse events pass through the caption overlay to the app underneath while this is on.
contextBridge.exposeInMainWorld('captionOverlay', {
  setClickThrough: (on) => ipcRenderer.invoke('caption-overlay:click-through', on === true),
});

// onCommand(cb): cb('toggle' | 'captions') when a global shortcut is pressed.
// setEnabled(on) and status() -> { enabled, shortcuts: [{ command, accelerator, label, registered }] }.
// focusApp() brings the main window forward (a shortcut that needs the user, e.g. no API key yet).
let onCommand = null;
ipcRenderer.on('shortcut:command', (_event, command) => {
  if (command === 'toggle' || command === 'captions') onCommand?.(command);
});
contextBridge.exposeInMainWorld('appShortcuts', {
  onCommand: (cb) => {
    onCommand = typeof cb === 'function' ? cb : null;
  },
  setEnabled: (on) => ipcRenderer.invoke('shortcut:set-enabled', on === true),
  status: () => ipcRenderer.invoke('shortcut:status'),
  focusApp: () => ipcRenderer.invoke('shortcut:focus-app'),
});

if (process.platform === 'darwin') {
  let onData = null;
  let onEnd = null;
  // Each message is whole little-endian Float32 mono samples at 48 kHz; handed over as an
  // ArrayBuffer, which crosses the context bridge as a copy.
  ipcRenderer.on('system-audio:data', (_event, bytes) => {
    onData?.(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  });
  ipcRenderer.on('system-audio:end', (_event, reason) => onEnd?.(reason));

  contextBridge.exposeInMainWorld('nativeSystemAudio', {
    start: () => ipcRenderer.invoke('system-audio:start'),
    stop: () => ipcRenderer.invoke('system-audio:stop'),
    onData: (cb) => {
      onData = typeof cb === 'function' ? cb : null;
    },
    onEnd: (cb) => {
      onEnd = typeof cb === 'function' ? cb : null;
    },
  });
}
