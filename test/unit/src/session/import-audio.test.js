import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCEPT,
  checkAudio,
  checkFile,
  checkLength,
  checkWhole,
  fileType,
  importedSession,
  importLanguages,
  MAX_BYTES,
  MAX_MS,
  MIN_MS,
  progressKey,
  titleFromFileName,
  WHOLE_MAX_BYTES,
  WHOLE_MAX_MS,
  wavChunks,
} from '../../../../src/session/import-audio.js';
import { emptyUsage } from '../../../../src/usage/usage.js';

const MB = 1024 ** 2;

test('audio files of the formats the app decodes are taken, by their type or, without one, their extension', () => {
  for (const [name, type] of [
    ['call.mp3', 'audio/mpeg'],
    ['call.m4a', 'audio/x-m4a'],
    ['call.wav', 'audio/wav'],
    ['call.flac', 'audio/flac'],
    ['call.ogg', 'audio/ogg'],
    ['call.webm', 'audio/webm'],
    ['meeting.mp4', 'video/mp4'],
    ['call.aac', 'audio/aac'],
    ['call.opus', ''],
    ['CALL.M4A', ''],
  ])
    assert.equal(checkFile({ name, type, size: MB }), null, name);
  assert.equal(fileType({ name: 'call.m4a', type: 'audio/x-m4a' }), 'audio/x-m4a', 'the type the system gives');
  assert.equal(fileType({ name: 'call.m4a', type: '' }), 'audio/mp4', 'the type of its extension');
  assert.equal(fileType({ name: 'call.opus', type: '' }), 'audio/ogg');
  assert.equal(fileType({ name: 'notes.txt', type: 'text/plain' }), '');
});

test('files the app cannot decode or that are not audio are refused by name and type', () => {
  for (const [name, type] of [
    ['notes.txt', 'text/plain'],
    ['voice.aiff', 'audio/aiff'],
    ['voice.caf', 'audio/x-caf'],
    ['picture.png', 'image/png'],
    ['noextension', ''],
  ])
    assert.deepEqual(checkFile({ name, type, size: MB }), { key: 'import.notAudio' }, name);
});

test('an empty file cannot be read and a file over the size limit is refused with the limit', () => {
  assert.deepEqual(checkFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 }), { key: 'import.undecodable' });
  assert.equal(checkFile({ name: 'a.wav', type: 'audio/wav', size: MAX_BYTES }), null);
  assert.deepEqual(checkFile({ name: 'a.wav', type: 'audio/wav', size: MAX_BYTES + 1 }), {
    key: 'import.tooLarge',
    params: { mb: 2000 },
  });
});

test('a file decoded whole has a tighter size limit, said with its number', () => {
  assert.equal(WHOLE_MAX_BYTES, 500 * 1024 ** 2);
  assert.equal(checkWhole({ size: WHOLE_MAX_BYTES }), null);
  assert.deepEqual(checkWhole({ size: WHOLE_MAX_BYTES + 1 }), { key: 'import.tooLargeWhole', params: { mb: 500 } });
});

test('the file input offers the extensions and the types that are taken', () => {
  const offered = ACCEPT.split(',');
  for (const item of ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.webm', '.mp4', 'audio/mpeg', 'video/mp4'])
    assert.ok(offered.includes(item), item);
  assert.ok(!offered.some((item) => /aiff|caf/.test(item)));
});

test('a recording longer than two hours, or one hour when decoded whole, is refused with the limit; an unknown length is decided later', () => {
  assert.equal(MAX_MS, 2 * 3_600_000);
  assert.equal(MAX_BYTES, 2000 * 1024 ** 2);
  assert.equal(WHOLE_MAX_MS, 3_600_000);
  assert.equal(checkLength(MAX_MS), null);
  assert.deepEqual(checkLength(MAX_MS + 1), { key: 'import.tooLong', params: { minutes: 120 } });
  assert.equal(checkLength(WHOLE_MAX_MS, { whole: true }), null);
  assert.deepEqual(checkLength(WHOLE_MAX_MS + 1, { whole: true }), {
    key: 'import.tooLongWhole',
    params: { minutes: 60 },
  });
  assert.equal(checkLength(Number.NaN), null);
  assert.equal(checkLength(Number.POSITIVE_INFINITY), null, 'a WebM recorded by a browser does not say');
});

const tone = (ms, amplitude) => {
  const samples = new Int16Array((ms * 16000) / 1000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(amplitude * Math.sin(i / 10));
  return { samples, durationMs: ms };
};

test('decoded audio needs at least a second of sound, and no more than the limit', () => {
  assert.equal(checkAudio(tone(5000, 3000)), null);
  assert.equal(checkAudio(tone(MIN_MS, 3000)), null);
  assert.deepEqual(checkAudio(tone(MIN_MS - 100, 3000)), { key: 'import.tooShort' });
  assert.deepEqual(checkAudio(tone(5000, 0)), { key: 'import.silent' });
  assert.deepEqual(checkAudio(tone(5000, 20)), { key: 'import.silent' }, 'below -60 dBFS');
  assert.deepEqual(checkAudio({ samples: new Int16Array(16), durationMs: MAX_MS + 1000 }), {
    key: 'import.tooLong',
    params: { minutes: 120 },
  });
  assert.deepEqual(checkAudio({ samples: new Int16Array(16), durationMs: WHOLE_MAX_MS + 1000 }, { whole: true }), {
    key: 'import.tooLongWhole',
    params: { minutes: 60 },
  });
  // One loud moment in a quiet file is enough.
  const quiet = tone(5000, 0);
  quiet.samples[40_000] = -2000;
  assert.equal(checkAudio(quiet), null);
});

test('the title is the file name without its extension', () => {
  assert.equal(titleFromFileName('Weekly sync 2026-11-20.m4a'), 'Weekly sync 2026-11-20');
  assert.equal(titleFromFileName('interview.final.mp3'), 'interview.final');
  assert.equal(titleFromFileName('  two\tspaces  .wav'), 'two spaces');
  assert.equal(titleFromFileName('no-extension'), 'no-extension');
  assert.equal(titleFromFileName('.mp3'), '');
  assert.equal(titleFromFileName(`${'x'.repeat(150)}.wav`).length, 100);
});

test('the progress says the file is read, then which part is sent or transcribed, then the lines translated', () => {
  assert.equal(progressKey({ step: 'read' }), 'import.reading');
  assert.equal(progressKey({ step: 'upload', part: 1, parts: 2 }), 'speakers.uploading');
  assert.equal(progressKey({ step: 'analyze', part: 1, parts: 2 }), 'rebuild.transcribing');
  assert.equal(progressKey({ step: 'punctuate', done: 1, total: 3 }), 'rebuild.punctuating');
  assert.equal(progressKey({ step: 'translate', done: 1, total: 4 }), 'rebuild.translating');
});

const RESULT = {
  segments: [
    { id: 'l1', elapsed: 500, src: 'Shall we begin?', tgt: '始めましょうか。', speaker: 's1' },
    { id: 'l2', elapsed: 5500, src: 'Yes.', tgt: 'はい。', speaker: 's2' },
  ],
  speakers: [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ],
  uncertain: false,
  model: 'gemini-3.5-transcribe',
  failures: [],
};
const OPTIONS = {
  id: 'sess-1',
  recId: 'rec-1',
  now: 1_700_000_000_000,
  langs: { langA: 'en-US', langB: 'ja-JP' },
  fileName: 'Weekly sync.mp3',
  durationMs: 12_345.6,
};

test('the session made from a file has its lines, speakers, length and the decoded audio as its one recording', () => {
  const usage = emptyUsage();
  const sess = importedSession(RESULT, { ...OPTIONS, usage });
  assert.deepEqual(sess, {
    id: 'sess-1',
    title: 'Weekly sync',
    customTitle: true,
    createdAt: OPTIONS.now,
    updatedAt: OPTIONS.now,
    langA: 'en-US',
    langB: 'ja-JP',
    activeMs: 12_346,
    imported: true,
    usage,
    speakerLabels: { speakers: RESULT.speakers, madeAt: OPTIONS.now, uncertain: false, model: 'gemini-3.5-transcribe' },
    segments: RESULT.segments,
    summaries: [],
    questions: [],
    recordings: [{ id: 'rec-1', elapsedStart: 0, durationMs: 12_346, mime: 'audio/wav' }],
  });
  assert.equal('startedAt' in sess.recordings[0], false, 'when the file was recorded is not known');
});

test('a third language is kept; without speakers there are no labels; a name without text takes the first line', () => {
  const three = importedSession(RESULT, { ...OPTIONS, langs: { langA: 'en-US', langB: 'ja-JP', langC: 'zh-CN' } });
  assert.equal(three.langC, 'zh-CN');
  const noSpeakers = importedSession({ ...RESULT, speakers: [] }, OPTIONS);
  assert.equal('speakerLabels' in noSpeakers, false);
  assert.equal('langC' in noSpeakers, false);
  const unnamed = importedSession(RESULT, { ...OPTIONS, fileName: '.mp3' });
  assert.equal(unnamed.title, 'Shall we begin?');
  assert.equal(unnamed.customTitle, false);
});

test('the decoded audio is kept as a WAV in chunks that, joined, are one file of the whole length', () => {
  const samples = new Int16Array(25);
  for (let i = 0; i < samples.length; i++) samples[i] = i * 100 - 1000;
  const chunks = wavChunks(samples, { rate: 10, chunkMs: 1000 }); // 10 samples a chunk
  assert.deepEqual(
    chunks.map((c) => c.length),
    [44, 20, 20, 10],
  );
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const view = new DataView(bytes.buffer);
  const text = (from, n) => String.fromCharCode(...bytes.subarray(from, from + n));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + 50);
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 10);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 50);
  for (let i = 0; i < samples.length; i++) assert.equal(view.getInt16(44 + i * 2, true), samples[i]);
});

test('an hour is kept as the header and twelve chunks of five minutes, about 115 MB at 16 kHz', () => {
  const chunks = wavChunks(new Int16Array(16000 * 3600));
  assert.equal(chunks.length, 13);
  assert.equal(
    chunks.reduce((n, c) => n + c.length, 0),
    44 + 16000 * 3600 * 2,
  );
});

const JA = { code: 'ja-JP', display: 'ja', name: 'Japanese' };
const EN = { code: 'en-US', display: 'en', name: 'English' };
const KO = { code: 'ko-KR', display: 'ko', name: 'Korean' };
const DE = { code: 'de-DE', display: 'de', name: 'German' };
const LISTENING = { A: 'ja-JP', B: 'en-US', C: '' };

test("the languages chosen in the dialog are the session's and the ones transcription and translation are given", () => {
  assert.deepEqual(importLanguages({ A: 'ko-KR', B: 'en-US', C: '' }, LISTENING, 'all'), {
    codes: { langA: 'ko-KR', langB: 'en-US' },
    langs: [KO, EN],
    otherInto: 'all',
  });
  const three = importLanguages({ A: 'ja-JP', B: 'en-US', C: 'de-DE' }, LISTENING, 'all');
  assert.deepEqual(three.codes, { langA: 'ja-JP', langB: 'en-US', langC: 'de-DE' });
  assert.deepEqual(three.langs, [JA, EN, DE]);
  const sess = importedSession(RESULT, { ...OPTIONS, langs: three.codes });
  assert.deepEqual([sess.langA, sess.langB, sess.langC], ['ja-JP', 'en-US', 'de-DE']);
});

test('the setting for speech in none of the languages keeps meaning its language when the dialog moves it, and turns to all without a third language', () => {
  // Unchanged languages: the setting as it is.
  assert.equal(importLanguages(LISTENING, LISTENING, 'B').otherInto, 'B');
  // Swapped in the dialog: English, which the setting named, is now first.
  assert.equal(importLanguages({ A: 'en-US', B: 'ja-JP', C: '' }, LISTENING, 'B').otherInto, 'A');
  // Other languages altogether: the place is kept.
  assert.equal(importLanguages({ A: 'ko-KR', B: 'de-DE', C: '' }, LISTENING, 'A').otherInto, 'A');
  // The third language the setting named is left out of the import.
  const listeningThree = { A: 'ja-JP', B: 'en-US', C: 'de-DE' };
  assert.equal(importLanguages({ A: 'ja-JP', B: 'en-US', C: '' }, listeningThree, 'C').otherInto, 'all');
  assert.equal(importLanguages(listeningThree, listeningThree, 'all').otherInto, 'all');
});
