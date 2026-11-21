// Rules for the macOS system-audio helper (app/system-audio.js), tested without Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { helperPath, endReason, isSystemAudioCaller, createSampleFramer, EXIT_PERMISSION } from '../app/system-audio.js';

test('the helper is in Resources when packaged and in the build folder in development', () => {
  assert.equal(
    helperPath({ packaged: true, resourcesPath: '/Applications/Twinscript.app/Contents/Resources', appRoot: '/x' }),
    join('/Applications/Twinscript.app/Contents/Resources', 'system-audio'),
  );
  assert.equal(
    helperPath({ packaged: false, resourcesPath: '/electron/Resources', appRoot: '/src/twinscript' }),
    join('/src/twinscript', 'native', 'mac', 'build', 'system-audio'),
  );
});

test('only the permission exit code is reported as a permission problem', () => {
  assert.equal(EXIT_PERMISSION, 2);
  assert.equal(endReason(2), 'permission');
  for (const code of [0, 1, 3, 127, null]) assert.equal(endReason(code), 'error');
});

test('only the app page in the main window top frame may control the capture', () => {
  const ok = { url: 'app://rt/', isMainFrame: true, isMainWindow: true };
  assert.equal(isSystemAudioCaller(ok), true);
  assert.equal(isSystemAudioCaller({ ...ok, url: 'app://rt/?mock=1' }), true);
  assert.equal(isSystemAudioCaller({ ...ok, isMainFrame: false }), false, 'an iframe');
  assert.equal(isSystemAudioCaller({ ...ok, isMainWindow: false }), false, 'the caption overlay or another window');
  assert.equal(isSystemAudioCaller({ ...ok, url: 'https://example.com/' }), false);
  assert.equal(isSystemAudioCaller({ ...ok, url: 'about:blank' }), false);
  assert.equal(isSystemAudioCaller({ ...ok, url: 'app://other/' }), false);
  assert.equal(isSystemAudioCaller({ ...ok, url: undefined }), false);
});

test('output is passed on in whole 4-byte samples, keeping a partial one for the next read', () => {
  const frame = createSampleFramer();
  const bytes = Buffer.from(new Float32Array([0.25, -0.5, 1]).buffer);
  assert.equal(frame(bytes.subarray(0, 3)), null);
  const first = frame(bytes.subarray(3, 9));
  assert.equal(first.length, 8);
  const last = frame(bytes.subarray(9));
  assert.equal(last.length, 4);
  const all = Buffer.concat([first, last]);
  assert.deepEqual([...new Float32Array(all.buffer, all.byteOffset, 3)], [0.25, -0.5, 1]);
  assert.equal(frame(Buffer.alloc(8)).length, 8, 'aligned reads pass straight through');
});
