// Smoke test of the desktop app (Electron). Opens real windows, so it needs a display; it is not
// part of CI. Run with `npm run test:app`.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let app, profile;

before(async () => {
  profile = await mkdtemp(join(tmpdir(), 'rt-app-'));
  // RT_NO_UPDATE_CHECK: the app does not ask GitHub for a newer version during the test.
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, RT_USER_DATA: profile, RT_NO_UPDATE_CHECK: '1' },
  });
});
after(async () => {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
});

test('serves only the app files from app://rt/', async () => {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  assert.equal(page.url(), 'app://rt/');
  // Asked from the main process: the page's content security policy does not let it fetch.
  const status = (path) => app.evaluate(({ net }, p) => net.fetch(`app://rt/${p}`).then((r) => r.status), path);
  assert.equal(await status('src/app.js'), 200);
  assert.equal(await status('src/locales/ja.js'), 200);
  assert.equal(await status('package.json'), 404);
  assert.equal(await status('app/main.js'), 404);
});

test('the preload gives the page the secret store, caption overlay click-through, global shortcuts and the update check, nothing else', async () => {
  const page = await app.firstWindow();
  const surface = await page.evaluate(() => {
    const keys = (o) => (o ? Object.keys(o).sort() : null);
    return {
      secretStore: keys(window.secretStore),
      captionOverlay: keys(window.captionOverlay),
      appShortcuts: keys(window.appShortcuts),
      appUpdates: keys(window.appUpdates),
      // What the context bridge exposes arrives as frozen plain objects on window; anything
      // added later would show up here.
      bridged: Object.getOwnPropertyNames(window)
        .filter((name) => {
          const value = window[name];
          return value?.constructor === Object && Object.isFrozen(value);
        })
        .sort(),
    };
  });
  assert.deepEqual(surface.secretStore, ['get', 'set']);
  assert.deepEqual(surface.captionOverlay, ['setClickThrough']);
  assert.deepEqual(surface.appShortcuts, ['focusApp', 'onCommand', 'setEnabled', 'status']);
  assert.deepEqual(surface.appUpdates, ['check', 'openReleasePage', 'version']);
  assert.deepEqual(surface.bridged, ['appShortcuts', 'appUpdates', 'captionOverlay', 'secretStore']);
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.electron), 'undefined');
});

test('the page learns the running version; the update check is answered by the main process', async () => {
  const page = await app.firstWindow();
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(await page.evaluate(() => window.appUpdates.version()), version);
  // RT_NO_UPDATE_CHECK answers as a failed check would, without a request to GitHub.
  assert.equal(await page.evaluate(() => window.appUpdates.check()), null);
  // Not a version: nothing is opened, nothing fails.
  assert.equal(await page.evaluate(() => window.appUpdates.openReleasePage('https://example.com')), undefined);
  assert.ok(await page.locator('#updateNotice').isHidden());
});

test('the API key is stored encrypted on disk, never in plain text, and reads back', async () => {
  const page = await app.firstWindow();
  const key = 'AIza-desktop-test-key';
  const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
  // Keychain (macOS) and DPAPI (Windows) are always there; elsewhere the fallback is checked.
  if (['darwin', 'win32'].includes(process.platform)) assert.equal(available, true);
  const result = await page.evaluate((k) => window.secretStore.set('apiKey', k), key);
  assert.deepEqual(result, { persisted: available });
  assert.deepEqual(await page.evaluate(() => window.secretStore.get('apiKey')), {
    value: available ? key : '',
    available,
  });
  if (available) {
    const raw = await readFile(join(profile, 'secrets.json'), 'utf8');
    assert.ok(!raw.includes(key), 'not in plain text');
    assert.ok(!Buffer.from(JSON.parse(raw).apiKey, 'base64').toString('latin1').includes(key), 'not merely base64');
    if (process.platform !== 'win32') assert.equal((await stat(join(profile, 'secrets.json'))).mode & 0o777, 0o600);
  } else {
    await assert.rejects(readFile(join(profile, 'secrets.json')), { code: 'ENOENT' });
  }
  await assert.rejects(
    page.evaluate(() => window.secretStore.get('other')),
    /unknown secret/,
  );
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes(key));
  assert.deepEqual(await page.evaluate(() => window.secretStore.set('apiKey', '')), { persisted: available });
});

test('runs the demo and moves the captions into an overlay window and back', async () => {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => localStorage.setItem('rt-settings', JSON.stringify({ uiLang: 'ja' }))); // assertions read Japanese
  await page.goto('app://rt/?mock=1');
  assert.ok(await page.locator('#pip').isVisible(), 'the caption window button is shown in the app');

  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live)').length >= 2);

  const [overlay] = await Promise.all([app.waitForEvent('window'), page.click('#pip')]);
  await overlay.locator('#now').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#now').count(), 0, 'the zone left the main window');
  assert.ok(await overlay.locator('body').evaluate((b) => b.classList.contains('overlay')));
  await overlay.waitForFunction(() => document.querySelectorAll('#nowList .seg').length > 0);
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'true');
  const onTop = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isAlwaysOnTop()));
  assert.deepEqual(onTop.sort(), [false, true], 'only the overlay floats on top');
  if (process.platform === 'darwin') {
    // Showing the overlay on every desktop must not turn the app into one without a Dock icon.
    await page.waitForTimeout(500); // the Dock state changes after the window call returns
    assert.equal(await app.evaluate(({ app }) => app.dock.isVisible()), true, 'the Dock icon stays');
  }

  await Promise.all([overlay.waitForEvent('close'), overlay.click('.overlay-close')]);
  await page.locator('#now').waitFor({ state: 'attached' });
  assert.ok(
    await page.locator('#now').evaluate((n) => n.previousElementSibling.classList.contains('log-wrap')),
    'back under the transcript',
  );
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'false');
  assert.equal(await page.locator('.overlay-close').count(), 0);

  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
});

// What a global shortcut does, sent the way the main process sends it when the key is pressed
// (real key presses from the operating system are not synthesized here).
const sendShortcut = (command) =>
  app.evaluate(({ BrowserWindow }, c) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.isAlwaysOnTop());
    main.webContents.send('shortcut:command', c);
  }, command);

test('global shortcuts are registered and can be turned off and on from the page', async () => {
  const page = await app.firstWindow();
  const status = await page.evaluate(() => window.appShortcuts.status());
  assert.equal(status.enabled, true);
  assert.deepEqual(
    status.shortcuts.map((s) => [s.command, s.accelerator]),
    [
      ['toggle', 'CommandOrControl+Shift+T'],
      ['captions', 'CommandOrControl+Shift+C'],
    ],
  );
  // Another app may hold a key; registered says which, and nothing fails.
  for (const s of status.shortcuts) assert.equal(typeof s.registered, 'boolean');
  const held = await app.evaluate(({ globalShortcut }) =>
    ['CommandOrControl+Shift+T', 'CommandOrControl+Shift+C'].map((a) => globalShortcut.isRegistered(a)),
  );
  assert.deepEqual(
    held,
    status.shortcuts.map((s) => s.registered),
  );

  const off = await page.evaluate(() => window.appShortcuts.setEnabled(false));
  assert.equal(off.enabled, false);
  assert.deepEqual(
    await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+T')),
    false,
  );
  const on = await page.evaluate(() => window.appShortcuts.setEnabled(true));
  assert.equal(on.enabled, true);
  assert.deepEqual(
    on.shortcuts.map((s) => s.registered),
    held,
  );
});

test('the shortcuts start and stop translating and show and hide the caption window; options reach the overlay', async () => {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() =>
    localStorage.setItem('rt-settings', JSON.stringify({ uiLang: 'ja', captionOpacity: 40, clickThrough: true })),
  );
  await page.goto('app://rt/?mock=1');
  await page.waitForFunction(() => typeof document.getElementById('toggle')?.onclick === 'function');

  await sendShortcut('toggle');
  await page.waitForFunction(() => document.body.classList.contains('running'));

  const [overlay] = await Promise.all([app.waitForEvent('window'), sendShortcut('captions')]);
  await overlay.locator('#now').waitFor({ state: 'attached' });
  assert.equal(
    await overlay.evaluate(() => document.body.style.getPropertyValue('--caption-bg-alpha')),
    '0.4',
    'the saved opacity applies to the overlay',
  );
  // Click-through is applied by the main process; changing it while the overlay is open is fine.
  await page.evaluate(() => window.captionOverlay.setClickThrough(false));
  await page.evaluate(() => window.captionOverlay.setClickThrough(true));

  await Promise.all([overlay.waitForEvent('close'), sendShortcut('captions')]);
  await page.locator('#now').waitFor({ state: 'attached' });
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'false');

  await sendShortcut('toggle');
  await page.waitForFunction(() => !document.body.classList.contains('running'));
  await page.evaluate(() => window.captionOverlay.setClickThrough(false));
  assert.deepEqual(errors, []);
});

test('starting from the shortcut without an API key asks for the key, as the button does', async () => {
  const page = await app.firstWindow();
  await page.evaluate(() => localStorage.setItem('rt-settings', JSON.stringify({ uiLang: 'ja' })));
  await page.goto('app://rt/');
  await page.waitForFunction(() => typeof document.getElementById('toggle')?.onclick === 'function');
  await sendShortcut('toggle');
  await page.waitForFunction(() => document.getElementById('settings').open);
  assert.ok(await page.locator('#toast').isVisible());
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('running'))));
  assert.ok(await page.locator('#shortcutsGroup').isVisible(), 'the dialog lists the shortcuts');
  assert.equal(await page.locator('#shortcutList kbd').count(), 2);
  assert.ok(await page.locator('#captionOpacity').isVisible());
  assert.ok(await page.locator('#clickThrough').isVisible());
  assert.ok(await page.locator('#captionDesktopOnly').isHidden());
  assert.ok(await page.locator('#checkUpdates').isChecked(), 'checking for new versions is on by default');
  await page.keyboard.press('Escape');
});
