// Puts stand-ins for browser globals (MediaRecorder, OfflineAudioContext, sampleRate, …) in place
// for one test and takes them away afterwards, so no global is left behind for another test file.

/** Runs fn with `values` set on globalThis; every global is restored (or deleted) when it ends. */
export async function withGlobals(values, fn) {
  const saved = new Map();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}
