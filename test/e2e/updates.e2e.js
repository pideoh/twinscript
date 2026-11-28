// Browser tests: the desktop app's notice of a newer version and its setting, with the desktop
// bridge (window.appUpdates) stood in for. GitHub is never asked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listening, mockGemini, reload, setup, updateCalls, updatesBridge } from './helpers.js';

const { openApp } = setup();

const notice = (page) => page.locator('#updateNotice');
const ageLastCheck = (page) =>
  page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('rt-update'));
    localStorage.setItem('rt-update', JSON.stringify({ ...state, checkedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  });

test('a newer version is announced without taking the focus, and its button opens that release', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ current: '0.13.0', latest: '0.14.0' }));
  await notice(page).waitFor();
  assert.equal(await page.textContent('#updateText'), 'バージョン 0.14.0 が利用できます');
  assert.equal(await page.getAttribute('#updateDismiss', 'aria-label'), '閉じる');
  assert.equal(
    await page.evaluate(() => document.getElementById('updateNotice').contains(document.activeElement)),
    false,
  );
  assert.equal((await updateCalls(page)).check, 1);

  await page.click('#updateOpen');
  await page.waitForFunction(() => window.__updates.opened.length === 1);
  assert.deepEqual((await updateCalls(page)).opened, ['0.14.0']);

  // The next start shows it again from the last answer, without asking (it is not a day old).
  await reload(page);
  await notice(page).waitFor();
  assert.equal((await updateCalls(page)).check, 0);
  assert.deepEqual(errors, []);
  await close();
});

test('nothing is announced when the running version is the latest', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ current: '0.14.0', latest: '0.14.0' }));
  assert.equal((await updateCalls(page)).check, 1);
  assert.ok(await notice(page).isHidden());
  assert.deepEqual(errors, []);
  await close();
});

test('a dismissed version is not announced again; a later one is', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ current: '0.13.0', latest: '0.14.0' }));
  await notice(page).waitFor();
  await page.click('#updateDismiss');
  assert.ok(await notice(page).isHidden());

  await reload(page);
  await updateCalls(page);
  assert.ok(await notice(page).isHidden(), 'not after a restart');
  await ageLastCheck(page);
  await reload(page);
  await page.waitForFunction(() => window.__updates.check === 1);
  await updateCalls(page);
  assert.ok(await notice(page).isHidden(), 'not when a day later it is still the latest');

  await page.evaluate(() => sessionStorage.setItem('e2e-latest', '0.15.0'));
  await ageLastCheck(page);
  await reload(page);
  await notice(page).waitFor();
  assert.equal(await page.textContent('#updateText'), 'バージョン 0.15.0 が利用できます');
  assert.deepEqual(errors, []);
  await close();
});

test('with "Check for new versions" off nothing is asked; turning it on asks', async () => {
  const { page, errors, close } = await openApp('', { checkUpdates: false }, updatesBridge());
  assert.equal((await updateCalls(page)).check, 0);
  assert.ok(await notice(page).isHidden());

  await page.click('#openSettings');
  assert.ok(await page.locator('#updatesGroup').isVisible());
  assert.equal(await page.isChecked('#checkUpdates'), false);
  await page.check('#checkUpdates');
  await page.click('#settings button[value=ok]');
  await notice(page).waitFor();
  assert.equal((await updateCalls(page)).check, 1);

  // Off again: the notice goes, and no later start asks.
  await page.click('#openSettings');
  await page.uncheck('#checkUpdates');
  await page.click('#settings button[value=ok]');
  await notice(page).waitFor({ state: 'hidden' });
  await ageLastCheck(page);
  await reload(page);
  assert.equal((await updateCalls(page)).check, 0);
  assert.ok(await notice(page).isHidden());
  assert.deepEqual(errors, []);
  await close();
});

for (const fail of ['null', 'throw']) {
  test(`a failed check (${fail === 'null' ? 'no answer' : 'an error'}) shows nothing and is tried again at the next start`, async () => {
    const { page, errors, close } = await openApp('', {}, updatesBridge({ fail }));
    assert.equal((await updateCalls(page)).check, 1);
    assert.ok(await notice(page).isHidden());
    assert.ok(await page.locator('#toast').isHidden(), 'no error shown');
    await reload(page);
    assert.equal((await updateCalls(page)).check, 1);
    assert.deepEqual(errors, []);
    await close();
  });
}

test('the notice stays out of the way while listening', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', interimTranslate: false },
    updatesBridge({ current: '0.13.0', latest: '0.14.0' }),
  );
  await notice(page).waitFor();
  await mockGemini(page, [[3, 'final', 'One is done.']]);
  await page.click('#toggle');
  await listening(page);
  assert.ok(await notice(page).isVisible());
  const [box, log] = await Promise.all([notice(page).boundingBox(), page.locator('.log-wrap').boundingBox()]);
  assert.ok(box.y + box.height <= log.y, 'above the transcript, not over it');
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

// ---------- the version in the settings, and "Check now" ----------
const status = (page) => page.locator('#checkNowStatus');
const checkNow = async (page, result) => {
  await page.click('#checkNow');
  await page.waitForFunction((r) => document.getElementById('checkNowStatus').dataset.result === r, result);
};
const storedUpdate = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rt-update')));

test('the settings show the running version; Check now says when it is the latest', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ current: '0.14.0', latest: '0.14.0' }));
  assert.equal((await updateCalls(page)).check, 1);
  await page.click('#openSettings');
  assert.equal(await page.textContent('#appVersion'), 'バージョン 0.14.0');
  assert.notEqual(await page.$eval('#appVersion', (el) => getComputedStyle(el).userSelect), 'none', 'can be copied');
  assert.equal(await page.textContent('#checkNow'), '今すぐ確認');
  assert.equal(await status(page).getAttribute('role'), 'status');
  assert.equal(await status(page).textContent(), '');

  await checkNow(page, 'current');
  assert.equal(await status(page).textContent(), '最新のバージョンです。');
  assert.ok(await page.locator('#checkNowOpen').isHidden());
  assert.equal(await page.getAttribute('#checkNow', 'aria-disabled'), 'false');
  assert.equal((await updateCalls(page)).check, 2);
  assert.ok(await notice(page).isHidden());

  // Opened again: what it found belonged to that moment; the version stays.
  await page.click('#settings button[value=ok]');
  await page.click('#openSettings');
  assert.equal(await status(page).textContent(), '');
  assert.equal(await page.textContent('#appVersion'), 'バージョン 0.14.0');
  assert.deepEqual(errors, []);
  await close();
});

test('Check now with checking off finds a newer version, shows the notice even if it was dismissed, and opens its release', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ current: '0.13.0', latest: '0.14.0' }));
  await notice(page).waitFor();
  await page.click('#updateDismiss');
  await page.click('#openSettings');
  await page.uncheck('#checkUpdates');
  await page.click('#settings button[value=ok]');
  await reload(page);
  assert.equal((await updateCalls(page)).check, 0);
  assert.ok(await notice(page).isHidden());

  await page.click('#openSettings');
  await checkNow(page, 'newer');
  assert.equal(await status(page).textContent(), 'バージョン 0.14.0 が利用できます。');
  assert.equal((await updateCalls(page)).check, 1, 'exactly one request');
  assert.ok(await notice(page).isVisible(), 'the notice appears as well');
  assert.equal(await page.textContent('#updateText'), 'バージョン 0.14.0 が利用できます');
  assert.equal((await storedUpdate(page)).dismissed, null);

  await page.click('#checkNowOpen');
  await page.waitForFunction(() => window.__updates.opened.length === 1);
  assert.deepEqual((await updateCalls(page)).opened, ['0.14.0']);

  // Saving the settings (still off) keeps the notice the user asked for.
  await page.click('#settings button[value=ok]');
  assert.ok(await notice(page).isVisible());
  assert.equal((await updateCalls(page)).check, 1);
  assert.deepEqual(errors, []);
  await close();
});

test('after Check now the daily check does not ask again', async () => {
  const { page, errors, close } = await openApp(
    '',
    {},
    updatesBridge({ current: '0.14.0', latest: '0.14.0', fail: 'null' }),
  );
  assert.equal((await updateCalls(page)).check, 1);
  assert.equal((await storedUpdate(page)).checkedAt, 0, 'the check at start failed');
  await page.evaluate(() => sessionStorage.setItem('e2e-fail', ''));

  await page.click('#openSettings');
  await checkNow(page, 'current');
  assert.ok((await storedUpdate(page)).checkedAt > 0, "counts as the day's check");
  await page.click('#settings button[value=ok]'); // closing looks whether a check is due
  assert.equal((await updateCalls(page)).check, 2);
  await reload(page);
  assert.equal((await updateCalls(page)).check, 0, 'nor at the next start');
  assert.deepEqual(errors, []);
  await close();
});

test('Check now that fails says so beside the button, with no error shown elsewhere', async () => {
  const { page, errors, close } = await openApp('', {}, updatesBridge({ fail: 'null' }));
  assert.equal((await updateCalls(page)).check, 1);
  await page.click('#openSettings');
  await checkNow(page, 'failed');
  assert.equal(await status(page).textContent(), '確認できませんでした。しばらくしてからもう一度お試しください。');
  assert.ok(await page.locator('#checkNowOpen').isHidden());
  assert.ok(await page.locator('#toast').isHidden());
  assert.ok(await notice(page).isHidden());
  assert.equal((await updateCalls(page)).check, 2);
  assert.equal((await storedUpdate(page)).checkedAt, 0, "a failure is not counted as the day's check");
  assert.deepEqual(errors, []);
  await close();
});

test('while Check now is asking the button waits, keeps the focus, and a second press asks nothing', async () => {
  const { page, errors, close } = await openApp('', { checkUpdates: false }, updatesBridge());
  assert.equal((await updateCalls(page)).check, 0);
  await page.evaluate(() => sessionStorage.setItem('e2e-hold', '1'));
  await page.click('#openSettings');
  await page.click('#checkNow');
  await page.waitForFunction(() => document.getElementById('checkNowStatus').dataset.result === 'checking');
  assert.equal(await status(page).textContent(), '確認しています…');
  assert.equal(await page.getAttribute('#checkNow', 'aria-disabled'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'checkNow');
  await page.click('#checkNow', { force: true }); // aria-disabled: Playwright would wait for it otherwise
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__releaseUpdateCheck());
  await page.waitForFunction(() => document.getElementById('checkNowStatus').dataset.result === 'newer');
  assert.equal((await updateCalls(page)).check, 1);
  assert.equal(await page.getAttribute('#checkNow', 'aria-disabled'), 'false');
  assert.deepEqual(errors, []);
  await close();
});

test('in a browser there is no update setting and no notice', async () => {
  const { page, errors, close } = await openApp('');
  await page.click('#openSettings');
  assert.ok(await page.locator('#updatesGroup').isHidden());
  await page.click('#settings button[value=ok]');
  assert.ok(await notice(page).isHidden());
  assert.equal(await page.evaluate(() => localStorage.getItem('rt-update')), null);
  assert.deepEqual(errors, []);
  await close();
});
