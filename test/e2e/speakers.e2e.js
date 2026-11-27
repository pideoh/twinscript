// Browser tests: speaker labels made after a session from its recording, with every Gemini endpoint
// mocked (upload, file state, analysis, deletion) and a recording written to the app's storage.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lineSpeakers,
  mockSpeakers,
  mockSummary,
  reload,
  saved,
  seededAnswer,
  seedRecordedSession,
  setup,
  showTab,
  storedSessions,
} from './helpers.js';

const { openApp } = setup();

// Answers every confirm() with `answer` and keeps what was asked.
function confirms(page, answer = true) {
  const asked = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    if (answer) dialog.accept();
    else dialog.dismiss();
  });
  return asked;
}
const labelled = (page) =>
  page.waitForFunction(
    () =>
      document.getElementById('labelSpeakers').getAttribute('aria-busy') === 'false' &&
      !document.getElementById('editSpeakers').hidden,
  );
const toastText = (page) => page.textContent('#toast');
async function readDownload(page, click) {
  const [file] = await Promise.all([page.waitForEvent('download'), click()]);
  let text = '';
  for await (const chunk of await file.createReadStream()) text += chunk;
  return text;
}

test('a recorded session gets speaker labels on its lines; they can be renamed, corrected, exported and summarized', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  const asked = confirms(page);
  const service = await mockSpeakers(page);
  assert.ok(await page.isVisible('#labelSpeakers'));
  assert.equal(await page.textContent('#labelSpeakers'), '話者を識別');
  assert.ok(await page.isHidden('#editSpeakers'), 'nothing to edit before labelling');
  assert.ok(await page.locator('#log .seg .speaker').first().isHidden(), 'no speaker column before labelling');

  await page.click('#labelSpeakers');
  await labelled(page);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /録音を Google（Gemini API）にアップロード/);
  assert.match(asked[0], /解析が終わるとすぐに削除/);
  assert.deepEqual(await lineSpeakers(page), ['話者1', '話者2', '話者1', '話者2']);
  assert.match(await toastText(page), /話者を識別しました（2人）/);

  // One upload of a 16 kHz mono WAV of the whole recording, analysed and then deleted.
  assert.equal(service.uploads.length, 1);
  const start = service.uploads[0].headers;
  assert.equal(start['x-goog-upload-header-content-type'], 'audio/wav');
  assert.equal(Number(start['x-goog-upload-header-content-length']), 44 + 20 * 16_000 * 2);
  assert.equal(start['x-goog-api-key'], 'test-key');
  assert.equal(service.analyses.length, 1);
  assert.equal(service.analyses[0].model, 'models/gemini-3.5-transcribe');
  assert.equal(service.analyses[0].generation_config.transcription_config.mode.diarization_mode, 'speaker');
  assert.deepEqual(service.deleted, ['files/f1']);

  // Stored with the session: an id per line, the list of speakers in the metadata.
  await saved(page);
  let [stored] = await storedSessions(page);
  assert.deepEqual(
    stored.segments.map((s) => s.speaker),
    ['s1', 's2', 's1', 's2'],
  );
  assert.deepEqual(stored.speakerLabels.speakers, [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ]);
  assert.equal(stored.speakerLabels.uncertain, false);
  assert.equal(stored.usage.diarization['gemini-3.5-transcribe'].requests, 1);

  // Rename from the summary bar: the name applies to every line of that speaker.
  await page.click('#editSpeakers');
  await page.waitForSelector('#speakerDialog[open]');
  assert.ok(await page.isHidden('#speakerLine'));
  await page.fill('#speakerNames input >> nth=0', 'Aiko');
  await page.click('#speakerSave');
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', '話者2']);

  // Correct one line by activating its speaker.
  await page.click('#log .seg >> nth=3 >> .speaker');
  await page.waitForSelector('#speakerDialog[open]');
  assert.match(await page.textContent('#speakerLineText'), /It is on track\./);
  assert.deepEqual(await page.locator('#speakerLineSelect option').allTextContents(), ['話者なし', 'Aiko', '話者2']);
  assert.equal(await page.inputValue('#speakerLineSelect'), 's2');
  await page.selectOption('#speakerLineSelect', 's1');
  await page.click('#speakerSave');
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', 'Aiko']);
  await saved(page);
  [stored] = await storedSessions(page);
  assert.equal(stored.segments[3].speaker, 's1');
  assert.equal(stored.speakerLabels.speakers[0].name, 'Aiko');

  // The labels survive a reload.
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg .speaker-name').length === 4);
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', 'Aiko']);
  await mockSpeakers(page);

  // Exports carry the speakers.
  await page.click('#export');
  const txt = await readDownload(page, () => page.click('#exportTranscript'));
  assert.match(txt, /\[00:00:01\] Aiko: Shall we start with the budget\?\n {11}→ 予算から始めましょうか。/);
  assert.match(txt, /\[00:00:06\] 話者2: Yes, I will send the report on Friday\./);
  await page.selectOption('#exportFormat', 'csv');
  const csv = await readDownload(page, () => page.click('#exportTranscript'));
  assert.match(csv, /^﻿time,speaker,source,translation\r\n00:00:01,"Aiko","Shall we start/);
  await page.selectOption('#exportFormat', 'md');
  const md = await readDownload(page, () => page.click('#exportTranscript'));
  assert.match(md, /\| 時間 \| 話者 \| 原文 \| 訳文 \|/);
  await page.selectOption('#exportFormat', 'srt');
  const srt = await readDownload(page, () => page.click('#exportTranscript'));
  assert.match(srt, /\n話者2: Yes, I will send the report on Friday\.\n/);
  await page.keyboard.press('Escape');

  // A summary made now attributes the lines.
  const requests = await mockSummary(page, () => ({ body: '## 概要\n\n予算を確認した。' }));
  await showTab(page, 'summary');
  await page.click('#summarize');
  await page.waitForFunction(() => document.querySelectorAll('#summaryHistory option').length === 1);
  const transcript = requests[0].contents[0].parts[0].text;
  assert.match(transcript, /\[00:00:01\] Aiko: Shall we start with the budget\?/);
  assert.match(transcript, /\[00:00:06\] 話者2: Yes, I will send the report on Friday\./);
  assert.match(requests[0].systemInstruction.parts[0].text, /name of its speaker/);
  assert.ok(await page.isHidden('#summaryStale'));

  // Labelling again asks first (not for the upload again) and replaces names and corrections.
  await showTab(page, 'transcript');
  await page.click('#labelSpeakers');
  await labelled(page);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /もう一度識別しますか/);
  assert.deepEqual(await lineSpeakers(page), ['話者1', '話者2', '話者1', '話者2']);
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#summaryStale'), 'the summary was made before these labels');
  assert.equal(await page.getAttribute('#summaryStale', 'title'), 'この要約の作成後に話者が識別されました');

  // The usage dialog has a row of its own for them, priced with the transcription model.
  await page.click('#openUsage');
  const rows = await page
    .locator('#usageSession tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.deepEqual(rows[3], ['話者の識別', '', '2', '1,000', '2,400', '$0.031']);
  await page.click('#usageDialog .dialog-footer button');
  assert.deepEqual(errors, []);
  await close();
});

test('the upload is deleted also when the analysis fails, and the error is reported', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  confirms(page);
  const service = await mockSpeakers(page, {
    analyze: () => ({ status: 500, body: { error: { code: 500, message: 'Internal error' } } }),
  });
  await page.click('#labelSpeakers');
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'critical');
  assert.equal(await toastText(page), '話者を識別できませんでした: 話者の解析エラー (500): Internal error');
  assert.deepEqual(service.deleted, ['files/f1']);
  assert.ok(await page.isHidden('#editSpeakers'));
  assert.equal(await page.getAttribute('#labelSpeakers', 'aria-busy'), 'false');
  assert.ok(await page.locator('#log .seg .speaker').first().isHidden());
  assert.deepEqual(errors, []);
  await close();
});

test('a cut-off answer that is cut off again is an error; every upload is deleted', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  confirms(page);
  const service = await mockSpeakers(page, { analyze: () => ({ body: seededAnswer({ status: 'incomplete' }) }) });
  await page.click('#labelSpeakers');
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'critical');
  assert.match(await toastText(page), /2回とも途中で終わりました/);
  assert.equal(service.analyses.length, 2, 'tried once more with a shorter part');
  assert.deepEqual(service.deleted, ['files/f1', 'files/f2']);
  assert.deepEqual(errors, []);
  await close();
});

test('labelling shows its progress and can be cancelled, which deletes the upload', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  confirms(page);
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const service = await mockSpeakers(page, {
    analyze: async () => {
      await held;
      return { body: seededAnswer() };
    },
  });
  await page.click('#labelSpeakers');
  await page.waitForFunction(() => document.getElementById('speakersStatus').textContent.includes('解析'));
  assert.equal(await page.textContent('#speakersStatus'), 'パート 1/1 を解析しています…');
  assert.equal(await page.getAttribute('#labelSpeakers', 'aria-busy'), 'true');
  assert.ok(await page.isVisible('#cancelSpeakers'));
  await page.click('#cancelSpeakers');
  await page.waitForFunction(() => document.getElementById('toast').textContent === '話者の識別を中止しました。');
  release();
  await page.waitForFunction(() => document.getElementById('cancelSpeakers').hidden);
  assert.deepEqual(service.deleted, ['files/f1']);
  assert.ok(await page.isHidden('#editSpeakers'));
  assert.equal(await page.textContent('#speakersStatus'), '');
  assert.deepEqual(errors, []);
  await close();
});

test('the upload is explained once; declining sends nothing and asks again next time', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  const service = await mockSpeakers(page);
  const declined = [];
  page.once('dialog', (dialog) => {
    declined.push(dialog.message());
    dialog.dismiss();
  });
  await page.click('#labelSpeakers');
  assert.equal(declined.length, 1);
  assert.equal(await page.getAttribute('#labelSpeakers', 'aria-busy'), 'false', 'nothing started');
  assert.equal(service.uploads.length, 0);
  const asked = confirms(page);
  await page.click('#labelSpeakers');
  await labelled(page);
  assert.equal(asked.length, 1, 'asked again, since it was declined');
  assert.equal(service.uploads.length, 1);
  assert.deepEqual(errors, []);
  await close();
});

test('a session without a recording offers no speaker labels', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  await page.evaluate(() => {
    // The same session as if it had been recorded with recording turned off.
    return new Promise((resolve) => {
      const open = indexedDB.open('twinscript');
      open.onsuccess = () => {
        const tx = open.result.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        store.getAll().onsuccess = (e) => {
          for (const s of e.target.result) store.put({ ...s, recordings: [] });
        };
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
  });
  await reload(page);
  await page.waitForSelector('#summary:not([hidden])', { state: 'attached' });
  assert.ok(await page.isHidden('#speakerTools'));
  assert.deepEqual(errors, []);
  await close();
});

test('the demo offers no speaker labels and sends nothing to the speaker endpoints', async () => {
  // The demo has no engine for it. A recording made outside the demo is still in the same storage,
  // so a finished, recorded session can be on screen in the demo.
  const { page, errors, close } = await openApp('?mock=1', { apiKey: 'test-key' });
  const service = await mockSpeakers(page);
  await seedRecordedSession(page);
  await page.waitForSelector('#summary:not([hidden])', { state: 'attached' });
  assert.ok(await page.isHidden('#labelSpeakers'), 'no action to identify speakers');
  assert.ok(await page.isHidden('#speakerTools'));
  assert.deepEqual([service.uploads, service.analyses, service.deleted], [[], [], []]);
  assert.deepEqual(errors, []);
  await close();
});
