import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelSpeakers } from '../../../../src/session/diarizer.js';
import {
  assignSpeakers,
  CLIP_GAP_MS,
  CLIP_MS,
  chooseClips,
  LEAD_GAP_MS,
  mergeWords,
  numberSpeakers,
  OVERLAP_MS,
  PART_MAX_MS,
  PIECE_GAP_MS,
  parseSeconds,
  partAudio,
  planParts,
  recordingTimeline,
  referenceLayout,
  resolvePart,
  SEGMENT_LEAD_MS,
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

test('word annotations are found wherever they are in the answer, without their text', () => {
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
    word(500, 1000, 'spk:0'),
    word(2000, 2500, 'spk:1'),
    word(3000, 3000, 'spk:0'),
  ]);
});

test('word annotations without a speaker or a readable start are left out', () => {
  const answer = [
    { type: 'word_info', start_offset: '1s', end_offset: '2s' },
    { type: 'word_info', speaker: 'spk:0', start_offset: 'soon', end_offset: '2s' },
    { type: 'word_info', speaker: 'spk:0', start_offset: '4s', end_offset: '3s' },
  ];
  assert.deepEqual(wordsFromAnswer(answer), [word(4000, 4000, 'spk:0')]);
  assert.deepEqual(wordsFromAnswer(null), []);
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

test('when the overlap with the previous part contradicts the clips, the part is uncertain', () => {
  const layout = twoClips();
  const part = { startMs: 10 * MIN, endMs: 20 * MIN };
  // Earlier, A was speaking in the first ten seconds of this part; here that speech is labelled B.
  const previous = [said('A', part.startMs, part.startMs + 10_000)];
  const words = [...run('spk:0', 0, 10_000), ...run('spk:1', 11_000, 10_000), ...run('spk:1', layout.refMs, 10_000)];
  const result = resolvePart(words, layout, part, { previous, newSpeaker: () => 'p9' });
  assert.deepEqual(result.overlap, { compared: 1, agreed: false });
  assert.equal(result.uncertain, true);

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
