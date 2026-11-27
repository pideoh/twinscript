import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergePrices, PRICES } from '../../../../src/usage/pricing.js';
import { addListening, addTokens, emptyUsage, USAGE_VERSION } from '../../../../src/usage/usage.js';
import {
  addToDaily,
  DAILY_VERSION,
  dayKey,
  emptyDaily,
  formatDuration,
  KEEP_DAYS,
  LIVE_MODEL,
  overridesFromFields,
  PERIODS,
  periodTotals,
  pruneDaily,
  readDaily,
  sessionRows,
  totalsRows,
  usageView,
} from '../../../../src/usage/usage-stats.js';

const LITE = 'gemini-3.5-flash-lite';
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

// Dates are built in local time, as the app counts days, so the tests hold in any time zone.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const translation = (input, output) =>
  addTokens(emptyUsage(), 'translation', LITE, { promptTokenCount: input, candidatesTokenCount: output });
const listening = (ms) => addListening(emptyUsage(), LIVE_MODEL, ms);

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test('the live model counted for listening time is the one the transcriber uses', async () => {
  const source = await readFile(join(ROOT, 'src', 'speech', 'transcriber.js'), 'utf8');
  assert.match(source, new RegExp(`const MODEL = 'models/${LIVE_MODEL}'`));
  assert.ok(PRICES.models[LIVE_MODEL], 'the live model has a price');
});

test('days are calendar days in local time', () => {
  assert.equal(dayKey(at(2026, 1, 5, 0)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59, 59)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 0, 6, 0, 0, 0)), '2026-01-06');
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('usage of the same day adds up, other days stay apart, and nothing is changed in place', () => {
  const start = emptyDaily();
  const one = addToDaily(start, translation(100, 10), at(2026, 3, 1, 9));
  const two = addToDaily(one, translation(50, 5), at(2026, 3, 1, 22));
  const three = addToDaily(two, listening(60_000), at(2026, 3, 2, 8));
  assert.deepEqual(start, emptyDaily());
  assert.deepEqual(Object.keys(one.days), ['2026-03-01']);
  assert.deepEqual(two.days['2026-03-01'].translation[LITE], { requests: 2, inputTokens: 150, outputTokens: 15 });
  assert.deepEqual(three.days['2026-03-02'].transcription[LIVE_MODEL], { listeningMs: 60_000 });
  assert.deepEqual(three.days['2026-03-02'].translation, {});
  assert.equal(three.version, DAILY_VERSION);
  assert.deepEqual(readDaily(JSON.stringify(three)), three, 'the totals survive being stored as JSON');
});

test('only the last 400 days are kept', () => {
  let daily = emptyDaily();
  daily = addToDaily(daily, translation(1, 1), at(2025, 1, 1));
  daily = addToDaily(daily, translation(1, 1), at(2025, 6, 1));
  const now = at(2026, 2, 3);
  // The window is the 400 days up to and including today.
  const first = dayKey(new Date(2026, 1, 3 - (KEEP_DAYS - 1)));
  const before = dayKey(new Date(2026, 1, 3 - KEEP_DAYS));
  daily = { ...daily, days: { ...daily.days, [first]: translation(1, 1), [before]: translation(1, 1) } };
  const pruned = pruneDaily(daily, now);
  assert.ok(pruned.days[first], 'the first day of the window is kept');
  assert.ok(!pruned.days[before], 'the day before it is not');
  assert.ok(pruned.days['2025-06-01']);
  assert.deepEqual(Object.keys(pruneDaily(daily, at(2028, 6, 15)).days), [], 'all too old');
  const added = addToDaily(daily, translation(1, 1), now);
  assert.ok(!added.days[before], 'adding prunes');
  assert.ok(added.days['2026-02-03']);
});

test('totals cover today, this month and last month by local calendar, and everything recorded', () => {
  let daily = emptyDaily();
  daily = addToDaily(daily, translation(1, 0), at(2025, 12, 31, 23)); // last year's December
  daily = addToDaily(daily, translation(10, 0), at(2026, 1, 1, 0)); // the first moment of January
  daily = addToDaily(daily, translation(100, 0), at(2026, 1, 31, 23)); // the last hour of January
  daily = addToDaily(daily, translation(1000, 0), at(2026, 2, 1, 1));
  daily = addToDaily(daily, translation(10000, 0), at(2026, 2, 14));
  const totals = periodTotals(daily, at(2026, 2, 14, 18));
  const input = (usage) => usage.translation[LITE]?.inputTokens ?? 0;
  assert.equal(input(totals.today), 10000);
  assert.equal(input(totals.thisMonth), 11000);
  assert.equal(input(totals.lastMonth), 110);
  assert.equal(input(totals.all), 11111);
  // In January, last month is the December of the year before.
  const january = periodTotals(daily, at(2026, 1, 20));
  assert.equal(input(january.lastMonth), 1);
  assert.equal(input(january.thisMonth), 110);
  assert.equal(input(january.today), 0);
  assert.deepEqual(Object.keys(totals), PERIODS);
});

test('stored totals that cannot be read count as empty; totals of a newer version are left alone', () => {
  for (const json of [null, '', 'not json', '3', '[]', '{"days":{}}']) assert.deepEqual(readDaily(json), emptyDaily());
  const partly = readDaily(
    JSON.stringify({
      version: 1,
      days: {
        '2026-03-01': translation(5, 1),
        'March 2': translation(5, 1),
        '2026-03-03': 'x',
        '2026-03-04': { ...translation(5, 1), version: USAGE_VERSION + 1 },
      },
    }),
  );
  assert.deepEqual(Object.keys(partly.days), ['2026-03-01']);
  const newer = readDaily(JSON.stringify({ version: DAILY_VERSION + 1, days: { '2026-03-01': {} } }));
  assert.equal(newer.readOnly, true);
  assert.deepEqual(newer.days, {});
  assert.equal(addToDaily(newer, translation(1, 1), at(2026, 3, 1)), newer, 'read-only totals are not added to');
});

test('a usage view sums requests and tokens and splits the cost into its three parts', () => {
  let usage = addListening(emptyUsage(), LIVE_MODEL, 10 * 60_000);
  usage = addTokens(usage, 'translation', LITE, { promptTokenCount: 1000, candidatesTokenCount: 200 });
  usage = addTokens(usage, 'translation', LITE, { promptTokenCount: 1000, candidatesTokenCount: 200 });
  usage = addTokens(usage, 'summary', LITE, {
    promptTokenCount: 5000,
    candidatesTokenCount: 800,
    thoughtsTokenCount: 200,
  });
  const view = usageView(usage, PRICES);
  assert.equal(view.listeningMs, 600_000);
  assert.deepEqual(view.translation, { requests: 2, inputTokens: 2000, outputTokens: 400 });
  assert.deepEqual(view.summary, { requests: 1, inputTokens: 5000, outputTokens: 1000 });
  assert.equal(view.requests, 3);
  assert.equal(view.inputTokens, 7000);
  assert.equal(view.outputTokens, 1400);
  close(view.cost.transcription.usd, 0.09); // 10 min x ($0.005 + $0.004)
  close(view.cost.translation.usd, (2000 * 0.3 + 400 * 2.5) / 1e6);
  close(view.cost.summary.usd, (5000 * 0.3 + 1000 * 2.5) / 1e6);
  close(view.cost.total.usd, 0.09 + 0.0016 + 0.004);
  for (const part of Object.values(view.cost)) assert.equal(part.noPrice || part.partial, false);
  assert.deepEqual(view.unpriced, []);
});

test('usage of a model without a price shows no price, and the total leaves it out', () => {
  let usage = addListening(emptyUsage(), LIVE_MODEL, 60_000);
  usage = addTokens(usage, 'translation', 'my-model', { promptTokenCount: 1000, candidatesTokenCount: 100 });
  const view = usageView(usage, PRICES);
  assert.equal(view.translation.requests, 1, 'the usage is still shown');
  assert.equal(view.cost.translation.noPrice, true);
  assert.equal(view.cost.total.noPrice, false);
  assert.equal(view.cost.total.partial, true);
  close(view.cost.total.usd, 0.009);
  assert.deepEqual(view.unpriced, ['my-model']);
  // Once it has a price, it counts.
  const priced = usageView(usage, mergePrices(PRICES, { 'my-model': { input: 1, output: 2 } }));
  assert.equal(priced.cost.translation.noPrice, false);
  close(priced.cost.translation.usd, (1000 * 1 + 100 * 2) / 1e6);
  // Nothing used is not "no price".
  assert.equal(usageView(emptyUsage(), PRICES).cost.summary.noPrice, false);
});

test('changed prices change the amounts', () => {
  const usage = translation(1000, 200);
  close(usageView(usage, PRICES).cost.translation.usd, 0.0008);
  close(usageView(usage, mergePrices(PRICES, { [LITE]: { input: 3 } })).cost.translation.usd, 0.0035);
});

test('the totals table has a row per period with what was used in it', () => {
  const daily = addToDaily(emptyDaily(), translation(1000, 200), at(2026, 4, 2));
  const rows = totalsRows(daily, PRICES, at(2026, 4, 2));
  assert.deepEqual(
    rows.map((r) => [r.period, r.requests, r.inputTokens, r.outputTokens]),
    [
      ['today', 1, 1000, 200],
      ['thisMonth', 1, 1000, 200],
      ['lastMonth', 0, 0, 0],
      ['all', 1, 1000, 200],
    ],
  );
  close(rows[0].cost.total.usd, 0.0008);
});

test('the sessions table lists the most recent first and tells sessions without usage apart', () => {
  const sessions = [
    { id: 'old', createdAt: 1, title: 'Before counting' },
    { id: 'new', createdAt: 3, title: 'Counted', usage: translation(1000, 200) },
    { id: 'demo', createdAt: 2, title: 'Demo', usage: listening(1000), demo: true },
    { id: 'part', createdAt: 0, title: 'Again', usage: listening(1000), usagePartial: true },
    { id: 'newer', createdAt: -1, title: 'Newer', usage: { version: USAGE_VERSION + 1 } },
  ];
  const rows = sessionRows(sessions, PRICES);
  assert.deepEqual(
    rows.map((r) => [r.id, r.recorded, r.demo, r.partial]),
    [
      ['new', true, false, false],
      ['demo', true, true, false],
      ['old', false, false, false],
      ['part', true, false, true],
      ['newer', false, false, false],
    ],
  );
  assert.equal(rows[0].view.requests, 1);
  assert.equal(rows[2].view, null);
  assert.deepEqual(sessions[0], { id: 'old', createdAt: 1, title: 'Before counting' }, 'the sessions are not changed');
});

test('durations read h:mm:ss', () => {
  assert.equal(formatDuration(0), '0:00:00');
  assert.equal(formatDuration(59_999), '0:00:59');
  assert.equal(formatDuration(61_000), '0:01:01');
  assert.equal(formatDuration(36_000_000 + 125_000), '10:02:05');
  assert.equal(formatDuration(Number.NaN), '0:00:00');
  assert.equal(formatDuration(-5), '0:00:00');
});

test('typed prices become overrides of the listed ones', () => {
  const fields = {
    [LIVE_MODEL]: { inputPerMinute: '0.005', outputPerMinute: '0,01' },
    [LITE]: { input: ' 3 ', output: '' },
    'my-model': { input: '1', output: '2.5' },
  };
  assert.deepEqual(overridesFromFields(fields, PRICES), {
    [LIVE_MODEL]: { outputPerMinute: 0.01 },
    [LITE]: { input: 3 },
    'my-model': { input: 1, output: 2.5 },
  });
  const bad = overridesFromFields({ [LITE]: { input: 'abc', output: '-1' } }, PRICES);
  assert.ok(Number.isNaN(bad[LITE].input));
  assert.throws(() => mergePrices(PRICES, bad), RangeError);
  assert.deepEqual(overridesFromFields({ [LITE]: { input: '0.3', output: '2.5' } }, PRICES), {});
});

test('speaker labels are a part of their own in the view, priced as the transcription model, and in the total', () => {
  let usage = addTokens(emptyUsage(), 'summary', LITE, { promptTokenCount: 1000, candidatesTokenCount: 100 });
  usage = addTokens(usage, 'diarization', 'gemini-3.5-transcribe', {
    promptTokenCount: 45_000,
    candidatesTokenCount: 5000,
  });
  const view = usageView(usage, PRICES);
  assert.deepEqual(view.diarization, { requests: 1, inputTokens: 45_000, outputTokens: 5000 });
  assert.equal(view.requests, 2);
  assert.equal(view.inputTokens, 46_000);
  close(view.cost.diarization.usd, (45_000 * 2 + 5000 * 12) / 1e6);
  close(view.cost.total.usd, (45_000 * 2 + 5000 * 12) / 1e6 + (1000 * 0.3 + 100 * 2.5) / 1e6);
  assert.deepEqual(view.unpriced, []);
});

test('questions are a part of their own in the view, in the totals and in the total cost', () => {
  let usage = addTokens(emptyUsage(), 'summary', LITE, { promptTokenCount: 1000, candidatesTokenCount: 100 });
  usage = addTokens(usage, 'question', LITE, { promptTokenCount: 20_000, candidatesTokenCount: 200 });
  const view = usageView(usage, PRICES);
  assert.deepEqual(view.question, { requests: 1, inputTokens: 20_000, outputTokens: 200 });
  assert.equal(view.requests, 2);
  assert.equal(view.inputTokens, 21_000);
  close(view.cost.question.usd, (20_000 * 0.3 + 200 * 2.5) / 1e6);
  close(view.cost.total.usd, (21_000 * 0.3 + 300 * 2.5) / 1e6);
  const old = usageView({ version: USAGE_VERSION, transcription: {}, translation: {}, summary: {} }, PRICES);
  assert.deepEqual(old.question, { requests: 0, inputTokens: 0, outputTokens: 0 }, 'an older record reads as none');
});
