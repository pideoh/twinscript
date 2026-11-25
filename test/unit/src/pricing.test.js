import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, formatUsd, isValidPrice, mergePrices, PRICES } from '../../../src/pricing.js';
import { addListening, addTokens, emptyUsage } from '../../../src/usage.js';

const LIVE = 'gemini-3.5-transcribe-live';
const LITE = 'gemini-3.5-flash-lite';

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ''} ${actual} != ${expected}`);
}

test('the price table holds the published paid-tier prices of the models the app uses', () => {
  assert.equal(PRICES.currency, 'USD');
  assert.match(PRICES.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(PRICES.source, 'https://ai.google.dev/gemini-api/docs/pricing');
  assert.deepEqual(PRICES.models[LIVE], { input: 3.5, output: 21, inputPerMinute: 0.005, outputPerMinute: 0.004 });
  assert.deepEqual(PRICES.models[LITE], { input: 0.3, output: 2.5 });
});

test('an hour of listening costs 60 minutes at the per-minute input and output prices', () => {
  const cost = costOf(addListening(emptyUsage(), LIVE, 60 * 60 * 1000));
  close(cost.transcription.usd, 0.54); // 60 x ($0.005 + $0.004)
  assert.deepEqual(cost.transcription.unpriced, []);
  close(cost.total.usd, 0.54);
  assert.equal(cost.currency, 'USD');
});

test('translation and summary cost their input and output tokens, thinking included', () => {
  let usage = emptyUsage();
  usage = addTokens(usage, 'translation', LITE, { promptTokenCount: 100_000, candidatesTokenCount: 20_000 });
  usage = addTokens(usage, 'translation', LITE, { promptTokenCount: 20_000, candidatesTokenCount: 10_000 });
  usage = addTokens(usage, 'summary', LITE, {
    promptTokenCount: 8_000,
    candidatesTokenCount: 800,
    thoughtsTokenCount: 400,
  });
  usage = addListening(usage, LIVE, 60 * 60 * 1000);
  const cost = costOf(usage);
  close(cost.translation.usd, 0.111); // 120,000 x $0.30 / 1M + 30,000 x $2.50 / 1M = 0.036 + 0.075
  close(cost.summary.usd, 0.0054); // 8,000 x $0.30 / 1M + 1,200 x $2.50 / 1M = 0.0024 + 0.003
  close(cost.total.usd, 0.6564);
  close(cost.total.byModel[LITE], 0.1164);
  close(cost.total.byModel[LIVE], 0.54);
  assert.equal(formatUsd(cost.total.usd), '$0.66');
});

test('a model without a price is reported as having no price, not as free', () => {
  let usage = addTokens(emptyUsage(), 'translation', 'gemini-9-unknown', { promptTokenCount: 1000 });
  usage = addTokens(usage, 'translation', LITE, { promptTokenCount: 1_000_000 });
  usage = addListening(usage, 'gemini-9-live', 60_000);
  const cost = costOf(usage);
  assert.deepEqual(cost.translation.unpriced, ['gemini-9-unknown']);
  assert.equal(cost.translation.byModel['gemini-9-unknown'], null);
  close(cost.translation.usd, 0.3);
  assert.deepEqual(cost.transcription.unpriced, ['gemini-9-live']);
  assert.equal(cost.transcription.usd, 0);
  assert.deepEqual(cost.total.unpriced, ['gemini-9-live', 'gemini-9-unknown']);
  assert.deepEqual(cost.summary, { usd: 0, unpriced: [], byModel: {} });
});

test('a token model used for listening has no per-minute price', () => {
  const cost = costOf(addListening(emptyUsage(), LITE, 60_000));
  assert.deepEqual(cost.transcription.unpriced, [LITE]);
});

test('individual prices can be overridden without changing the defaults', () => {
  const merged = mergePrices(PRICES, { [LITE]: { output: 3 }, 'gemini-9-unknown': { input: 1, output: 2 } });
  assert.deepEqual(merged.models[LITE], { input: 0.3, output: 3 });
  assert.deepEqual(merged.models['gemini-9-unknown'], { input: 1, output: 2 });
  assert.equal(PRICES.models[LITE].output, 2.5);
  assert.equal(merged.asOf, PRICES.asOf);
  const usage = addTokens(emptyUsage(), 'translation', LITE, { candidatesTokenCount: 1_000_000 });
  close(costOf(usage, merged).translation.usd, 3);
  assert.deepEqual(mergePrices(PRICES, { [LITE]: { input: undefined } }).models[LITE], PRICES.models[LITE]);
  assert.equal(mergePrices(PRICES, { [LITE]: { input: 0 } }).models[LITE].input, 0);
});

test('an override that is not a usable price is rejected', () => {
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '0.3', null]) {
    assert.throws(() => mergePrices(PRICES, { [LITE]: { input: value } }), RangeError, String(value));
    assert.equal(isValidPrice(value), false);
  }
  assert.throws(() => mergePrices(PRICES, { [LITE]: { cached: 1 } }), RangeError);
  assert.throws(() => mergePrices(PRICES, { [LITE]: 1 }), RangeError);
  assert.throws(() => mergePrices(PRICES, JSON.parse('{"__proto__": {"input": 1}}')), RangeError);
});

test('an empty or missing usage record costs nothing', () => {
  assert.equal(costOf(emptyUsage()).total.usd, 0);
  assert.equal(costOf(undefined).total.usd, 0);
});

test('amounts are shown without a false $0.00 for a cost above zero', () => {
  const cases = [
    [0, '$0.00'],
    [1.27, '$1.27'],
    [1.004, '$1.00'],
    [1234.567, '$1234.57'],
    [0.54, '$0.54'],
    [0.1, '$0.10'],
    [0.05, '$0.05'],
    [0.0042, '$0.0042'],
    [0.004, '$0.004'],
    [0.001234, '$0.0012'],
    [0.009999, '$0.01'],
    [0.996, '$1.00'],
    [0.000001, '$0.000001'],
    [1e-9, '<$0.000001'],
    [-0.5, '-$0.50'],
  ];
  for (const [amount, text] of cases) assert.equal(formatUsd(amount), text, String(amount));
  assert.throws(() => formatUsd(Number.NaN), TypeError);
  assert.throws(() => formatUsd(null), TypeError);
});
