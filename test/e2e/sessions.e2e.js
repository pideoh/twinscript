// Browser tests: saved sessions, export, recording and persistence.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { download, mockGemini, reload, rows, saved, sessionNames, setup, translated } from './helpers.js';

const { openApp } = setup();

test('sessions survive a reload, can be switched, renamed and deleted', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const gemini = await mockGemini(page, [[3, 'final', 'First meeting notes.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.']);

  await reload(page);
  await page.waitForSelector('#sessionList .session'); // the saved session is restored asynchronously
  assert.deepEqual(await rows(page), [{ live: false, src: 'First meeting notes.', tgt: '訳:First meeting notes.' }]);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.']);
  assert.match(await page.textContent('.seg .time'), /^\d\d:\d\d:\d\d$/);

  await page.click('#newSession');
  assert.deepEqual(await rows(page), []);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.'], 'an untouched session is not saved');
  gemini.restart();
  await page.unroute(/streamGenerateContent/);
  await mockGemini(page, [[3, 'final', 'Second meeting.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  assert.deepEqual(await sessionNames(page), ['Second meeting.', 'First meeting notes.']);

  await page.locator('#sessionList .open').nth(1).click();
  assert.equal((await rows(page))[0].src, 'First meeting notes.');
  assert.ok(
    await page
      .locator('#sessionList .session')
      .nth(1)
      .evaluate((n) => n.classList.contains('current')),
  );

  await page.locator('#sessionList .session').nth(1).locator('.act').first().click();
  await page.fill('#sessionList .renaming input', '週次定例');
  await page.keyboard.press('Enter');
  await saved(page);
  page.once('dialog', (d) => d.accept());
  await page.locator('#sessionList .session').first().locator('.act').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 1);
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(await sessionNames(page), ['週次定例']);
  assert.equal((await rows(page))[0].src, 'First meeting notes.');
  assert.deepEqual(errors, []);
  await close();
});

test('the transcript downloads with a timeline in the chosen format', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key' });
  await mockGemini(page, [[3, 'final', 'こんにちは、皆さん。']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await page.click('#export');

  const grab = async () => {
    const file = await download(page, () => page.click('#exportTranscript'));
    const stream = await file.createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk;
    return { name: file.suggestedFilename(), text };
  };
  const txt = await grab();
  assert.equal(txt.name, 'こんにちは、皆さん。.txt');
  assert.match(txt.text, /言語: 日本語 ⇄ 英語/);
  assert.match(txt.text, /\[00:00:0\d\] こんにちは、皆さん。\n {11}→ 訳:こんにちは、皆さん。/);

  await page.selectOption('#exportFormat', 'csv');
  await page.selectOption('#exportContent', 'tgt');
  const csv = await grab();
  assert.ok(csv.name.endsWith('.csv'));
  assert.match(csv.text, /time,translation\r\n00:00:0\d,"訳:こんにちは、皆さん。"/);
  await close();
});

test('the audio is recorded, kept across a reload and can be downloaded', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockGemini(page, [[3, 'final', 'Recorded sentence.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.waitForTimeout(1200);
  await page.click('#toggle');
  await saved(page);
  await reload(page);

  await page.click('#export');
  assert.match(await page.textContent('#recordings .rec span'), /^録音 1 ・ .* ・ 00:00:0\d$/);
  const file = await download(page, () => page.click('#recordings .rec button'));
  assert.match(file.suggestedFilename(), /^Recorded sentence\.-1\.(webm|m4a)$/);
  let bytes = 0;
  for await (const chunk of await file.createReadStream()) bytes += chunk.length;
  assert.ok(bytes > 1000, `recording should contain audio, got ${bytes} bytes`);
  assert.deepEqual(errors, []);
  await close();
});

test('recording can be turned off', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', record: false });
  await mockGemini(page, [[3, 'final', 'Not recorded.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await page.click('#export');
  assert.equal(await page.locator('#recordings .rec').count(), 0);
  await close();
});

test('a saved session still shows the language code of each line after a reload', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg:not(.live) .tgt[data-lang="JA"]').length > 0);
  await page.click('#toggle');
  await saved(page);
  const codes = () =>
    page
      .locator('#log .seg')
      .evaluateAll((ss) =>
        ss.slice(0, 3).map((s) => [s.querySelector('.src').dataset.lang, s.querySelector('.tgt').dataset.lang]),
      );
  const before = await codes();
  assert.deepEqual(before, [
    ['JA', 'EN'],
    ['JA', 'EN'],
    ['EN', 'JA'],
  ]);
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length >= 3);
  assert.deepEqual(await codes(), before);
  assert.deepEqual(errors, []);
  await close();
});

test('a start pressed while the session on screen is being deleted records into a new session', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const gemini = await mockGemini(page, [[3, 'final', 'First meeting notes.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  gemini.restart();
  await page.unroute(/streamGenerateContent/);
  await mockGemini(page, [[3, 'final', 'Second meeting.']]);

  // Start is pressed right after the delete is confirmed, while the store is still deleting.
  await page.evaluate(() => {
    window.confirm = () => {
      queueMicrotask(() => document.getElementById('toggle').click());
      return true;
    };
  });
  await page.locator('#sessionList .session').first().locator('.act').last().click();
  await translated(page, 1);
  assert.equal((await rows(page))[0].src, 'Second meeting.');
  await page.click('#toggle');
  await saved(page);
  assert.deepEqual(await sessionNames(page), ['Second meeting.']);

  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(await sessionNames(page), ['Second meeting.']);
  assert.equal((await rows(page))[0].src, 'Second meeting.');
  assert.deepEqual(errors, []);
  await close();
});
