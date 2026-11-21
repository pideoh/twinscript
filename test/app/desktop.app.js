// Smoke test of the desktop app (Electron). Opens real windows, so it needs a display; it is not
// part of CI. Run with `npm run test:app`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let app, profile;

before(async () => {
  profile = await mkdtemp(join(tmpdir(), 'rt-app-'));
  app = await electron.launch({ args: [ROOT], env: { ...process.env, RT_USER_DATA: profile } });
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

test('on macOS the page gets the native PC audio bridge and nothing else from the preload', async () => {
  const page = await app.firstWindow();
  const keys = await page.evaluate(() => (window.nativeSystemAudio ? Object.keys(window.nativeSystemAudio).sort() : null));
  if (process.platform === 'darwin') assert.deepEqual(keys, ['onData', 'onEnd', 'start', 'stop']);
  else assert.equal(keys, null);
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
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

  await Promise.all([overlay.waitForEvent('close'), overlay.click('.overlay-close')]);
  await page.locator('#now').waitFor({ state: 'attached' });
  assert.ok(await page.locator('#now').evaluate((n) => n.previousElementSibling.classList.contains('log-wrap')), 'back under the transcript');
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'false');
  assert.equal(await page.locator('.overlay-close').count(), 0);

  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
});
