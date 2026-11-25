// Rules of the desktop app's main process (app/policy.js), tested without Electron.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowPermission,
  displayMediaVideo,
  isAppCaller,
  isAppUrl,
  isExternalUrl,
  resolveAppFile,
  windowOpenAction,
} from '../../../app/policy.js';

test('serves the files the web app is made of, with their content types', () => {
  assert.deepEqual(resolveAppFile('app://rt/'), { path: 'index.html', type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveAppFile('app://rt/?mock=1'), { path: 'index.html', type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveAppFile('app://rt/index.html'), { path: 'index.html', type: 'text/html; charset=utf-8' });
  assert.deepEqual(resolveAppFile('app://rt/styles.css'), { path: 'styles.css', type: 'text/css; charset=utf-8' });
  assert.deepEqual(resolveAppFile('app://rt/src/app.js'), {
    path: 'src/app.js',
    type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(resolveAppFile('app://rt/src/speech/pcm-worklet.js'), {
    path: 'src/speech/pcm-worklet.js',
    type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(resolveAppFile('app://rt/src/ui/locales/zh-Hans.js'), {
    path: 'src/ui/locales/zh-Hans.js',
    type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(resolveAppFile('app://rt/icons/icon.svg'), { path: 'icons/icon.svg', type: 'image/svg+xml' });
  assert.deepEqual(resolveAppFile('app://rt/icons/icon-512.png#x'), { path: 'icons/icon-512.png', type: 'image/png' });
});

test('everything else is not served', () => {
  for (const url of [
    'app://rt/package.json',
    'app://rt/app/main.js',
    'app://rt/test/segmenter.test.js',
    'app://rt/CLAUDE.md',
    'app://rt/.git/config',
    'app://rt/src/.hidden.js',
    'app://rt/src/sub/app.js',
    'app://rt/src/speech/sub/audio.js',
    'app://rt/src/speech/..%2F..%2Fpackage.json',
    'app://rt/src/speech/../../package.json',
    'app://rt/src/ui/locales/sub/ja.js',
    'app://rt/src/ui/locales/sub/en.js',
    'app://rt/src/ui/locales/.hidden.js',
    'app://rt/src/ui/locales/en.json',
    'app://rt/src/ui/locales/',
    'app://rt/src/ui/locales/..%2F..%2Fpackage.json',
    'app://rt/locales/en.js',
    'app://rt/src/app.ts',
    'app://rt/icons/icon.ico',
    'app://rt/src/..%2Fpackage.json',
    'app://rt/src%2F..%2F..%2Fsecret.js',
    'app://rt/src/%2e%2e/app/main.js',
    'app://rt/src/a%5C..%5Cb.js',
    'app://rt/src/%E0%A4%A.js',
    'app://other/index.html',
    'https://rt/index.html',
    'file:///etc/passwd',
    'not a url',
  ])
    assert.equal(resolveAppFile(url), null, url);
});

test('only app://rt/ counts as the app; only http(s) goes to the system browser', () => {
  assert.ok(isAppUrl('app://rt/'));
  assert.ok(isAppUrl('app://rt/index.html?mock=1'));
  assert.ok(isAppUrl('app://rt'));
  assert.ok(!isAppUrl('app://evil/'));
  assert.ok(!isAppUrl('https://rt/'));
  assert.ok(!isAppUrl(''));
  assert.ok(isExternalUrl('https://aistudio.google.com/apikey'));
  assert.ok(isExternalUrl('http://example.com/'));
  assert.ok(!isExternalUrl('file:///etc/passwd'));
  assert.ok(!isExternalUrl('javascript:alert(1)'));
  assert.ok(!isExternalUrl('app://rt/'));
});

test('window.open: the caption overlay opens, web links go out, the rest is denied', () => {
  assert.equal(windowOpenAction({ url: 'about:blank', frameName: 'captions' }), 'captions');
  assert.equal(windowOpenAction({ url: '', frameName: 'captions' }), 'captions');
  assert.equal(windowOpenAction({ url: 'https://evil.example/', frameName: 'captions' }), 'external');
  assert.equal(windowOpenAction({ url: 'https://aistudio.google.com/apikey', frameName: '_blank' }), 'external');
  assert.equal(windowOpenAction({ url: 'about:blank', frameName: '' }), 'deny');
  assert.equal(windowOpenAction({ url: 'app://rt/', frameName: '' }), 'deny');
  assert.equal(windowOpenAction({ url: 'file:///etc/passwd', frameName: 'captions' }), 'deny');
});

test('only the app page in the main window top frame may call the main process', () => {
  const ok = { url: 'app://rt/', isMainFrame: true, isMainWindow: true };
  assert.equal(isAppCaller(ok), true);
  assert.equal(isAppCaller({ ...ok, url: 'app://rt/?mock=1' }), true);
  assert.equal(isAppCaller({ ...ok, isMainFrame: false }), false, 'an iframe');
  assert.equal(isAppCaller({ ...ok, isMainWindow: false }), false, 'the caption overlay or another window');
  assert.equal(isAppCaller({ ...ok, url: 'https://example.com/' }), false);
  assert.equal(isAppCaller({ ...ok, url: 'about:blank' }), false);
  assert.equal(isAppCaller({ ...ok, url: 'app://other/' }), false);
  assert.equal(isAppCaller({ ...ok, url: undefined }), false);
});

test('PC audio on macOS is answered with the requesting page instead of a screen, elsewhere with the screen', () => {
  assert.equal(displayMediaVideo('darwin'), 'frame');
  assert.equal(displayMediaVideo('win32'), 'screen');
  assert.equal(displayMediaVideo('linux'), 'screen');
});

test('permissions: microphone, system audio capture and wake lock for the app only', () => {
  assert.ok(allowPermission('media', 'app://rt'));
  assert.ok(allowPermission('media', 'app://rt/'));
  assert.ok(allowPermission('display-capture', 'app://rt/'));
  assert.ok(allowPermission('screen-wake-lock', 'app://rt/index.html'));
  assert.ok(!allowPermission('media', 'https://example.com'));
  assert.ok(!allowPermission('display-capture', 'https://example.com'));
  assert.ok(!allowPermission('media', ''));
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'usb', 'fullscreen']) {
    assert.ok(!allowPermission(p, 'app://rt/'), p);
  }
});
