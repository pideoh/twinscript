import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregate,
  erased,
  formatHealth,
  formatTable,
  health,
  mean,
  median,
  percentile,
  sentenceMetrics,
} from '../scripts/tuning/metrics.mjs';

test('erased counts the characters of the previous text that are not kept as its start', () => {
  assert.equal(erased('', 'Good'), 0);
  assert.equal(erased('Good', 'Good morning'), 0);
  assert.equal(erased('Good morning', 'Good evening'), 7);
  assert.equal(erased('おはよう', 'おやすみ'), 3, 'counts characters, not bytes');
  assert.equal(erased('abc', ''), 3);
});

test('flicker of a sentence, computed by hand', () => {
  // Shown over time              erased
  //   "I think"                   0
  //   "I think it is"             0   it only grows
  //   "I believe it is good"     11   shares "I " (2) with the 13 characters before: 13 - 2
  //   "I believe it is good."     0   it only grows
  // flicker = 11 erased / 21 characters of the final translation.
  const displays = [
    { t: 1000, text: 'I think' },
    { t: 2500, text: 'I think it is' },
    { t: 4000, text: 'I believe it is good' },
    { t: 4000, text: 'I believe it is good' }, // the same text again is not an update
    { t: 5000, text: 'I believe it is good.' },
  ];
  const m = sentenceMetrics({
    firstInterimAt: 400,
    finishedAt: 4600,
    finalShownAt: 5000,
    finalText: 'I believe it is good.',
    displays,
  });
  assert.equal(m.erasedChars, 11);
  assert.equal(m.updates, 4);
  assert.equal(m.flicker, 11 / 21);
  assert.equal(m.firstDelayMs, 600);
  assert.equal(m.finalDelayMs, 400);
});

test('a sentence finished without in-progress text has no first delay', () => {
  const m = sentenceMetrics({
    firstInterimAt: null,
    finishedAt: 100,
    finalShownAt: 500,
    finalText: 'Hi there',
    displays: [{ t: 500, text: 'Hi there' }],
  });
  assert.equal(m.firstDelayMs, null);
  assert.equal(m.finalDelayMs, 400);
  assert.equal(m.flicker, 0);
});

test('a sentence whose final translation never came has no final delay', () => {
  const m = sentenceMetrics({ firstInterimAt: 0, finishedAt: 100, finalText: null, displays: [] });
  assert.equal(m.firstDelayMs, null);
  assert.equal(m.finalDelayMs, null);
  assert.equal(m.updates, 0);
});

test('mean, median and nearest-rank p90', () => {
  assert.equal(mean([1, 2, 3, 10]), 4);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(ten, 90), 90);
  assert.equal(percentile([5], 90), 5);
  assert.equal(mean([]), null);
});

test('aggregate skips missing values and sums counts; the table has one row per run', () => {
  const rows = [
    { firstDelayMs: 100, finalDelayMs: 400, flicker: 0, erasedChars: 0, updates: 1 },
    { firstDelayMs: null, finalDelayMs: 600, flicker: 0.5, erasedChars: 4, updates: 3 },
  ];
  const a = aggregate(rows, { requests: 5, rateLimited: 1 });
  assert.equal(a.sentences, 2);
  assert.deepEqual(a.firstDelayMs, { n: 1, mean: 100, median: 100, p90: 100 });
  assert.equal(a.finalDelayMs.mean, 500);
  assert.equal(a.erasedChars, 4);
  assert.equal(a.updates, 4);
  assert.equal(a.requests, 5);
  assert.equal(a.rateLimited, 1);
  const table = formatTable([{ label: 'interval 1.5s', summary: a }]).split('\n');
  assert.equal(table.length, 2);
  assert.match(table[1], /^interval 1\.5s\s+2\s+100\/100\/100\s+500\/500\/600\s+0\.25\/0\.25\/0\.50\s+4\s+4\s+5\s+1$/);
});

test('the health of a run: failed requests, answer times and sentences that showed a live translation', () => {
  const sentences = [
    { finishedAt: 3000, displays: [{ t: 1200 }, { t: 3400 }] }, // translated while spoken
    { finishedAt: 6000, displays: [{ t: 6500 }] }, // only the final translation
    { finishedAt: 9000, displays: [] },
  ];
  const h = health(sentences, { failed: 2, lastError: 'HTTP 400:\n bad  request', answerMs: [400, 600, 2000] });
  assert.equal(h.failed, 2);
  assert.equal(h.liveSentences, 1);
  assert.equal(h.sentences, 3);
  assert.equal(h.answerMs.mean, 1000);
  assert.deepEqual(formatHealth([{ label: 'carry 1.5s', health: h }]).split('\n'), [
    'strategy    failed  answer ms mean/med/p90  live  last error',
    'carry 1.5s  2       1000/600/2000           1/3   HTTP 400: bad request',
  ]);
});
