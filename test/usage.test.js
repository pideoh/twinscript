import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addListening, addTokens, addUsage, emptyUsage, USAGE_VERSION, usageFromMetadata } from '../src/usage.js';

const LIVE = 'gemini-3.5-transcribe-live';
const LITE = 'gemini-3.5-flash-lite';

test('a new usage record is empty, versioned and plain JSON', () => {
  const usage = emptyUsage();
  assert.deepEqual(usage, { version: USAGE_VERSION, transcription: {}, translation: {}, summary: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(usage)), usage);
});

test('thinking tokens count as output', () => {
  assert.deepEqual(usageFromMetadata({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 }), {
    inputTokens: 10,
    outputTokens: 12,
  });
});

test('missing or unusable token counts count as zero', () => {
  for (const md of [undefined, null, 'x', 3, {}]) {
    assert.deepEqual(usageFromMetadata(md), { inputTokens: 0, outputTokens: 0 });
  }
  assert.deepEqual(usageFromMetadata({ promptTokenCount: 4, candidatesTokenCount: '9', thoughtsTokenCount: -1 }), {
    inputTokens: 4,
    outputTokens: 0,
  });
  assert.deepEqual(usageFromMetadata({ promptTokenCount: Number.NaN, candidatesTokenCount: 3 }), {
    inputTokens: 0,
    outputTokens: 3,
  });
});

test('each response adds a request and its tokens to its kind and model, leaving the old record as it was', () => {
  const start = emptyUsage();
  const one = addTokens(start, 'translation', LITE, { promptTokenCount: 100, candidatesTokenCount: 20 });
  const two = addTokens(one, 'translation', LITE, { promptTokenCount: 50, candidatesTokenCount: 10 });
  const three = addTokens(two, 'summary', LITE, { promptTokenCount: 900, thoughtsTokenCount: 30 });
  assert.deepEqual(start, emptyUsage());
  assert.deepEqual(one.translation[LITE], { requests: 1, inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(three.translation[LITE], { requests: 2, inputTokens: 150, outputTokens: 30 });
  assert.deepEqual(three.summary[LITE], { requests: 1, inputTokens: 900, outputTokens: 30 });
  assert.deepEqual(three.transcription, {});
  assert.throws(() => addTokens(start, 'transcription', LITE, {}), TypeError);
  assert.throws(() => addTokens(start, 'translation', '', {}), TypeError);
});

test('listening time adds up per transcription model', () => {
  let usage = addListening(emptyUsage(), LIVE, 1500);
  usage = addListening(usage, LIVE, 2500);
  usage = addListening(usage, LIVE, 0);
  assert.deepEqual(usage.transcription, { [LIVE]: { listeningMs: 4000 } });
  for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
    assert.throws(() => addListening(usage, LIVE, ms), RangeError, String(ms));
  }
});

test('sessions add up to a total, including partial and stored records', () => {
  const a = addListening(addTokens(emptyUsage(), 'translation', LITE, { promptTokenCount: 10 }), LIVE, 1000);
  const b = addTokens(addListening(emptyUsage(), LIVE, 2000), 'translation', 'other-model', { promptTokenCount: 5 });
  const total = addUsage(a, JSON.parse(JSON.stringify(b)));
  assert.deepEqual(total, {
    version: USAGE_VERSION,
    transcription: { [LIVE]: { listeningMs: 3000 } },
    translation: {
      [LITE]: { requests: 1, inputTokens: 10, outputTokens: 0 },
      'other-model': { requests: 1, inputTokens: 5, outputTokens: 0 },
    },
    summary: {},
  });
  assert.deepEqual(addUsage(a, undefined), a);
  assert.deepEqual(addUsage({ translation: { [LITE]: { requests: 2 } } }, {}).translation[LITE], {
    requests: 2,
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.deepEqual([emptyUsage(), a, b].reduce(addUsage, emptyUsage()), total);
  assert.throws(() => addUsage(a, { version: USAGE_VERSION + 1 }), RangeError);
});
