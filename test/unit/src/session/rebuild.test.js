import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRebuilt,
  applyRestored,
  canRebuild,
  canRestore,
  keepNames,
  madeBeforeChange,
  putBack,
  snapshot,
  transcriptOf,
} from '../../../../src/session/rebuild.js';

const recorded = (extra = {}) => ({
  id: 's',
  title: 'Shall we start with',
  customTitle: false,
  segments: [{ id: 'a', elapsed: 1000, src: 'Shall we start with the budget?', tgt: '予算から？' }],
  recordings: [{ id: 'r1', elapsedStart: 0, durationMs: 20_000 }],
  ...extra,
});

test('rebuilding is offered for a stopped session with a recording, also one without lines, in the demo too', () => {
  assert.equal(canRebuild(recorded(), false), true);
  assert.equal(canRebuild(recorded({ segments: [] }), false), true, 'a recording whose live transcript is empty');
  assert.equal(canRebuild(recorded(), true), false, 'not while listening');
  assert.equal(canRebuild(recorded(), false, true), true, 'the demo flag the rule once took changes nothing');
  assert.equal(canRebuild(recorded({ recordings: [] }), false), false, 'no recording');
  assert.equal(canRebuild(recorded({ recordings: [{ id: 'r', durationMs: 0 }] }), false), false, 'an empty one');
  assert.equal(canRebuild(null, false), false);
});

test('restoring is offered only while the transcript made while listening is kept, and not while listening', () => {
  assert.equal(canRestore(recorded(), false), false);
  assert.equal(canRestore(recorded({ rebuilt: { madeAt: 5 } }), false), true);
  assert.equal(canRestore(recorded({ rebuilt: { madeAt: 5 } }), true), false);
});

test('what was made before the transcript was replaced is told apart from what was made after', () => {
  const sess = recorded({ transcriptChangedAt: 100 });
  assert.equal(madeBeforeChange(sess, 99), true);
  assert.equal(madeBeforeChange(sess, 100), false);
  assert.equal(madeBeforeChange(sess, 150), false);
  assert.equal(madeBeforeChange(recorded(), 99), false, 'never replaced');
});

const labels = { speakers: [{ id: 's1', name: 'Aiko' }], madeAt: 3, uncertain: false, model: 'm' };
const rebuiltLines = [
  { id: 'n1', elapsed: 900, src: 'Shall we start with the budget?', tgt: 'X', speaker: 's1' },
  { id: 'n2', elapsed: 4000, src: 'Yes.', tgt: 'Y', speaker: 's2' },
];
const speakers = [
  { id: 's1', name: 'Aiko' },
  { id: 's2', name: '' },
];

test('a rebuild keeps the transcript made while listening, with its speakers, and takes its place; the title stays', () => {
  const sess = recorded({ speakerLabels: labels });
  const live = sess.segments;
  const kept = applyRebuilt(sess, { segments: rebuiltLines, speakers, uncertain: true, model: 'tx', now: 50 });
  assert.deepEqual(kept, { segments: live, speakerLabels: labels, keptAt: 50 });
  assert.equal(sess.segments, rebuiltLines);
  assert.deepEqual(sess.speakerLabels, { speakers, madeAt: 50, uncertain: true, model: 'tx' });
  assert.deepEqual(sess.rebuilt, { madeAt: 50, model: 'tx' });
  assert.equal(sess.transcriptChangedAt, 50);
  assert.equal(sess.title, 'Shall we start with');
  assert.equal(sess.customTitle, true, 'not made again from the new first line');
});

test('rebuilding a rebuilt transcript keeps the one made while listening as it is', () => {
  const sess = recorded({ rebuilt: { madeAt: 10, model: 'tx' } });
  assert.equal(applyRebuilt(sess, { segments: rebuiltLines, speakers: [], model: 'tx', now: 60 }), undefined);
  assert.equal(sess.speakerLabels, undefined, 'no speakers told apart: no labels');
  assert.equal(sess.rebuilt.madeAt, 60);
});

test('restoring puts the kept transcript back with its speakers and drops the rebuilt one', () => {
  const sess = recorded({ speakerLabels: labels });
  const kept = applyRebuilt(sess, { segments: rebuiltLines, speakers, model: 'tx', now: 50 });
  applyRestored(sess, kept, 70);
  assert.deepEqual(transcriptOf(sess), { segments: kept.segments, speakerLabels: labels });
  assert.equal(sess.rebuilt, undefined);
  assert.equal(sess.transcriptChangedAt, 70);
  applyRestored(sess, { segments: [], speakerLabels: null }, 80);
  assert.equal(sess.speakerLabels, undefined);
});

test('a swap that cannot be saved is put back exactly, fields that were absent included', () => {
  const sess = recorded();
  const before = structuredClone(sess);
  const snap = snapshot(sess);
  applyRebuilt(sess, { segments: rebuiltLines, speakers, model: 'tx', now: 50 });
  putBack(sess, snap);
  assert.deepEqual(sess, before);
});

// ---------- names ----------

// An earlier transcript of a 20-second recording: Aiko speaks the first and third lines, Ben the
// second and fourth (lines five seconds apart).
const earlier = {
  segments: [
    { elapsed: 1000, speaker: 'a' },
    { elapsed: 6000, speaker: 'b' },
    { elapsed: 11_000, speaker: 'a' },
    { elapsed: 16_000, speaker: 'b' },
  ],
  speakerLabels: {
    speakers: [
      { id: 'a', name: 'Aiko' },
      { id: 'b', name: 'Ben' },
    ],
  },
};
const recordings = [{ elapsedStart: 0, durationMs: 20_000 }];
// Words of `speaker` every half second over [fromMs, toMs).
const wordsOf = (speaker, fromMs, toMs) =>
  Array.from({ length: (toMs - fromMs) / 500 }, (_, i) => ({
    startMs: fromMs + i * 500,
    endMs: fromMs + i * 500 + 400,
    speaker,
  }));
const two = [
  { id: 's1', name: '' },
  { id: 's2', name: '' },
];

test('names carry over to the new speakers that match the earlier ones', () => {
  const words = [
    ...wordsOf('s1', 0, 5000),
    ...wordsOf('s2', 5000, 10_000),
    ...wordsOf('s1', 10_000, 15_000),
    ...wordsOf('s2', 15_000, 20_000),
  ];
  assert.deepEqual(keepNames(earlier, { speakers: two, words, recordings }), [
    { id: 's1', name: 'Aiko' },
    { id: 's2', name: 'Ben' },
  ]);
});

test('a new speaker heard about as much in both earlier speakers lines gets no name', () => {
  const words = [...wordsOf('s1', 0, 10_000), ...wordsOf('s2', 10_000, 15_000)];
  assert.deepEqual(keepNames(earlier, { speakers: two, words, recordings }), [
    { id: 's1', name: '' },
    { id: 's2', name: 'Aiko' },
  ]);
});

test('two new speakers that both match one earlier speaker get no name: which one it is cannot be told', () => {
  const words = [...wordsOf('s1', 0, 4000), ...wordsOf('s2', 10_000, 14_000)];
  assert.deepEqual(keepNames(earlier, { speakers: two, words, recordings }), two);
});

test('a speaker heard for too few words is not matched; unnamed earlier speakers give nothing', () => {
  const words = [...wordsOf('s1', 0, 1000), ...wordsOf('s2', 5000, 10_000)];
  assert.deepEqual(keepNames(earlier, { speakers: two, words, recordings }), [
    { id: 's1', name: '' },
    { id: 's2', name: 'Ben' },
  ]);
  const unnamed = { ...earlier, speakerLabels: { speakers: [{ id: 'a', name: '' }] } };
  assert.deepEqual(keepNames(unnamed, { speakers: two, words, recordings }), two);
  assert.deepEqual(keepNames({ segments: [], speakerLabels: null }, { speakers: two, words, recordings }), two);
});
