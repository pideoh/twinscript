import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelSpeakers } from '../../../../src/session/diarizer.js';
import { linesFromWords } from '../../../../src/session/recording-transcript.js';
import {
  assignSpeakers,
  CLIP_GAP_MS,
  CLIP_MS,
  chooseClips,
  LEAD_GAP_MS,
  MAX_STRAY_RUN_MS,
  MIN_OVERLAP_DECIDE_SHARE,
  MIN_OVERLAP_DECIDE_WORDS,
  MIN_OVERLAP_WORDS,
  mergeWords,
  numberSpeakers,
  OVERLAP_MS,
  PART_MAX_MS,
  PIECE_GAP_MS,
  parseSeconds,
  partAudio,
  placeStrayWords,
  planParts,
  recordingTimeline,
  referenceLayout,
  resolvePart,
  SEGMENT_LEAD_MS,
  STRAY_MS,
  segmentSpans,
  toInt16,
  wavBytes,
  wordsFromAnswer,
} from '../../../../src/session/speakers.js';
import { fakeDiarizer, RATE, synthAudio, truthAt } from '../../../support/speaker-service.js';

const MIN = 60_000;
const word = (startMs, endMs, label) => ({ startMs, endMs, label });
const said = (speaker, startMs, endMs) => ({ startMs, endMs, speaker });

// Words of one speaker, back to back, from `fromMs` for `ms`.
function run(label, fromMs, ms, step = 400) {
  const out = [];
  for (let t = fromMs; t < fromMs + ms; t += step) out.push(word(t, Math.min(fromMs + ms, t + step), label));
  return out;
}

// Checks that every word was given a speaker consistent with the truth: one id per real speaker.
function assertConsistent(result, truth) {
  const idOf = new Map();
  const truthOf = new Map();
  for (const w of result.words) {
    const real = truthAt(truth, (w.startMs + w.endMs) / 2);
    if (real === null) continue;
    assert.notEqual(w.speaker, null, `a word at ${w.startMs} ms has no speaker`);
    if (!idOf.has(real)) idOf.set(real, w.speaker);
    if (!truthOf.has(w.speaker)) truthOf.set(w.speaker, real);
    assert.equal(idOf.get(real), w.speaker, `speaker ${real} at ${w.startMs} ms got another label`);
    assert.equal(truthOf.get(w.speaker), real, `label ${w.speaker} at ${w.startMs} ms is used for two speakers`);
  }
  return idOf;
}

// Conversation turns that cycle through `speakers` (indexes), `count` turns of `ms` each.
const cycle = (speakers, count, ms = 15_000) =>
  Array.from({ length: count }, (_, i) => ({ speaker: speakers[i % speakers.length], ms }));

// ---------- answers ----------

test('times in the answer are read in every form the service may use', () => {
  assert.equal(parseSeconds('5.800s'), 5800);
  assert.equal(parseSeconds('6s'), 6000);
  assert.equal(parseSeconds('1.5'), 1500);
  assert.equal(parseSeconds(2.25), 2250);
  assert.equal(parseSeconds(0), 0);
  assert.equal(parseSeconds({ seconds: '3', nanos: 500_000_000 }), 3500);
  for (const bad of ['', 'abc', '5m', null, undefined, Number.NaN, {}, []])
    assert.ok(Number.isNaN(parseSeconds(bad)), String(bad));
});

test('word annotations are found wherever they are in the answer, with their text', () => {
  const answer = {
    status: 'completed',
    steps: [
      { type: 'thought' },
      {
        content: [
          {
            type: 'text',
            annotations: [{ type: 'word_info', text: 'b', speaker: 'spk:1', start_offset: '2s', end_offset: 2.5 }],
          },
          {
            nested: {
              deeper: [{ type: 'word_info', text: 'a', speaker: 'spk:0', start_offset: '0.5s', end_offset: '1s' }],
            },
          },
        ],
      },
    ],
    other: { type: 'word_info', speaker: 'spk:0', start_offset: '3s' },
  };
  assert.deepEqual(wordsFromAnswer(answer), [
    { ...word(500, 1000, 'spk:0'), text: 'a' },
    { ...word(2000, 2500, 'spk:1'), text: 'b' },
    { ...word(3000, 3000, 'spk:0'), text: '' },
  ]);
});

test('a word without a speaker is kept with no label; one without a readable start is left out', () => {
  const answer = [
    { type: 'word_info', text: 'x', start_offset: '1s', end_offset: '2s' },
    { type: 'word_info', speaker: 'spk:0', start_offset: 'soon', end_offset: '2s' },
    { type: 'word_info', speaker: 'spk:0', start_offset: '4s', end_offset: '3s' },
  ];
  assert.deepEqual(wordsFromAnswer(answer), [
    { ...word(1000, 2000, null), text: 'x' },
    { ...word(4000, 4000, 'spk:0'), text: '' },
  ]);
  assert.deepEqual(wordsFromAnswer(null), []);
});

test('punctuation that follows a word in the annotated text joins the word, with whether a space follows', () => {
  const text = 'Hello, world. 今日は 晴れ。';
  const at = (w) => text.indexOf(w);
  const info = (w, s) => ({
    type: 'word_info',
    text: w,
    speaker: 'spk:0',
    start_offset: `${s}s`,
    end_offset: `${s + 0.5}s`,
    start_index: at(w),
    end_index: at(w) + w.length,
  });
  const answer = {
    content: [
      { type: 'text', text, annotations: [info('Hello', 0), info('world', 1), info('今日は', 2), info('晴れ', 3)] },
    ],
  };
  assert.deepEqual(
    wordsFromAnswer(answer).map((w) => [w.text, w.space]),
    [
      ['Hello,', true],
      ['world.', true],
      ['今日は', true],
      ['晴れ。', true],
    ],
  );
  // Indexes that do not point at the word's own text are not trusted.
  const off = { content: [{ type: 'text', text, annotations: [{ ...info('Hello', 0), start_index: 3 }] }] };
  assert.deepEqual(
    wordsFromAnswer(off).map((w) => [w.text, w.space]),
    [['Hello', undefined]],
  );
});

test('words given no speaker take part in no match, keep their text and stay unknown', () => {
  const words = [
    { startMs: 0, endMs: 400, label: 'spk:0', text: 'one' },
    { startMs: 500, endMs: 900, label: null, text: 'two' },
    { startMs: 1000, endMs: 1400, label: 'spk:0', text: 'three' },
  ];
  const result = resolvePart(words, referenceLayout([]), { startMs: 0, endMs: MIN }, { newSpeaker: () => 'p1' });
  assert.deepEqual(result.mapping, { 'spk:0': 'p1' });
  assert.deepEqual(
    result.words.map((w) => [w.text, w.speaker]),
    [
      ['one', 'p1'],
      ['two', null],
      ['three', 'p1'],
    ],
  );
});

// ---------- words out of place ----------

// An answer listing `words` ([text, startSeconds, endSeconds, label]) in that order, as the service does.
const answerOf = (words) => ({
  content: [
    {
      type: 'text',
      annotations: words.map(([text, start, end, speaker]) => ({
        type: 'word_info',
        text,
        speaker,
        start_offset: `${start}s`,
        end_offset: `${end}s`,
      })),
    },
  ],
});
// The same words as placeStrayWords takes them: in the order given.
const listedWords = (words) =>
  words.map(([text, start, end, label]) => ({
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
    label,
    text,
  }));
// `count` words of `ms` each from `fromS` seconds, named `${name}1`, `${name}2`, …
const spoken = (name, fromS, count, { ms = 300, label = 'spk:0' } = {}) =>
  Array.from({ length: count }, (_, i) => [
    `${name}${i + 1}`,
    (fromS * 1000 + i * ms) / 1000,
    (fromS * 1000 + (i + 1) * ms) / 1000,
    label,
  ]);
const textsOf = (words) => words.map((w) => (Array.isArray(w) ? w[0] : w.text));
const movedOf = (words) => words.filter((w) => w.moved).map((w) => w.text);

test('a word whose time is 1,455 seconds too early is placed between its neighbours in the answer', () => {
  // As measured: 1470.0 s, then 14.7 s, then 1470.6 s, in the order the answer lists them.
  const listed = [...spoken('a', 1469.1, 3), ['stray', 14.7, 15, 'spk:0'], ...spoken('b', 1470.6, 2)];
  const words = wordsFromAnswer(answerOf(listed));
  assert.deepEqual(textsOf(words), textsOf(listed), 'in the order of the answer');
  assert.deepEqual(
    words.find((w) => w.text === 'stray'),
    { startMs: 1_470_000, endMs: 1_470_600, label: 'spk:0', text: 'stray', moved: true },
  );
  assert.deepEqual(movedOf(words), ['stray']);
});

test('a ten-second run 1,000 seconds early is spread evenly between its neighbours, keeping text and speakers', () => {
  const early = spoken('r', 200, 25, { ms: 400, label: 'spk:1' }); // really from 1200 s
  const listed = [...spoken('a', 1190, 32), ...early, ...spoken('b', 1210, 10)];
  const words = wordsFromAnswer(answerOf(listed));
  assert.deepEqual(textsOf(words), textsOf(listed), 'the order of the answer is kept');
  const run = words.filter((w) => w.moved);
  assert.deepEqual(textsOf(run), textsOf(early));
  assert.ok(
    run.every((w) => w.label === 'spk:1'),
    'the speaker is kept',
  );
  // From the end of a32 (1199.6 s) to the start of b1 (1210 s), shared out evenly.
  assert.equal(run[0].startMs, 1_199_600);
  assert.equal(run.at(-1).endMs, 1_210_000);
  const lengths = run.map((w) => w.endMs - w.startMs);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1, 'evenly');
});

test('a run whose times are far too late is placed between its neighbours too', () => {
  const listed = [...spoken('a', 100, 5), ...spoken('late', 1100, 4), ...spoken('b', 101.5, 5)];
  const words = wordsFromAnswer(answerOf(listed));
  assert.deepEqual(movedOf(words), ['late1', 'late2', 'late3', 'late4']);
  assert.deepEqual(textsOf(words), textsOf(listed));
});

test('a long pause and the step from the reference clips to the part are kept as they are', () => {
  // Ten minutes of silence between two passages.
  const pause = [...spoken('a', 10, 5), ...spoken('b', 610, 5)];
  assert.deepEqual(placeStrayWords(listedWords(pause)), listedWords(pause));
  // Clips, then a part that starts with five minutes of silence: times step forward only.
  const layout = referenceLayout([
    { speaker: 'A', pieces: [{ startMs: 0, endMs: 20_000 }] },
    { speaker: 'B', pieces: [{ startMs: 30_000, endMs: 50_000 }] },
  ]);
  const clipsThenPart = [
    ...spoken('clipA', 0, 10, { ms: 2000 }),
    ...spoken('clipB', 21, 10, { ms: 2000, label: 'spk:1' }),
    ...spoken('part', layout.refMs / 1000 + 300, 10),
  ];
  assert.deepEqual(placeStrayWords(listedWords(clipsThenPart)), listedWords(clipsThenPart));
});

test('when it cannot be told which words are out of place, none is moved', () => {
  const untouched = (listed) => assert.deepEqual(placeStrayWords(listedWords(listed)), listedWords(listed));
  // B is far later than A and C, and C far earlier than B and D: either B or C is wrong.
  untouched([...spoken('a', 0, 5), ...spoken('b', 1000, 5), ...spoken('c', 20, 5), ...spoken('d', 1020, 5)]);
  // A run longer than the longest that is moved.
  untouched([...spoken('a', 1000, 5), ...spoken('long', 10, (MAX_STRAY_RUN_MS + 3000) / 300), ...spoken('b', 1002, 5)]);
  // A run with no word after it.
  untouched([...spoken('a', 1000, 5), ...spoken('end', 10, 3)]);
  // Neighbours further apart than the run is from them.
  untouched([...spoken('a', 200, 5), ...spoken('x', 10, 2), ...spoken('b', 600, 5)]);
  // A step back shorter than STRAY_MS (speech that overlaps) is not a word out of place.
  untouched([...spoken('a', 100, 5), ...spoken('n', 100 - STRAY_MS / 1000 + 5, 1), ...spoken('b', 101.5, 5)]);
});

test('a transcript made from words placed again reads in whole sentences, not one word per line', () => {
  const sentence = (fromS, list) => list.map((text, i) => [text, fromS + i * 0.25, fromS + (i + 1) * 0.25, 'spk:0']);
  const earlier = sentence(10, ['Earlier', 'we', 'talked', 'about', 'something', 'else.']);
  const first = sentence(1468, ['We', 'start', 'with', 'the', 'budget', 'for', 'next', 'year.']);
  const second = sentence(1470.5, ['Then', 'we', 'look', 'at', 'the', 'dates.']);
  first[4] = ['budget', 14.7, 15, 'spk:0']; // 1,455 s too early, inside the earlier sentence
  const words = wordsFromAnswer(answerOf([...earlier, ...first, ...second])).map(({ label, ...w }) => ({
    ...w,
    speaker: label,
  }));
  assert.deepEqual(
    linesFromWords(words).map((l) => l.text),
    [
      'Earlier we talked about something else.',
      'We start with the budget for next year.',
      'Then we look at the dates.',
    ],
  );
});

// ---------- parts ----------

test('a recording is sent in parts of at most 25 minutes that share a minute', () => {
  assert.deepEqual(planParts(10 * MIN), [{ startMs: 0, endMs: 10 * MIN }]);
  assert.deepEqual(planParts(60 * MIN), [
    { startMs: 0, endMs: 25 * MIN },
    { startMs: 24 * MIN, endMs: 49 * MIN },
    { startMs: 48 * MIN, endMs: 60 * MIN },
  ]);
  for (const part of planParts(3 * 60 * MIN)) assert.ok(part.endMs - part.startMs <= PART_MAX_MS);
  assert.deepEqual(planParts(0), []);
});

// ---------- reference clips ----------

test('a reference clip takes the longest stretches of a speaker alone, up to 20 seconds', () => {
  const words = [
    ...run('A', 0, 8000).map((w) => ({ ...w, speaker: 'A' })),
    ...run('B', 8000, 4000).map((w) => ({ ...w, speaker: 'B' })),
    ...run('A', 12_000, 15_000).map((w) => ({ ...w, speaker: 'A' })),
    ...run('C', 27_000, 3000).map((w) => ({ ...w, speaker: 'C' })), // under 5 s alone: no clip
    ...run('B', 30_000, 2000).map((w) => ({ ...w, speaker: 'B' })),
  ];
  const clips = chooseClips(words, { speakers: ['A', 'B', 'C'] });
  assert.deepEqual(
    clips.map((c) => c.speaker),
    ['A', 'B'],
  );
  const [a, b] = clips;
  assert.equal(a.ms, CLIP_MS);
  assert.deepEqual(a.pieces, [
    { startMs: 0, endMs: 5000 },
    { startMs: 12_000, endMs: 27_000 },
  ]);
  assert.equal(b.ms, 6000);
});

test('overlapping speech ends a stretch, and at most eight speakers get a clip', () => {
  const words = [said('A', 0, 6000), said('B', 5000, 12_000)];
  const clips = chooseClips(words);
  assert.deepEqual(clips.find((c) => c.speaker === 'A').pieces, [{ startMs: 0, endMs: 5000 }]);
  const many = Array.from({ length: 10 }, (_, i) => said(`S${i}`, i * 10_000, i * 10_000 + 6000 + i * 100));
  const kept = chooseClips(many);
  assert.equal(kept.length, 8);
  assert.ok(!kept.some((c) => c.speaker === 'S0' || c.speaker === 'S1'), 'the speakers heard least are left out');
});

test('clips go first in a request, a second apart, then two seconds of silence before the part', () => {
  const layout = referenceLayout([
    {
      speaker: 'A',
      pieces: [
        { startMs: 1000, endMs: 4000 },
        { startMs: 9000, endMs: 11_000 },
      ],
    },
    { speaker: 'B', pieces: [{ startMs: 5000, endMs: 10_000 }] },
  ]);
  const aEnd = 3000 + PIECE_GAP_MS + 2000;
  assert.deepEqual(layout.entries[0], {
    speaker: 'A',
    startMs: 0,
    endMs: aEnd,
    pieces: [
      { fromMs: 1000, toMs: 4000, atMs: 0 },
      { fromMs: 9000, toMs: 11_000, atMs: 3000 + PIECE_GAP_MS },
    ],
  });
  assert.equal(layout.entries[1].startMs, aEnd + CLIP_GAP_MS);
  assert.equal(layout.refMs, aEnd + CLIP_GAP_MS + 5000 + LEAD_GAP_MS);
  assert.deepEqual(referenceLayout([]), { entries: [], refMs: 0 });
});

test('the audio of a request is the clips, silence and the part, copied across recordings', () => {
  const rate = 1000;
  const first = new Int16Array(3000).fill(1);
  const second = new Int16Array(3000).fill(2);
  const pieces = [{ samples: first }, { samples: second }];
  const layout = referenceLayout([{ speaker: 'A', pieces: [{ startMs: 2500, endMs: 3500 }] }]);
  const out = partAudio(pieces, { startMs: 4000, endMs: 6000 }, layout, rate);
  assert.equal(out.length, layout.refMs + 2000);
  assert.deepEqual(
    [...out.subarray(0, 1000)],
    [...Array(500).fill(1), ...Array(500).fill(2)],
    'a clip across two recordings',
  );
  assert.ok(
    out.subarray(1000, layout.refMs).every((s) => s === 0),
    'silence before the part',
  );
  assert.ok(out.subarray(layout.refMs).every((s) => s === 2));
});

// ---------- one part's answer ----------

const twoClips = () =>
  referenceLayout([
    { speaker: 'A', pieces: [{ startMs: 0, endMs: 10_000 }] },
    { speaker: 'B', pieces: [{ startMs: 20_000, endMs: 30_000 }] },
  ]);

test('labels of a part are mapped through the clips, and its times shifted back by the clips', () => {
  const layout = twoClips();
  const part = { startMs: 24 * MIN, endMs: 30 * MIN };
  const words = [
    ...run('spk:1', 0, 10_000), // A's clip
    ...run('spk:0', 11_000, 10_000), // B's clip
    word(layout.refMs + 1000, layout.refMs + 1400, 'spk:0'),
    word(layout.refMs + 2000, layout.refMs + 2400, 'spk:1'),
  ];
  let n = 2;
  const result = resolvePart(words, layout, part, { newSpeaker: () => `p${++n}` });
  assert.deepEqual(result.mapping, { 'spk:1': 'A', 'spk:0': 'B' });
  assert.deepEqual(result.words, [
    said('B', part.startMs + 1000, part.startMs + 1400),
    said('A', part.startMs + 2000, part.startMs + 2400),
  ]);
  assert.deepEqual(result.added, []);
  assert.equal(result.uncertain, false);
  assert.ok(result.clips.every((c) => c.ok && c.share === 1));
});

test('a label no clip matches is a new speaker', () => {
  const layout = twoClips();
  const words = [
    ...run('spk:0', 0, 10_000),
    ...run('spk:1', 11_000, 10_000),
    word(layout.refMs + 500, layout.refMs + 900, 'spk:2'),
  ];
  let n = 2;
  const result = resolvePart(words, layout, { startMs: 0, endMs: MIN }, { newSpeaker: () => `p${++n}` });
  assert.deepEqual(result.added, ['p3']);
  assert.equal(result.words[0].speaker, 'p3');
  assert.equal(result.uncertain, false);
});

test('a clip whose words are split between labels is not guessed: its speaker is unknown in that part', () => {
  const layout = twoClips();
  const words = [
    ...run('spk:0', 0, 6000), // 60 % of A's clip
    ...run('spk:2', 6000, 4000), // 40 %
    ...run('spk:1', 11_000, 10_000),
    word(layout.refMs + 100, layout.refMs + 500, 'spk:0'),
    word(layout.refMs + 600, layout.refMs + 900, 'spk:2'),
    word(layout.refMs + 1000, layout.refMs + 1400, 'spk:1'),
  ];
  const result = resolvePart(
    words,
    layout,
    { startMs: 0, endMs: MIN },
    { newSpeaker: () => assert.fail('no new speaker') },
  );
  const a = result.clips.find((c) => c.speaker === 'A');
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'split');
  assert.equal(a.share, 0.6);
  assert.deepEqual(
    result.words.map((w) => w.speaker),
    [null, null, 'B'],
  );
  assert.equal(result.uncertain, true);
});

test('two clips given the same label are both left unknown', () => {
  const layout = twoClips();
  const words = [
    ...run('spk:0', 0, 10_000),
    ...run('spk:0', 11_000, 10_000),
    word(layout.refMs, layout.refMs + 400, 'spk:0'),
  ];
  const result = resolvePart(
    words,
    layout,
    { startMs: 0, endMs: MIN },
    { newSpeaker: () => assert.fail('no new speaker') },
  );
  assert.deepEqual(
    result.clips.map((c) => c.reason),
    ['clash', 'clash'],
  );
  assert.equal(result.words[0].speaker, null);
  assert.equal(result.uncertain, true);
});

test('when the overlap with the previous part clearly contradicts the clips, the overlap decides', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  // Earlier, A was speaking in the first ten seconds of this part; here that speech has B's clip label.
  const previous = [said('A', part.startMs, part.startMs + 10_000)];
  const words = [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:1', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => 'p9' });
  assert.deepEqual(result.mapping, { 'spk:1': 'A' }, "A's clip label is not heard in the part, so it maps nothing");
  assert.ok(result.words.every((w) => w.speaker === 'A'));
  assert.deepEqual(result.overlap, { compared: 1, agreed: true });
  assert.equal(result.uncertain, false);

  const agreeing = resolvePart(
    [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:0', layout.refMs, 10_000)],
    layout,
    part,
    {
      previous,
      newSpeaker: () => 'p9',
    },
  );
  assert.deepEqual(agreeing.overlap, { compared: 1, agreed: true });
  assert.equal(agreeing.uncertain, false);
});

test('without earlier words, a part is decided by its clips alone, as before', () => {
  const layout = twoClips();
  const words = [...run('spk:1', 0, 10_000), ...run('spk:0', 11_000, 10_000), ...run('spk:0', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, { startMs: 0, endMs: MIN }, { newSpeaker: () => 'p9' });
  assert.deepEqual(
    result.labels.map((l) => [l.label, l.speaker, l.by]),
    [
      ['spk:1', 'A', 'clip'],
      ['spk:0', 'B', 'clip'],
    ],
  );
  assert.deepEqual(result.overlap, { compared: 0, agreed: null });
  assert.equal(result.uncertain, false);
});

test('an overlap that agrees with the clips decides the label, and the part is certain', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  const previous = [said('A', part.startMs, part.startMs + 10_000)];
  const words = [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:0', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => 'p9' });
  const label = result.labels.find((l) => l.label === 'spk:0');
  assert.deepEqual(label, { label: 'spk:0', speaker: 'A', by: 'overlap', overlapWords: 25, overlapShare: 1 });
  assert.ok(label.overlapWords >= MIN_OVERLAP_DECIDE_WORDS && label.overlapShare >= MIN_OVERLAP_DECIDE_SHARE);
  assert.equal(result.mapping['spk:1'], 'B', 'the other label by its clip');
  assert.equal(result.uncertain, false);
});

test('an overlap that contradicts the clips without being clear leaves the label unknown and the part uncertain', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  // A was heard for only two seconds of the overlap: a handful of words, below the bar.
  const previous = [said('A', part.startMs, part.startMs + 2000)];
  const words = [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:1', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => assert.fail('no new speaker') });
  const label = result.labels.find((l) => l.label === 'spk:1');
  assert.equal(label.by, 'unknown');
  assert.equal(label.speaker, null);
  assert.ok(label.overlapWords >= MIN_OVERLAP_WORDS && label.overlapWords < MIN_OVERLAP_DECIDE_WORDS);
  assert.ok(
    result.words.every((w) => w.speaker === null),
    'neither the clip nor a guess',
  );
  assert.equal(result.uncertain, true);
});

test('when the earlier words of the overlap have no speaker, the clips decide as before', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  const previous = [said(null, part.startMs, part.startMs + 30_000)];
  const words = [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:1', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => 'p9' });
  assert.deepEqual(result.mapping, { 'spk:0': 'A', 'spk:1': 'B' });
  assert.ok(result.words.every((w) => w.speaker === 'B'));
  assert.deepEqual(result.overlap, { compared: 0, agreed: null });
  assert.equal(result.uncertain, false);
});

test('a speaker silent in the overlap is still found by the clip, beside a label the overlap decides', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  const previous = [said('A', part.startMs, part.startMs + 10_000)];
  const words = [
    ...run('spk:0', 0, 10_000),
    ...run('spk:1', 11_000, 10_000),
    ...run('spk:0', layout.refMs, 10_000), // A, in the overlap
    ...run('spk:1', layout.refMs + 2 * MIN, 10_000), // B, only after it
  ];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => assert.fail('no new speaker') });
  assert.deepEqual(
    result.labels.map((l) => [l.label, l.speaker, l.by]),
    [
      ['spk:0', 'A', 'overlap'],
      ['spk:1', 'B', 'clip'],
    ],
  );
  assert.equal(result.uncertain, false);
});

test('two labels claiming one speaker through the overlap and a clip: the overlap wins, the other is unknown', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  const previous = [said('A', part.startMs, part.startMs + 10_000)];
  const words = [
    ...run('spk:0', 0, 10_000), // A's clip
    ...run('spk:1', 11_000, 10_000), // B's clip
    ...run('spk:1', layout.refMs, 10_000), // the overlap says this is A
    ...run('spk:0', layout.refMs + 2 * MIN, 10_000), // A's clip label, heard after the overlap
  ];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => assert.fail('no new speaker') });
  assert.deepEqual(result.mapping, { 'spk:1': 'A', 'spk:0': null });
  assert.equal(result.labels.find((l) => l.label === 'spk:0').by, 'unknown');
  assert.equal(result.uncertain, true);
});

test('parts are joined at the middle of their overlap', () => {
  const sofar = [said('A', 0, 1000), said('A', 24.2 * MIN, 24.2 * MIN + 400), said('A', 24.8 * MIN, 24.8 * MIN + 400)];
  const next = [
    said('B', 24.2 * MIN, 24.2 * MIN + 400),
    said('B', 24.8 * MIN, 24.8 * MIN + 400),
    said('B', 30 * MIN, 30 * MIN + 400),
  ];
  assert.deepEqual(
    mergeWords(sofar, next, 24 * MIN, 25 * MIN).map((w) => [w.speaker, w.startMs]),
    [
      ['A', 0],
      ['A', 24.2 * MIN],
      ['B', 24.8 * MIN],
      ['B', 30 * MIN],
    ],
  );
});

test('speakers are numbered in the order they are first heard', () => {
  const { speakers, words } = numberSpeakers([said('p2', 0, 1), said(null, 2, 3), said('p1', 4, 5), said('p2', 6, 7)]);
  assert.deepEqual(speakers, [
    { id: 's1', name: '' },
    { id: 's2', name: '' },
  ]);
  assert.deepEqual(
    words.map((w) => w.speaker),
    ['s1', null, 's2', 's1'],
  );
});

// ---------- whole recordings (with the stand-in service) ----------

test('a short recording is labelled in one request without reference clips', async () => {
  const { pieces, truth } = synthAudio(cycle([0, 1], 10, 12_000));
  const service = fakeDiarizer();
  const result = await labelSpeakers({ pieces, rate: RATE, diarizer: service });
  assert.equal(service.uploads.length, 1);
  assert.equal(service.uploads[0].samples.length, pieces[0].samples.length, 'only the recording is sent');
  assert.equal(result.speakers.length, 2);
  assert.equal(result.uncertain, false);
  const ids = assertConsistent(result, truth);
  assert.deepEqual([...ids.values()], ['s1', 's2']);
});

test('across several parts each speaker keeps one label, however the service numbers them', async () => {
  const { pieces, truth, totalMs } = synthAudio(cycle([0, 1, 2], 240));
  assert.ok(totalMs > 60 * MIN);
  const service = fakeDiarizer();
  const parts = [];
  const result = await labelSpeakers({ pieces, rate: RATE, diarizer: service, onPart: (r) => parts.push(r) });
  assert.equal(service.uploads.length, 3);
  assert.equal(result.speakers.length, 3);
  assert.equal(result.uncertain, false);
  assertConsistent(result, truth);
  assert.ok(parts.slice(1).every((p) => p.clips.length === 3 && p.clips.every((c) => c.ok && c.share === 1)));
  assert.ok(parts.slice(1).every((p) => p.overlap.agreed === true));
  assert.deepEqual(service.removed, service.analyzed, 'every upload is deleted');
});

test('a speaker silent during the overlap is still recognised in the next part by the clip', async () => {
  // C speaks in the first part only, then not again until well into the second.
  const turns = [...cycle([0, 1, 2], 30), ...cycle([0, 1], 110), ...cycle([2, 0, 1], 30)];
  const { pieces, truth } = synthAudio(turns);
  const service = fakeDiarizer();
  const result = await labelSpeakers({ pieces, rate: RATE, diarizer: service });
  assert.ok(service.uploads.length >= 2);
  assert.equal(result.speakers.length, 3);
  assertConsistent(result, truth);
});

test('a speaker first heard in a later part is a new speaker', async () => {
  const turns = [...cycle([0, 1], 110), ...cycle([0, 1, 3], 30)];
  const { pieces, truth } = synthAudio(turns);
  const result = await labelSpeakers({ pieces, rate: RATE, diarizer: fakeDiarizer() });
  assert.equal(result.speakers.length, 3);
  const ids = assertConsistent(result, truth);
  assert.equal(ids.get(3), 's3');
});

// ---------- segments ----------

test('each line gets the speaker with the most speaking time in its span of the recording', () => {
  const timeline = recordingTimeline([{ elapsedStart: 0, durationMs: 30_000 }]);
  const lead = SEGMENT_LEAD_MS;
  const segments = [{ elapsed: lead }, { elapsed: 10_000 + lead }, { elapsed: 20_000 + lead }];
  const words = [
    said('s1', 0, 6000),
    said('s2', 6000, 10_000), // less than s1 in the first line
    said('s2', 10_000, 15_000),
    said('s1', 15_000, 20_000), // as long as s2: a tie
  ];
  assert.deepEqual(assignSpeakers(segments, words, timeline), ['s1', null, null]);
});

test('lines outside every recording get no speaker, and later recordings are found by their start', () => {
  // Recorded from 0 to 10 s and, after a stop and a start without recording, from 20 s to 30 s of
  // the session's time; in audio time the second recording follows the first at 10 s.
  const timeline = recordingTimeline([
    { elapsedStart: 0, durationMs: 10_000 },
    { elapsedStart: 20_000, durationMs: 10_000 },
  ]);
  assert.deepEqual(timeline[1], { elapsedStart: 20_000, durationMs: 10_000, audioStartMs: 10_000 });
  const segments = [{ elapsed: 2000 }, { elapsed: 12_000 }, { elapsed: 22_000 }, { elapsed: 40_000 }];
  assert.deepEqual(segmentSpans(segments, timeline), [
    { startMs: 1000, endMs: 10_000 },
    null,
    { startMs: 11_000, endMs: 20_000 },
    null,
  ]);
  const words = [said('s1', 3000, 5000), said('s2', 12_000, 15_000)];
  assert.deepEqual(assignSpeakers(segments, words, timeline), ['s1', null, 's2', null]);
});

test('a line with no words in its span has no speaker', () => {
  const timeline = recordingTimeline([{ elapsedStart: 0, durationMs: 20_000 }]);
  assert.deepEqual(assignSpeakers([{ elapsed: 5000 }], [said(null, 4000, 6000)], timeline), [null]);
  assert.deepEqual(assignSpeakers([{ elapsed: 5000 }], [], timeline), [null]);
});

// ---------- WAV ----------

test('a WAV part is 16-bit mono with a correct header and length', () => {
  const samples = toInt16(new Float32Array([0, 1, -1, 0.5, 2]));
  assert.deepEqual([...samples], [0, 32767, -32768, 16384, 32767]);
  const bytes = wavBytes(samples, 16_000);
  assert.equal(bytes.length, 44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  assert.equal(text(0), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(text(8), 'WAVE');
  assert.equal(text(12), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36), 'data');
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.getInt16(44 + 2, true), 32767);
  // 25 minutes at 16 kHz: about 48 MB.
  assert.equal(44 + (PART_MAX_MS / 1000) * 16_000 * 2, 48_000_044);
  assert.ok(OVERLAP_MS < PART_MAX_MS);
});
