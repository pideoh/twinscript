// Browser tests: a session's transcript rebuilt from its recording, and the transcript made while
// listening put back, with every Gemini endpoint mocked (upload, file state, transcription with
// words, deletion, translation) and a recording written to the app's storage.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  keptTranscript,
  lineSpeakers,
  listening,
  mockGemini,
  mockLineTranslation,
  mockSpeakers,
  REBUILT_LINES,
  RECORDED_LINES,
  rebuildAnswer,
  rebuildIdle,
  reload,
  rows,
  saved,
  seedNamedSession,
  seedRecordedSession,
  setup,
  showTab,
  storedSessions,
} from './helpers.js';

const { openApp } = setup();

const toastText = (page) => page.textContent('#toast');
// Answers every confirm() with yes and keeps what was asked.
function confirms(page) {
  const asked = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    dialog.accept();
  });
  return asked;
}
const confirmRebuild = async (page) => {
  await page.click('#rebuild');
  await page.waitForSelector('#rebuildDialog[open]');
  await page.click('#rebuildConfirm');
};
const shownLines = async (page) => (await rows(page)).map(({ src, tgt }) => [src, tgt]);
const SEEDED = RECORDED_LINES.map((l) => [l.src, l.tgt]);
const REBUILT = REBUILT_LINES.map((l) => [l.text, `訳:${l.text}`]);

test('a rebuild says what changes, replaces lines, translations and speakers, survives a reload, and can be undone exactly', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const id = await seedNamedSession(page);
  const asked = confirms(page);
  const service = await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  const translations = await mockLineTranslation(page);
  assert.equal(await page.textContent('#rebuild'), '文字起こしを作り直す');
  assert.equal(await page.getAttribute('#rebuild', 'title'), '録音から、文字起こしをもう一度作ります');
  assert.ok(await page.isHidden('#restoreTranscript'), 'nothing to restore yet');

  // The confirmation says what changes, every time.
  await page.click('#rebuild');
  await page.waitForSelector('#rebuildDialog[open]');
  const said = await page.locator('#rebuildDialog li:visible').allTextContents();
  assert.equal(said.length, 7);
  assert.match(said.join('\n'), /言い回し、行の数、時刻は聞き取り時の文字起こしと変わります/);
  assert.match(said.join('\n'), /すべての行をもう一度翻訳します/);
  assert.match(said.join('\n'), /聞き取り時の文字起こしは翻訳と話者ごと保存され、元に戻せます/);
  assert.match(said.join('\n'), /前の文字起こしから作ったことが示されます/);
  assert.match(said.join('\n'), /録音をもう一度処理する料金と、すべての行の翻訳の料金/);
  assert.match(said.join('\n'), /Google（Gemini API）にアップロードし、それぞれ解析が終わるとすぐに削除/);
  await page.keyboard.press('Escape');
  assert.equal(service.uploads.length, 0, 'closing it sends nothing');

  await confirmRebuild(page);
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('作り直しました'));
  await rebuildIdle(page);
  assert.equal(await toastText(page), '録音から文字起こしを作り直しました（4 行）。');
  assert.deepEqual(asked, [], 'no other question: the confirmation was the agreement to upload');
  assert.deepEqual(await shownLines(page), REBUILT);
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', '話者2'], 'the name given is kept');
  assert.deepEqual(
    translations,
    REBUILT_LINES.map((l) => l.text),
  );
  assert.equal(service.uploads.length, 1);
  assert.equal(service.analyses[0].generation_config.transcription_config.mode.timestamp_granularities[0], 'word');
  assert.deepEqual(service.deleted, ['files/f1']);
  assert.deepEqual(service.punctuations, [], 'punctuated speech is not sent for punctuation');
  assert.ok(await page.isVisible('#restoreTranscript'));
  assert.equal(await page.textContent('#restoreTranscript'), '元の文字起こしに戻す');

  // Stored: the new lines and, beside them, the transcript made while listening.
  await saved(page);
  let [stored] = await storedSessions(page);
  assert.deepEqual(
    stored.segments.map((s) => [s.src, s.tgt, s.speaker, s.elapsed]),
    REBUILT_LINES.map((l, i) => [l.text, `訳:${l.text}`, i % 2 ? 's2' : 's1', l.at]),
  );
  assert.equal(stored.title, 'Weekly sync');
  assert.equal(stored.rebuilt.model, 'gemini-3.5-transcribe');
  assert.deepEqual(stored.speakerLabels.speakers, [
    { id: 's1', name: 'Aiko' },
    { id: 's2', name: '' },
  ]);
  assert.equal(stored.usage.diarization['gemini-3.5-transcribe'].requests, 1);
  assert.equal(Object.values(stored.usage.translation)[0].requests, 4);
  const kept = await keptTranscript(page, id);
  assert.deepEqual(
    kept.segments.map((s) => [s.src, s.tgt, s.speaker]),
    RECORDED_LINES.map((l, i) => [l.src, l.tgt, i % 2 ? 's2' : 's1']),
  );

  // It survives a reload.
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg .speaker-name').length === 4);
  assert.deepEqual(await shownLines(page), REBUILT);
  assert.ok(await page.isVisible('#restoreTranscript'));

  // The summary and the answer made before say so.
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#summaryStale'));
  assert.equal(await page.getAttribute('#summaryStale', 'title'), 'この要約の作成後に文字起こしが置き換えられました');
  await showTab(page, 'questions');
  assert.match(await page.textContent('#questionsList .turn-outdated'), /この回答の後に文字起こしが変わりました/);

  // The usage dialog counts the pass over the recording.
  await page.click('#openUsage');
  const usage = await page
    .locator('#usageSession tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.equal(usage.find((r) => r[0] === '話者の識別')?.[2], '1');
  assert.equal(usage.find((r) => r[0] === '翻訳')?.[2], '4');
  await page.click('#usageDialog .dialog-footer button');

  // Restore: exactly the transcript made while listening, with its translations and speakers.
  await showTab(page, 'transcript');
  await page.click('#restoreTranscript');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('戻しました'));
  assert.match(asked.at(-1), /元の文字起こしに戻しますか/);
  assert.equal(await toastText(page), '元の文字起こしに戻しました。');
  assert.deepEqual(await shownLines(page), SEEDED);
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', '話者2']);
  assert.ok(await page.isHidden('#restoreTranscript'));
  await saved(page);
  [stored] = await storedSessions(page);
  assert.deepEqual(
    stored.segments.map(({ id, at, elapsed, src, tgt, speaker }) => ({ id, at, elapsed, src, tgt, speaker })),
    kept.segments.map(({ id, at, elapsed, src, tgt, speaker }) => ({ id, at, elapsed, src, tgt, speaker })),
  );
  assert.equal(stored.rebuilt, undefined);
  assert.equal(await keptTranscript(page, id), null, 'the rebuilt one is dropped');
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length === 4);
  assert.deepEqual(await shownLines(page), SEEDED);
  assert.deepEqual(errors, []);
  await close();
});

test('the progress is shown; cancelling, while transcribing or translating, leaves the session as it was', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedNamedSession(page);
  let release;
  let held = new Promise((r) => {
    release = r;
  });
  const service = await mockSpeakers(page, {
    analyze: async () => {
      await held;
      return { body: rebuildAnswer() };
    },
  });
  await mockLineTranslation(page, async () => {
    await held;
    return null;
  });

  await confirmRebuild(page);
  await page.waitForFunction(() => document.getElementById('rebuildStatus').textContent.includes('文字起こし'));
  assert.equal(await page.textContent('#rebuildStatus'), 'パート 1/1 を文字起こししています…');
  assert.equal(await page.getAttribute('#rebuild', 'aria-busy'), 'true');
  assert.ok(await page.isVisible('#cancelRebuild'));
  assert.ok(await page.isDisabled('#toggle'), 'this session cannot be listened to meanwhile');
  assert.ok(await page.isHidden('#editSpeakers'), 'nor its speakers edited');
  assert.equal(await page.getAttribute('#labelSpeakers', 'aria-disabled'), 'true');
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#summaryContent'), 'the rest of the session can be read');
  await showTab(page, 'transcript');
  await page.click('#cancelRebuild');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('中止'));
  assert.equal(await toastText(page), '文字起こしの作り直しを中止しました。何も変わっていません。');
  release();
  await rebuildIdle(page);
  assert.deepEqual(service.deleted, ['files/f1']);
  assert.deepEqual(await shownLines(page), SEEDED);
  assert.ok(await page.isEnabled('#toggle'));
  assert.ok(await page.isHidden('#restoreTranscript'));

  // Once more, cancelled while the lines are translated.
  held = new Promise((r) => {
    release = r;
  });
  let analyzed = false;
  await mockSpeakers(page, {
    analyze: () => {
      analyzed = true;
      return { body: rebuildAnswer() };
    },
  });
  await confirmRebuild(page);
  await page.waitForFunction(() => document.getElementById('rebuildStatus').textContent.includes('翻訳'));
  assert.ok(analyzed);
  assert.equal(await page.textContent('#rebuildStatus'), '翻訳しています（0/4 行）…');
  await page.click('#cancelRebuild');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('中止'));
  release();
  await rebuildIdle(page);
  assert.deepEqual(await shownLines(page), SEEDED);
  assert.deepEqual(await lineSpeakers(page), ['Aiko', '話者2', 'Aiko', '話者2']);
  await saved(page);
  const [stored] = await storedSessions(page);
  assert.deepEqual(
    stored.segments.map((s) => s.src),
    RECORDED_LINES.map((l) => l.src),
  );
  assert.equal(stored.rebuilt, undefined);
  assert.deepEqual(errors, []);
  await close();
});

test('a failed upload leaves the session as it was and says why', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await page.route(/generativelanguage\.googleapis\.com\/upload\/v1beta\/files/, (route) =>
    route.fulfill({
      status: 403,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 403, message: 'Permission denied' } }),
    }),
  );
  const translations = await mockLineTranslation(page);
  await confirmRebuild(page);
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'critical');
  assert.equal(
    await toastText(page),
    '文字起こしを作り直せませんでした: アップロードエラー (403): Permission denied 何も変わっていません。',
  );
  await rebuildIdle(page);
  assert.deepEqual(await shownLines(page), SEEDED);
  assert.deepEqual(translations, []);
  assert.ok(await page.isHidden('#restoreTranscript'));
  assert.deepEqual(errors, []);
  await close();
});

test('a line whose translation fails shows its error; the rest of the rebuild goes through', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await mockLineTranslation(page, (text) =>
    text === 'Good, then the schedule.' ? { status: 400, body: { error: { code: 400, message: 'Bad line' } } } : null,
  );
  await confirmRebuild(page);
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'warning');
  await rebuildIdle(page);
  assert.equal(
    await toastText(page),
    '録音から文字起こしを作り直しました（4 行）。そのうち 1 行は翻訳できませんでした。',
  );
  const lines = await shownLines(page);
  assert.deepEqual(lines[0], REBUILT[0]);
  assert.equal(lines[2][0], 'Good, then the schedule.');
  assert.match(lines[2][1], /翻訳エラー \(400\): Bad line|Bad line/);
  assert.ok(await page.locator('#log .seg >> nth=2 >> .tgt.error').isVisible());
  assert.deepEqual(lines[3], REBUILT[3]);
  assert.deepEqual(errors, []);
  await close();
});

// Speech that came back from the transcription without punctuation, long enough to need it.
const UNPUNCTUATED =
  'we checked the budget for the spring event and the costs are lower than planned so we can add a second venue and invite more guests next year';
const PUNCTUATED = `${UNPUNCTUATED.replace('event and', 'event, and').replace('planned so', 'planned. So')}.`;

test('speech that came back without punctuation gets it; a word the model changed stays as it was, and only the mark beside it is dropped', async () => {
  for (const [answer, expected] of [
    [
      PUNCTUATED,
      [
        'we checked the budget for the spring event, and the costs are lower than planned.',
        'so we can add a second venue and invite more guests next year.',
      ],
    ],
    [
      PUNCTUATED.replace('and the costs', 'and a costs'),
      [
        'we checked the budget for the spring event and the costs are lower than planned.',
        'so we can add a second venue and invite more guests next year.',
      ],
    ],
  ]) {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
    await seedRecordedSession(page);
    const service = await mockSpeakers(page, {
      analyze: () => ({ body: rebuildAnswer({ lines: [{ at: 500, speaker: 'spk:0', text: UNPUNCTUATED }] }) }),
      punctuate: () => answer,
    });
    await mockLineTranslation(page);
    await confirmRebuild(page);
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('作り直しました'));
    await rebuildIdle(page);
    assert.deepEqual(service.punctuations, [UNPUNCTUATED]);
    assert.deepEqual(
      (await shownLines(page)).map(([src]) => src),
      expected,
    );
    assert.deepEqual(errors, []);
    await close();
  }
});

test('rebuilding is not offered without a recording, while listening, or in the demo', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await seedRecordedSession(page);
  assert.ok(await page.isVisible('#rebuild'));

  // While listening (to the same session), the bar steps aside.
  await mockGemini(page, []);
  await page.click('#toggle');
  await listening(page);
  assert.ok(await page.isHidden('#rebuildTools'));
  await page.click('#toggle');
  await page.waitForFunction(() => !document.getElementById('rebuildTools').hidden);

  // Without a recording.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
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
      }),
  );
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length > 0);
  assert.ok(await page.isHidden('#rebuild'));
  assert.ok(await page.isHidden('#rebuildTools'));
  assert.deepEqual(errors, []);
  await close();

  const demo = await openApp('?mock=1', { apiKey: 'test-key' });
  const service = await mockSpeakers(demo.page);
  await seedRecordedSession(demo.page);
  assert.ok(await demo.page.isHidden('#rebuild'));
  assert.ok(await demo.page.isHidden('#rebuildTools'));
  assert.deepEqual([service.uploads, service.analyses], [[], []]);
  assert.deepEqual(demo.errors, []);
  await demo.close();
});
