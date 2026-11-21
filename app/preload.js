// Preload of the main window (macOS only). Exposes the native system-audio capture and nothing
// else; see startSystemAudio in main.js. Sandboxed preloads run as plain scripts, hence require().
const { contextBridge, ipcRenderer } = require('electron');

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
