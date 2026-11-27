import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL } from '../../../../src/session/diarizer.js';
import { linesFromWords, sessionTime, transcribeRecording } from '../../../../src/session/recording-transcript.js';
import { LANGS } from '../../../../src/ui/langs.js';

const lang = (code) => LANGS.find((l) => l.code === code);
const JA = lang('ja-JP');
const EN = lang('en-US');

// Words of `text` (split at spaces) from `startMs`, `step` ms each, spoken by `speaker`.
function said(text, startMs, speaker = 's1', step = 300) {
  return text.split(' ').map((w, i) => ({
    startMs: startMs + i * step,
    endMs: startMs + i * step + step - 50,
    speaker,
    text: w,
  }));
}
const texts = (lines) => lines.map((l) => l.text);

test('a line ends at the end of a sentence, and starts at the time of its first word', () => {
  const words = said('We should start with the budget. Then we look at the schedule.', 1000);
  const lines = linesFromWords(words);
  assert.deepEqual(texts(lines), ['We should start with the budget.', 'Then we look at the schedule.']);
  assert.deepEqual(
    lines.map((l) => [l.startMs, l.endMs, l.speaker]),
    [
      [1000, 1000 + 5 * 300 + 250, 's1'],
      [1000 + 6 * 300, 1000 + 11 * 300 + 250, 's1'],
    ],
  );
});

test('a very short sentence is joined to the next one, as while listening', () => {
  assert.deepEqual(texts(linesFromWords(said('Yes. Okay. Let us start now.', 0))), ['Yes. Okay.', 'Let us start now.']);
});

test('a pause ends a line, even without punctuation', () => {
  const words = [...said('so the plan is', 0), ...said('we ship on Friday', 1200 + 1500)];
  assert.deepEqual(texts(linesFromWords(words)), ['so the plan is', 'we ship on Friday']);
});

test('another speaker starts a new line; words with no speaker are a line of their own', () => {
  const words = [...said('I think it works', 0, 's1'), ...said('it does not', 1300, 's2'), ...said('hm', 2300, null)];
  const lines = linesFromWords(words);
  assert.deepEqual(
    lines.map((l) => [l.text, l.speaker]),
    [
      ['I think it works', 's1'],
      ['it does not', 's2'],
      ['hm', null],
    ],
  );
});

test('speech without a sentence end is cut at the longest line, between words, losing nothing', () => {
  const text = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const lines = linesFromWords(said(text, 0, 's1', 100));
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.text.length <= 180, line.text);
  assert.equal(lines.map((l) => l.text).join(' '), text);
});

test('Japanese words are joined without spaces and split after 。', () => {
  const words = ['今日は', '予算の', '話を', 'します。', '次に', '日程を', '確認します。'].map((text, i) => ({
    startMs: i * 400,
    endMs: i * 400 + 350,
    speaker: 's1',
    text,
  }));
  assert.deepEqual(texts(linesFromWords(words)), ['今日は予算の話をします。', '次に日程を確認します。']);
});

test('punctuation given as words of its own sticks to the word before; words without text are skipped', () => {
  const words = [
    { startMs: 0, endMs: 200, speaker: 's1', text: 'Hello' },
    { startMs: 200, endMs: 210, speaker: 's1', text: ',' },
    { startMs: 300, endMs: 500, speaker: 's1', text: ' ' },
    { startMs: 300, endMs: 500, speaker: 's1', text: 'world' },
    { startMs: 500, endMs: 510, speaker: 's1', text: '.' },
  ];
  assert.deepEqual(texts(linesFromWords(words)), ['Hello, world.']);
});

test('where the model tells whether a space follows a word, that is used', () => {
  const words = [
    { startMs: 0, endMs: 200, speaker: 's1', text: 'e-', space: false },
    { startMs: 200, endMs: 400, speaker: 's1', text: 'mail', space: true },
    { startMs: 400, endMs: 600, speaker: 's1', text: 'it.', space: true },
  ];
  assert.deepEqual(texts(linesFromWords(words)), ['e-mail it.']);
});

test('time in the recordings becomes the session time of the recording it falls in', () => {
  // Stopped after 10 s and started again when the session had been active for 60 s.
  const recordings = [
    { elapsedStart: 0, durationMs: 10_000, startedAt: 1_000 },
    { elapsedStart: 60_000, durationMs: 5_000, startedAt: 200_000 },
  ];
  assert.deepEqual(sessionTime(recordings, 3_000), { elapsed: 3_000, at: 4_000 });
  assert.deepEqual(sessionTime(recordings, 12_000), { elapsed: 62_000, at: 202_000 });
  assert.deepEqual(sessionTime(recordings, 99_000), { elapsed: 149_000, at: 289_000 }, 'past the end: the last one');
  assert.deepEqual(sessionTime([{ elapsedStart: 0, durationMs: 1000 }], 500), { elapsed: 500, at: undefined });
});

test('a recording longer than the time it was counted for never reaches into the next one', () => {
  const recordings = [
    { elapsedStart: 0, durationMs: 10_000 },
    { elapsedStart: 9_000, durationMs: 5_000 },
  ];
  assert.equal(sessionTime(recordings, 9_500).elapsed, 8_999);
  assert.equal(sessionTime(recordings, 10_500).elapsed, 9_500);
});

// ---------- the whole recording ----------

const RATE = 100;
const seconds = (ms) => `${(ms / 1000).toFixed(3)}s`;

// A diarizer whose analysis answers with `words` ([text, startMs, endMs, label]) in request time.
function standInDiarizer(words, { hold } = {}) {
  const seen = { uploads: 0, removed: [] };
  seen.upload = async () => {
    seen.uploads++;
    return { name: `files/f${seen.uploads}`, uri: 'u', mime: 'audio/wav' };
  };
  seen.analyze = async (_, { signal } = {}) => {
    await hold?.(signal);
    return {
      status: 'completed',
      usage: { total_input_tokens: 100, total_output_tokens: 20 },
      steps: [
        {
          content: [
            {
              type: 'text',
              annotations: words.map(([text, startMs, endMs, speaker]) => ({
                type: 'word_info',
                text,
                speaker,
                start_offset: seconds(startMs),
                end_offset: seconds(endMs),
              })),
            },
          ],
        },
      ],
    };
  };
  seen.remove = async (file) => {
    seen.removed.push(file.name);
  };
  return seen;
}
const translator = {
  translate: async (text) => `訳:${text}`,
  identify: async () => 'other',
};
const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};
const recording = (ms, extra) => ({ samples: new Int16Array((ms * RATE) / 1000), elapsedStart: 0, ...extra });

test('a recording becomes translated lines with times, speakers numbered by their first line, and usage', async () => {
  const diarizer = standInDiarizer([
    ['Shall', 500, 800, 'spk:B'],
    ['we', 800, 1000, 'spk:B'],
    ['start?', 1000, 1400, 'spk:B'],
    ['Yes,', 3000, 3300, 'spk:A'],
    ['now.', 3300, 3600, 'spk:A'],
    ['Good.', 6000, 6400, 'spk:B'],
  ]);
  const progress = [];
  const usage = [];
  const result = await transcribeRecording({
    pieces: [recording(8000, { startedAt: 50_000 })],
    rate: RATE,
    langs: [JA, EN],
    diarizer,
    translator,
    uid: ids(),
    onProgress: (p) => progress.push(p),
    onUsage: (used, model) => usage.push([model, used.promptTokenCount]),
  });
  assert.deepEqual(result.segments, [
    { id: 'id1', at: 50_500, elapsed: 500, src: 'Shall we start?', tgt: '訳:Shall we start?', speaker: 's1' },
    { id: 'id2', at: 53_000, elapsed: 3000, src: 'Yes, now.', tgt: '訳:Yes, now.', speaker: 's2' },
    { id: 'id3', at: 56_000, elapsed: 6000, src: 'Good.', tgt: '訳:Good.', speaker: 's1' },
  ]);
  assert.deepEqual(result.speakers, [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ]);
  assert.equal(result.model, MODEL);
  assert.equal(result.uncertain, false);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(usage, [[MODEL, 100]]);
  assert.deepEqual(diarizer.removed, ['files/f1'], 'the upload is deleted');
  assert.deepEqual(
    progress.map((p) => p.step),
    ['upload', 'analyze', 'translate', 'translate', 'translate', 'translate'],
  );
  assert.deepEqual(progress.at(-1), { step: 'translate', done: 3, total: 3 });
  assert.deepEqual(result.recordings, [{ elapsedStart: 0, durationMs: 8000, startedAt: 50_000 }]);
  assert.deepEqual(
    result.words.map((w) => w.speaker),
    ['s1', 's1', 's1', 's2', 's2', 's1'],
  );
});

test('a recording in which no speaker could be told apart still gives its lines, without speakers', async () => {
  const diarizer = standInDiarizer([
    ['Hello', 0, 300, ''],
    ['there.', 300, 600, ''],
  ]);
  const result = await transcribeRecording({
    pieces: [recording(2000)],
    rate: RATE,
    langs: [JA, EN],
    diarizer,
    translator,
    uid: ids(),
  });
  assert.deepEqual(result.segments, [{ id: 'id1', elapsed: 0, src: 'Hello there.', tgt: '訳:Hello there.' }]);
  assert.deepEqual(result.speakers, []);
});

test('a recording without speech is an error', async () => {
  await assert.rejects(
    transcribeRecording({
      pieces: [recording(2000)],
      rate: RATE,
      langs: [JA, EN],
      diarizer: standInDiarizer([]),
      translator,
      uid: ids(),
    }),
    (err) => err.key === 'error.speakersNone',
  );
});

test('cancelling while a part is analyzed rejects, deletes the upload and translates nothing', async () => {
  const controller = new AbortController();
  const diarizer = standInDiarizer([['Hello.', 0, 300, 'spk:0']], {
    hold: async (signal) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  let asked = 0;
  await assert.rejects(
    transcribeRecording({
      pieces: [recording(2000)],
      rate: RATE,
      langs: [JA, EN],
      diarizer,
      translator: { translate: async () => `${++asked}`, identify: async () => 'other' },
      uid: ids(),
      signal: controller.signal,
    }),
    (err) => err.name === 'AbortError',
  );
  assert.deepEqual(diarizer.removed, ['files/f1']);
  assert.equal(asked, 0);
});
