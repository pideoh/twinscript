// Browser tests: saved sessions, export, recording and persistence.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockGemini, mockSummary, reload, rows, saved, sessionNames, setup, translated } from './helpers.js';

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

  page.once('dialog', (d) => d.accept('週次定例'));
  await page.locator('#sessionList .session').nth(1).locator('.act').first().click();
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
    const [file] = await Promise.all([page.waitForEvent('download'), page.click('#exportTranscript')]);
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
  const [file] = await Promise.all([page.waitForEvent('download'), page.click('#recordings .rec button')]);
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

test('PC audio that delivers nothing is reported instead of failing silently', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false });
  await mockGemini(page, []);
  // Stand in for a screen share whose audio track exists but never carries a sample.
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  assert.ok(await page.locator('#toast').isHidden(), 'no warning right away');
  await page.waitForFunction(
    () => document.getElementById('toast').textContent.includes('PC音声が届いていません'),
    null,
    { timeout: 15_000 },
  );
  await page.click('#toggle');
  await close();
});

const summaryJson = (overview) =>
  JSON.stringify({
    overview,
    keyPoints: ['予算を確認した'],
    decisions: ['金曜日に公開する'],
    actionItems: [{ task: '報告書を送る', owner: '佐藤', due: '水曜日' }],
  });
const summaryText = (page) => page.textContent('#summaryContent');
async function finishedSession(page, text) {
  const gemini = await mockGemini(page, [[3, 'final', text]]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  return gemini;
}

test('a finished session can be summarized; the summary is kept, exported and marked outdated by new speech', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', record: false });
  assert.ok(await page.locator('#summary').isHidden(), 'nothing to summarize in an empty session');
  const gemini = await finishedSession(page, 'Budget review starts now.');
  assert.equal(await page.textContent('#summarize'), '要約する');

  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const requests = await mockSummary(page, async () => {
    await held;
    return { body: summaryJson('予算の確認を行った。') };
  });
  await page.click('#summarize');
  await page.waitForFunction(() => document.getElementById('summarize').getAttribute('aria-busy') === 'true');
  assert.equal(await page.textContent('#summaryStatus'), '要約しています…');
  assert.equal(await page.getAttribute('#summarize', 'aria-disabled'), 'true');
  release();
  await page.waitForFunction(() => document.getElementById('summaryContent').textContent.includes('予算の確認'));
  assert.equal(await page.textContent('#summarize'), '要約を更新');
  assert.equal(await page.textContent('#summaryStatus'), '');
  const text = await summaryText(page);
  for (const part of [
    '概要',
    '主なポイント',
    '予算を確認した',
    '決定事項',
    '金曜日に公開する',
    '報告書を送る',
    '担当: 佐藤',
    '期限: 水曜日',
  ])
    assert.ok(text.includes(part), `the panel shows ${part}`);
  assert.equal(requests.length, 1);
  assert.match(requests[0].systemInstruction.parts[0].text, /Write every text value in Japanese/);
  assert.match(
    requests[0].contents[0].parts[0].text,
    /Budget review starts now\.\n {2}=> 訳:Budget review starts now\./,
  );
  assert.equal(requests[0].generationConfig.responseMimeType, 'application/json');

  // Collapsing is remembered for the user.
  await page.click('#summaryToggle');
  assert.ok(await page.locator('#summaryBody').isHidden());
  await saved(page);
  await reload(page);
  await page.waitForSelector('#summary:not([hidden])');
  assert.ok(await page.locator('#summaryBody').isHidden(), 'still collapsed after a reload');
  await page.click('#summaryToggle');
  assert.ok((await summaryText(page)).includes('予算の確認を行った。'), 'the summary survives a reload');
  assert.ok(await page.locator('#summaryStale').isHidden());

  await page.click('#export');
  const [file] = await Promise.all([page.waitForEvent('download'), page.click('#exportTranscript')]);
  let exported = '';
  for await (const chunk of await file.createReadStream()) exported += chunk;
  assert.match(exported, /要約\n\n概要\n予算の確認を行った。\n/);
  assert.match(exported, /- 報告書を送る \(担当: 佐藤, 期限: 水曜日\)/);
  assert.match(exported, /文字起こし\n\n\[00:00:0\d\] Budget review starts now\./);
  await page.keyboard.press('Escape');

  // More speech: the panel steps aside while capturing, then the summary is marked outdated.
  gemini.restart();
  await page.unroute(/streamGenerateContent/);
  await mockGemini(page, [[3, 'final', 'One more thing.']]);
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('summary').hidden);
  await translated(page, 2);
  await page.click('#toggle');
  await page.waitForSelector('#summaryStale:not([hidden])');
  assert.equal(await page.textContent('#summaryStale'), '古い要約');
  assert.deepEqual(errors, []);
  await close();
});

test('a failed summary request leaves the previous summary in place and says why', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', record: false });
  await finishedSession(page, 'Short meeting.');
  const answers = [
    { body: summaryJson('最初の要約。') },
    { status: 500, body: JSON.stringify({ error: { message: 'Internal error' } }) },
    { status: 429, body: '{}' },
  ];
  await mockSummary(page, () => answers.shift());
  await page.click('#summarize');
  await page.waitForFunction(() => document.getElementById('summaryContent').textContent.includes('最初の要約。'));

  await page.click('#summarize');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('要約できませんでした'));
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'critical');
  assert.match(await page.textContent('#toast'), /500.*Internal error/);
  assert.ok((await summaryText(page)).includes('最初の要約。'), 'the earlier summary is kept');
  assert.equal(await page.getAttribute('#summarize', 'aria-busy'), 'false');

  await page.click('#summarize');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('レート制限'));
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'warning');
  assert.ok((await summaryText(page)).includes('最初の要約。'));
  assert.deepEqual(errors, []);
  await close();
});
