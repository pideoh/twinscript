import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPlatform, ownAudioRestricted, watchSystemAudio } from '../../../../src/speech/audio.js';

const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME.replace('Safari', 'Electron/38.0.0 Safari')}`;
const WINDOWS_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME.replace('Safari', 'Electron/38.0.0 Safari')}`;
const WINDOWS_BROWSER = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`;
const MAC_BROWSER = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`;

test('the desktop app and its platform are told from the user agent', () => {
  assert.deepEqual(appPlatform(MAC_APP), { desktop: true, platform: 'mac' });
  assert.deepEqual(appPlatform(WINDOWS_APP), { desktop: true, platform: 'windows' });
  assert.deepEqual(appPlatform(WINDOWS_BROWSER), { desktop: false, platform: 'windows' });
  assert.deepEqual(appPlatform(MAC_BROWSER), { desktop: false, platform: 'mac' });
  assert.deepEqual(appPlatform('Mozilla/5.0 (X11; Linux x86_64)'), { desktop: false, platform: 'other' });
});

test('PC audio leaves out the app’s own sound in the macOS desktop app, not on Windows or in a browser', () => {
  assert.equal(ownAudioRestricted(appPlatform(MAC_APP)), true);
  assert.equal(ownAudioRestricted(appPlatform(WINDOWS_APP)), false);
  assert.equal(ownAudioRestricted(appPlatform(WINDOWS_BROWSER)), false);
  assert.equal(ownAudioRestricted(appPlatform(MAC_BROWSER)), false);
});

test('PC audio that delivers nothing is reported once after the wait; any sound ends the watch', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  const now = () => clock;
  const tick = (ms) => {
    for (let i = 0; i < ms / 1000; i++) {
      clock += 1000;
      t.mock.timers.tick(1000);
    }
  };
  let level = 0;
  let told = 0;
  watchSystemAudio({ systemLevel: () => level }, () => told++, { ms: 8000, now });
  tick(7000);
  assert.equal(told, 0, 'not before the wait');
  tick(1000);
  assert.equal(told, 1);
  tick(5000);
  assert.equal(told, 1, 'only once');

  clock = 0;
  watchSystemAudio({ systemLevel: () => level }, () => told++, { ms: 8000, now });
  tick(2000);
  level = 0.1;
  tick(1000);
  level = 0;
  tick(10_000);
  assert.equal(told, 1, 'a sound ends the watch');
});
