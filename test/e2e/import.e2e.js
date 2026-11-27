// Browser tests: a new session made from an audio file, with every Gemini endpoint mocked (upload,
// file state, transcription with words, deletion, translation) and WAV files made in the test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseAudioFile,
  fileRead,
  lineSpeakers,
  listening,
  mockGemini,
  mockLineTranslation,
  mockSpeakers,
  REBUILT_LINES,
  rebuildAnswer,
  reload,
  rows,
  saved,
  sessionNames,
  setup,
  storedAudio,
  storedSessions,
  wavFile,
} from './helpers.js';

const { openApp } = setup();

const toastText = (page) => page.textContent('#toast');
const shownLines = async (page) => (await rows(page)).map(({ src, tgt }) => [src, tgt]);
const IMPORTED = REBUILT_LINES.map((l) => [l.text, `訳:${l.text}`]);
const errorShown = (page) => page.waitForSelector('#importError:not([hidden])');
// Waits for a condition on this side of the page (what the mocks saw).
async function until(check) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check());
}

test('choosing a file says what will happen; the import makes a saved session with lines, speakers, translations and the file as its recording', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const service = await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  const translations = await mockLineTranslation(page);
  assert.equal(await page.getAttribute('#importAudio', 'aria-label'), '音声ファイルを読み込む');
  assert.equal(await page.getAttribute('#importAudio', 'title'), '音声ファイルを読み込む');
  const file = wavFile();

  await chooseAudioFile(page, file);
  await fileRead(page);
  assert.equal(await page.textContent('#importName'), 'Weekly sync.wav');
  assert.equal(await page.textContent('#importDuration'), '00:00:20');
  assert.equal(await page.textContent('#importLangs'), '日本語 / 英語', 'as the header has them');
  const said = (await page.locator('#importDialog li').allTextContents()).join('\n');
  assert.match(said, /Google（Gemini API）にアップロードし、それぞれ解析が終わるとすぐに削除/);
  assert.match(said, /話者つきで文字起こしし、すべての行を翻訳します/);
  assert.match(said, /文字起こしモデルで録音を処理する料金と、すべての行の翻訳の料金/);
  assert.match(
    said,
    /音声は 16 kHz モノラルに変換して、セッションの録音としてアプリに保存されます。元のファイルは保存されません/,
  );
  assert.match(said, /読み込めるのは 60 分、500 MB までのファイルです/);
  assert.equal(service.uploads.length, 0, 'nothing is sent before the user agrees');

  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('読み込みました'));
  assert.equal(await toastText(page), '音声ファイルを読み込みました（4 行）。');
  assert.ok(!(await page.isVisible('#importDialog')), 'the dialog closes');
  assert.deepEqual(await shownLines(page), IMPORTED);
  assert.deepEqual(await lineSpeakers(page), ['話者1', '話者2', '話者1', '話者2']);
  assert.deepEqual(
    translations,
    REBUILT_LINES.map((l) => l.text),
  );
  assert.deepEqual(service.deleted, ['files/f1'], 'the upload is deleted after the analysis');
  assert.deepEqual(await sessionNames(page), ['Weekly sync']);
  assert.equal(await page.textContent('#clock'), '00:00:20');

  // Stored at once: the session, its lines and the file itself.
  const [stored] = await storedSessions(page);
  assert.equal(stored.title, 'Weekly sync');
  assert.equal(stored.activeMs, 20_000);
  assert.deepEqual([stored.langA, stored.langB, stored.langC], ['ja-JP', 'en-US', undefined]);
  assert.ok(Math.abs(stored.createdAt - Date.now()) < 60_000, 'dated when it was made in the app');
  assert.deepEqual(
    stored.segments.map((s) => [s.src, s.tgt, s.speaker, s.elapsed]),
    REBUILT_LINES.map((l, i) => [l.text, `訳:${l.text}`, i % 2 ? 's2' : 's1', l.at]),
  );
  assert.deepEqual(stored.recordings, [
    { id: stored.recordings[0].id, elapsedStart: 0, durationMs: 20_000, mime: 'audio/wav' },
  ]);
  assert.deepEqual(stored.speakerLabels.speakers, [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ]);
  assert.equal(stored.usage.diarization['gemini-3.5-transcribe'].requests, 1);
  assert.equal(Object.values(stored.usage.translation)[0].requests, 4);
  // Kept: the decoded audio as a 16 kHz mono WAV (20 s: the header, then one chunk), not the file.
  const kept = 44 + 20 * 16000 * 2;
  const recId = stored.recordings[0].id;
  assert.deepEqual(await storedAudio(page), [
    { sessionId: stored.id, recId, size: 44 },
    { sessionId: stored.id, recId, size: kept - 44 },
  ]);
  const daily = await page.evaluate(() => localStorage.getItem('rt-usage'));
  assert.match(daily, /gemini-3\.5-transcribe/, 'counted in the daily totals');

  // The recording can be downloaded as the file it was.
  await page.click('#export');
  assert.equal(await page.textContent('#recordings .rec span'), '録音 1 ・ 読み込んだファイル ・ 00:00:20');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#recordings .rec button')]);
  assert.equal(download.suggestedFilename(), 'Weekly sync-1.wav');
  let size = 0;
  for await (const chunk of await download.createReadStream()) size += chunk.length;
  assert.equal(size, kept);
  await page.keyboard.press('Escape');

  // The usage dialog counts the pass over the file and the translations.
  await page.click('#openUsage');
  const usage = await page
    .locator('#usageSession tr')
    .evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
  assert.equal(usage.find((r) => r[0] === '話者の識別')?.[2], '1');
  assert.equal(usage.find((r) => r[0] === '翻訳')?.[2], '4');
  await page.click('#usageDialog .dialog-footer button');

  // It survives a reload, and the tools that work on a recording are offered.
  await reload(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .seg .speaker-name').length === 4);
  assert.deepEqual(await shownLines(page), IMPORTED);
  assert.ok(await page.isVisible('#rebuild'), 'Rebuild from recording');
  await page.click('#rebuild');
  await page.waitForSelector('#rebuildDialog[open]');
  assert.equal(
    await page.textContent('#rebuildKeep'),
    'いまの文字起こしは翻訳と話者ごと保存され、元に戻せます。',
    'no transcript made while listening',
  );
  await page.keyboard.press('Escape');
  assert.ok(await page.isVisible('#labelSpeakers'), 'Label speakers');

  // A rebuild reads the stored WAV and uploads it again.
  await page.click('#rebuild');
  await page.waitForSelector('#rebuildDialog[open]');
  await page.click('#rebuildConfirm');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('作り直しました'));
  assert.equal(service.uploads.length, 2);
  assert.deepEqual(await shownLines(page), IMPORTED);
  assert.deepEqual(errors, []);
  await close();
});

test('the progress is shown in the dialog; cancelling, while transcribing or translating, leaves no session and no audio', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
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

  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('importStatus').textContent.includes('文字起こし'));
  assert.equal(await page.textContent('#importStatus'), 'パート 1/1 を文字起こししています…');
  assert.ok(await page.isDisabled('#importConfirm'));
  assert.ok(await page.isDisabled('#toggle'), 'listening cannot start meanwhile');
  await page.click('#importCancel');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('中止'));
  assert.equal(await toastText(page), '音声ファイルの読み込みを中止しました。何も追加されていません。');
  release();
  await until(() => service.deleted.length === 1);
  assert.deepEqual(service.deleted, ['files/f1'], 'the upload is deleted');
  assert.ok(await page.isEnabled('#toggle'));

  // Once more, cancelled while the lines are translated.
  held = new Promise((r) => {
    release = r;
  });
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('importStatus').textContent.includes('翻訳'));
  assert.equal(await page.textContent('#importStatus'), '翻訳しています（0/4 行）…');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('importDialog').open);
  release();
  await saved(page);
  assert.deepEqual(await storedSessions(page), []);
  assert.deepEqual(await storedAudio(page), []);
  assert.deepEqual(await sessionNames(page), []);
  assert.equal(await page.locator('#log .seg').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('a file that cannot be decoded, is too long, is silent or has no speech, and a failed request, each say why and leave nothing', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const service = await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer({ lines: [] }) }) });
  const translations = await mockLineTranslation(page);
  const refused = async (file, text) => {
    await chooseAudioFile(page, file);
    await errorShown(page);
    assert.equal(await page.textContent('#importError'), text);
    assert.ok(await page.isHidden('#importConfirm'), 'nothing to import');
    await page.click('#importCancel');
    await page.waitForFunction(() => !document.getElementById('importDialog').open);
  };

  await refused(
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    'この種類のファイルは読み込めません。WAV、MP3、M4A、AAC、FLAC、Ogg、WebM、MP4 を使ってください。',
  );
  await refused(
    { name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio at all') },
    'ファイルを音声として読めませんでした。壊れているか、アプリで読めない形式の可能性があります。',
  );
  await refused(
    wavFile({ name: 'long.wav', seconds: 3600 + 60, rate: 3000, bits: 8 }),
    '録音が 60 分を超えています（読み込める上限）。先に短いファイルに分けてください。',
  );
  await refused(wavFile({ name: 'quiet.wav', amplitude: 0 }), '録音が無音で、文字起こしするものがありません。');
  await refused(wavFile({ name: 'blip.wav', seconds: 0.5 }), '録音が 1 秒より短く、文字起こしするものがありません。');
  assert.equal(service.uploads.length, 0, 'none of these is uploaded');

  // The service finds no speech.
  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  await page.click('#importConfirm');
  await errorShown(page);
  assert.equal(
    await page.textContent('#importError'),
    'ファイルを読み込めませんでした: 録音に音声が見つかりませんでした。 何も追加されていません。',
  );
  assert.ok(await page.isEnabled('#importConfirm'), 'it can be tried again');

  // The upload fails.
  await page.route(/generativelanguage\.googleapis\.com\/upload\/v1beta\/files/, (route) =>
    route.fulfill({
      status: 403,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 403, message: 'Permission denied' } }),
    }),
  );
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('importError').textContent.includes('403'));
  assert.equal(
    await page.textContent('#importError'),
    'ファイルを読み込めませんでした: アップロードエラー (403): Permission denied 何も追加されていません。',
  );

  // The rate limit.
  await page.unroute(/generativelanguage\.googleapis\.com\/upload\/v1beta\/files/);
  await mockSpeakers(page, {
    analyze: () => ({ status: 429, body: { error: { code: 429, message: 'Resource exhausted' } } }),
  });
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('importError').textContent.includes('レート制限'));
  assert.match(
    await page.textContent('#importError'),
    /^ファイルを読み込めませんでした: APIのレート制限に達しました。/,
  );
  await page.click('#importCancel');

  await saved(page);
  assert.deepEqual(translations, []);
  assert.deepEqual(await storedSessions(page), []);
  assert.deepEqual(await storedAudio(page), []);
  assert.deepEqual(errors, []);
  await close();
});

test('a line whose translation fails shows its error in the imported session; the rest is imported', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await mockLineTranslation(page, (text) =>
    text === 'Good, then the schedule.' ? { status: 400, body: { error: { code: 400, message: 'Bad line' } } } : null,
  );
  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'warning');
  assert.equal(await toastText(page), '音声ファイルを読み込みました（4 行）。そのうち 1 行は翻訳できませんでした。');
  const lines = await shownLines(page);
  assert.deepEqual(lines[0], IMPORTED[0]);
  assert.match(lines[2][1], /Bad line/);
  assert.ok(await page.locator('#log .seg >> nth=2 >> .tgt.error').isVisible());
  assert.deepEqual(lines[3], IMPORTED[3]);
  assert.deepEqual(errors, []);
  await close();
});

test('without an API key the settings open; the control is disabled while listening and hidden in the demo', async () => {
  const noKey = await openApp('');
  await noKey.page.click('#importAudio');
  await noKey.page.waitForSelector('#settings[open]');
  assert.equal(await noKey.page.textContent('#toast'), '最初に Gemini APIキーを設定してください');
  assert.deepEqual(noKey.errors, []);
  await noKey.close();

  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await mockGemini(page, []);
  await page.click('#toggle');
  await listening(page);
  assert.ok(await page.isDisabled('#importAudio'));
  assert.equal(await page.getAttribute('#importAudio', 'title'), '聞き取り中は音声ファイルを読み込めません');
  await page.click('#toggle');
  await page.waitForFunction(() => !document.getElementById('importAudio').disabled);
  assert.equal(await page.getAttribute('#importAudio', 'title'), '音声ファイルを読み込む');
  assert.deepEqual(errors, []);
  await close();

  const demo = await openApp('?mock=1', { apiKey: 'test-key' });
  assert.ok(await demo.page.isHidden('#importAudio'));
  assert.deepEqual(demo.errors, []);
  await demo.close();
});

test('the dialog and the control are in English with the English display language', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', uiLang: 'en' });
  assert.equal(await page.getAttribute('#importAudio', 'aria-label'), 'Import audio file');
  await chooseAudioFile(page, wavFile({ name: 'Call.wav' }));
  await fileRead(page);
  assert.equal(await page.textContent('#importTitle'), 'Make a session from an audio file');
  assert.equal(await page.textContent('#importLimits'), 'Files of up to 60 minutes and 500 MB can be imported.');
  assert.equal(await page.textContent('#importConfirm'), 'Import');
  assert.deepEqual(errors, []);
  await close();
});
