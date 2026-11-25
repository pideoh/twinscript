// Preload of the main window. Exposes the secret store (the API key, encrypted by the main
// process; see app/secrets.js), click-through of the caption overlay, the global shortcuts
// (see app/shortcuts.js) and the check for a newer version (see app/updates.js). Nothing else.
// Sandboxed preloads run as plain scripts, hence require().
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

// version() -> the running version ('1.2.3'). check() asks GitHub (from the main process) and
// returns { current, latest, newer }, or null when that failed. openReleasePage(version) opens the
// release page of that version ('1.2.3') in the default browser; the main process builds the URL.
contextBridge.exposeInMainWorld('appUpdates', {
  version: () => ipcRenderer.invoke('update:version'),
  check: () => ipcRenderer.invoke('update:check'),
  openReleasePage: (version) => ipcRenderer.invoke('update:open-release', String(version)),
});
