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
