import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICES } from '../../../../src/usage/pricing.js';
import { addTokens, emptyUsage } from '../../../../src/usage/usage.js';
import {
  createUsageLog,
  notAPrice,
  PRICE_UNITS,
  pendingOverrides,
  priceModels,
  pricesWith,
  priceText,
} from '../../../../src/usage/usage-log.js';
import { DAILY_KEY, dayKey, LIVE_MODEL } from '../../../../src/usage/usage-stats.js';

const TRANSLATION = 'gemini-3.5-flash-lite';
const DIARIZE = 'gemini-3.5-transcribe';
const NOW = new Date(2026, 10, 25, 12).getTime();

function memoryStorage(initial = {}) {
  const items = { ...initial };
  return {
    items,
    getItem: (name) => items[name] ?? null,
    setItem: (name, value) => {
      items[name] = value;
    },
  };
}
const throwingStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

function setup({ storage = memoryStorage(), demo = false, settings = { priceOverrides: {} }, now = NOW } = {}) {
  const saved = [];
  let recorded = 0;
  const log = createUsageLog({
    settings,
    storage,
    demo,
    isEmpty: (sess) => !sess.segments?.length,
    markDirty: (sess) => saved.push(sess),
    onRecorded: () => recorded++,
    now: () => now,
  });
  return { log, storage, saved, recorded: () => recorded };
}
const translation = (input, output) =>
  addTokens(emptyUsage(), 'translation', TRANSLATION, { promptTokenCount: input, candidatesTokenCount: output });
const blank = () => ({ activeMs: 0, segments: [], usage: emptyUsage() });

test('a request adds its tokens to its session and to the totals of the day, and the session is saved', () => {
  const { log, storage, saved, recorded } = setup();
  const sess = blank();
  log.recordUsage(sess, translation(100, 20));
  log.recordUsage(sess, translation(50, 10));
  assert.deepEqual(sess.usage.translation[TRANSLATION], { requests: 2, inputTokens: 150, outputTokens: 30 });
  const daily = JSON.parse(storage.items[DAILY_KEY]);
  assert.deepEqual(daily.days[dayKey(NOW)].translation[TRANSLATION], {
    requests: 2,
    inputTokens: 150,
    outputTokens: 30,
  });
  assert.deepEqual(saved, [sess, sess]);
  assert.equal(recorded(), 2, 'an open usage dialog is told each time');
  assert.equal(sess.demo, undefined);
});

test('the demo counts its made-up usage in its session only, never in the totals', () => {
  const { log, storage } = setup({ demo: true });
  const sess = blank();
  log.recordUsage(sess, translation(100, 20));
  assert.equal(sess.usage.translation[TRANSLATION].requests, 1);
  assert.equal(sess.demo, true);
  assert.equal(storage.items[DAILY_KEY], undefined);
  assert.deepEqual(log.readDailyTotals().days, {});
});

test('a session used before usage was counted is marked as known only in part; an unused one is not', () => {
  const { log } = setup();
  const old = { activeMs: 60_000, segments: [{ src: 'hello' }] };
  log.recordUsage(old, translation(1, 1));
  assert.equal(old.usagePartial, true);
  assert.equal(old.usage.translation[TRANSLATION].requests, 1);
  const fresh = { activeMs: 0, segments: [] };
  log.recordUsage(fresh, translation(1, 1));
  assert.equal(fresh.usagePartial, undefined);
});

test('a record written by a newer version stays as it was, and the totals still count the request', () => {
  const { log, storage } = setup();
  const newer = { version: 99, something: {} };
  const sess = { ...blank(), usage: newer };
  log.recordUsage(sess, translation(10, 1));
  assert.equal(sess.usage, newer);
  assert.equal(JSON.parse(storage.items[DAILY_KEY]).days[dayKey(NOW)].translation[TRANSLATION].requests, 1);
});

test('totals kept by a newer version are neither shown nor written over', () => {
  const stored = JSON.stringify({ version: 99, days: {} });
  const { log, storage } = setup({ storage: memoryStorage({ [DAILY_KEY]: stored }) });
  log.recordUsage(blank(), translation(10, 1));
  assert.equal(storage.items[DAILY_KEY], stored);
  assert.equal(log.readDailyTotals().readOnly, true);
});

test('with storage that cannot be used, the session still keeps its own record', () => {
  const { log, saved } = setup({ storage: throwingStorage });
  const sess = blank();
  log.recordUsage(sess, translation(10, 1));
  assert.equal(sess.usage.translation[TRANSLATION].requests, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(log.readDailyTotals().days, {});
});

test('listening time is counted up to now and goes on from there, only while connected', () => {
  let now = NOW;
  const saved = [];
  const log = createUsageLog({
    settings: { priceOverrides: {} },
    storage: memoryStorage(),
    isEmpty: () => true,
    markDirty: (sess) => saved.push(sess),
    now: () => now,
  });
  const r = { session: blank(), listeningSince: NOW - 5000 };
  log.accrueListening(r);
  assert.equal(r.session.usage.transcription[LIVE_MODEL].listeningMs, 5000);
  assert.equal(r.listeningSince, NOW);
  now += 2000;
  log.accrueListening(r);
  assert.equal(r.session.usage.transcription[LIVE_MODEL].listeningMs, 7000);
  r.listeningSince = 0; // not connected
  now += 10_000;
  log.accrueListening(r);
  assert.equal(r.session.usage.transcription[LIVE_MODEL].listeningMs, 7000);
  assert.equal(saved.length, 2);
});

test('estimates use the prices the user changed, and the defaults when the stored ones are not valid', () => {
  const settings = { priceOverrides: { [TRANSLATION]: { input: 1 } } };
  const { log } = setup({ settings });
  assert.equal(log.currentPrices().models[TRANSLATION].input, 1);
  assert.equal(log.currentPrices().models[TRANSLATION].output, PRICES.models[TRANSLATION].output);
  settings.priceOverrides = { [TRANSLATION]: { input: -3 } };
  assert.equal(log.currentPrices(), PRICES, 'read again each time, invalid ones ignored');
  assert.equal(pricesWith(undefined).models[TRANSLATION].input, PRICES.models[TRANSLATION].input);
});

test('the settings offer the prices of the live, translation and speaker-label models, each model once', () => {
  assert.deepEqual(priceModels(TRANSLATION, DIARIZE), [
    [LIVE_MODEL, PRICE_UNITS.listening],
    [TRANSLATION, PRICE_UNITS.tokens],
    [DIARIZE, PRICE_UNITS.tokens],
  ]);
  assert.deepEqual(priceModels(LIVE_MODEL, DIARIZE), [
    [LIVE_MODEL, [...PRICE_UNITS.listening, ...PRICE_UNITS.tokens]],
    [DIARIZE, PRICE_UNITS.tokens],
  ]);
  assert.deepEqual(priceModels(DIARIZE, DIARIZE), [
    [LIVE_MODEL, PRICE_UNITS.listening],
    [DIARIZE, PRICE_UNITS.tokens],
  ]);
});

test('a price field shows the price, or nothing for a model or field without one', () => {
  assert.equal(priceText(PRICES.models, TRANSLATION, 'input'), String(PRICES.models[TRANSLATION].input));
  assert.equal(priceText(PRICES.models, TRANSLATION, 'inputPerMinute'), '');
  assert.equal(priceText(PRICES.models, 'unknown-model', 'input'), '');
});

test('a price field accepts empty text and numbers of at least 0, with a decimal point or comma', () => {
  for (const text of ['', '  ', '0', '1.5', '1,5', ' 2 ']) assert.equal(notAPrice(text), false, text);
  for (const text of ['-1', 'abc', '1.2.3', '$1']) assert.equal(notAPrice(text), true, text);
});

test('typed prices become overrides; those of models not shown are kept unless Reset was pressed', () => {
  const stored = { 'old-model': { input: 9 } };
  const shown = { [TRANSLATION]: { input: '1', output: String(PRICES.models[TRANSLATION].output) } };
  assert.deepEqual(pendingOverrides(shown, stored, false), { [TRANSLATION]: { input: 1 }, 'old-model': { input: 9 } });
  assert.deepEqual(pendingOverrides(shown, stored, true), { [TRANSLATION]: { input: 1 } });
  assert.deepEqual(pendingOverrides({ [TRANSLATION]: { input: '' } }, undefined, false), {});
  assert.equal(pendingOverrides({ [TRANSLATION]: { input: 'abc' } }, stored, false), null, 'not a price');
});
