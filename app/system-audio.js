// Rules for the macOS system-audio helper (native/mac/system-audio.swift): where it is, who may
// start it, how its exit is reported and how its output is cut into whole samples. No Electron
// imports, so this can be unit-tested with node:test.
import { join } from 'node:path';
import { isAppUrl } from './policy.js';

export const HELPER_NAME = 'system-audio';

// Exit codes of the helper (see the header of system-audio.swift).
export const EXIT_PERMISSION = 2;

// Packaged: electron-builder copies it into Contents/Resources (mac.extraResources).
// Development: scripts/build-mac-helper.sh builds it into native/mac/build.
export function helperPath({ packaged, resourcesPath, appRoot }) {
  return packaged ? join(resourcesPath, HELPER_NAME) : join(appRoot, 'native', 'mac', 'build', HELPER_NAME);
}

// Why the helper stopped on its own, as told to the page: 'permission' when Screen Recording is
// not allowed, 'error' for everything else (including being killed by a signal).
export function endReason(code) {
  return code === EXIT_PERMISSION ? 'permission' : 'error';
}

// Only the app's own page in the main window's top frame may start or stop the capture.
export function isSystemAudioCaller({ url, isMainFrame, isMainWindow }) {
  return !!isMainWindow && !!isMainFrame && isAppUrl(url ?? '');
}

// The helper writes 4-byte Float32 samples, but a pipe read can end mid-sample. Returns a function
// that takes each chunk read and gives back the whole samples so far (or null), keeping the rest.
export function createSampleFramer(bytesPerSample = 4) {
  let rest = Buffer.alloc(0);
  return (chunk) => {
    const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = data.length - (data.length % bytesPerSample);
    rest = Buffer.from(data.subarray(whole));
    return whole ? data.subarray(0, whole) : null;
  };
}
