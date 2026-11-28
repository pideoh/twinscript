// Browser tests: the demo (?mock=1) shows the same screen as the app. Importing an audio file, speaker
// labels and rebuilding a transcript are offered under the same rules; the demo has no engine for
// them, so pressing one says it needs the real service and starts nothing. A recording made outside
// the demo is in the same storage, so a finished, recorded session can be on screen in the demo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockSpeakers, seedRecordedSession, setup, storedSessions } from './helpers.js';

const { openApp } = setup();

const NOT_IN_DEMO = 'この操作には Gemini API が必要なため、デモでは行いません';

// Everything the page could start: requests to Gemini, file pickers and confirm() dialogs.
function watch(page) {
  const seen = { requests: [], choosers: 0, dialogs: [] };
  page.on('request', (request) => {
    if (request.url().includes('generativelanguage.googleapis.com')) seen.requests.push(request.url());
  });
  page.on('filechooser', () => seen.choosers++);
  page.on('dialog', (dialog) => {
    seen.dialogs.push(dialog.message());
    dialog.dismiss();
  });
  return seen;
}
const toastShown = (page, text) =>
  page.waitForFunction((text) => document.getElementById('toast').textContent === text, text);

test('the demo shows the control to import an audio file; pressing it says it needs the real service and opens no file picker', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  const seen = watch(page);
  assert.ok(await page.isVisible('#importAudio'));
  assert.ok(await page.isEnabled('#importAudio'));
  await page.click('#importAudio');
  await toastShown(page, NOT_IN_DEMO);
  assert.equal(seen.choosers, 0, 'no file picker');
  assert.ok(await page.isHidden('#importDialog'), 'no dialog');
  assert.ok(await page.isHidden('#settings'), 'the settings are not opened for a key');
  assert.deepEqual(seen.requests, []);
  assert.deepEqual(errors, []);
  await close();
});

test('a recorded session in the demo offers speaker labels and rebuilding; pressing either says it needs the real service and changes nothing', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  const service = await mockSpeakers(page);
  const seen = watch(page);
  await seedRecordedSession(page);
  await page.waitForSelector('#labelSpeakers:not([hidden])');
  assert.ok(await page.isVisible('#speakerTools'));
  assert.ok(await page.isVisible('#rebuild'));
  assert.ok(await page.isVisible('#rebuildTools'));
  const before = await storedSessions(page);

  await page.click('#labelSpeakers');
  await toastShown(page, NOT_IN_DEMO);
  assert.equal(await page.getAttribute('#labelSpeakers', 'aria-busy'), 'false', 'nothing is being labelled');
  assert.ok(await page.isHidden('#cancelSpeakers'));
  await page.evaluate(() => {
    document.getElementById('toast').textContent = '';
  });

  await page.click('#rebuild');
  await toastShown(page, NOT_IN_DEMO);
  assert.ok(await page.isHidden('#rebuildDialog'), 'no confirmation');
  assert.equal(await page.getAttribute('#rebuild', 'aria-busy'), 'false', 'nothing is being rebuilt');
  assert.ok(await page.isHidden('#cancelRebuild'));

  assert.deepEqual(seen.dialogs, [], 'nothing asked');
  assert.ok(await page.isHidden('#settings'), 'the settings are not opened for a key');
  assert.deepEqual([service.uploads, service.analyses, service.deleted, service.punctuations], [[], [], [], []]);
  assert.deepEqual(seen.requests, []);
  assert.deepEqual(await storedSessions(page), before, 'the session is unchanged');
  assert.deepEqual(errors, []);
  await close();
});

test('the message is in the display language', async () => {
  for (const [uiLang, text] of [
    ['en', 'This needs the Gemini API and is not part of the demo'],
    ['zh-Hans', '此操作需要 Gemini API，演示中不执行'],
  ]) {
    const { page, errors, close } = await openApp('?mock=1', { uiLang });
    await page.click('#importAudio');
    await toastShown(page, text);
    assert.deepEqual(errors, []);
    await close();
  }
});
