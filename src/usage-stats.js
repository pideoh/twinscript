// What the usage screen shows: running totals per calendar day, kept apart from the sessions so that
// deleting a session does not erase what was used, and the rows of the screen's tables. Pure functions,
// DOM-free; usage records are those of src/usage.js, prices those of src/pricing.js.
//
// The daily totals are plain JSON, kept by the app in localStorage under DAILY_KEY:
//   { version: 1, days: { 'YYYY-MM-DD': usage record } }
// Days are calendar days in local time. Only the last KEEP_DAYS days are kept.

import { costOf } from './pricing.js';
import { addUsage, emptyUsage, TOKEN_KINDS } from './usage.js';

/** The live transcription model, whose usage is counted as listening time. Must match MODEL in transcriber.js. */
export const LIVE_MODEL = 'gemini-3.5-transcribe-live';

export const DAILY_KEY = 'rt-usage';
export const DAILY_VERSION = 1;
export const KEEP_DAYS = 400;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/** The local calendar day of `date` (a Date or epoch ms), as 'YYYY-MM-DD'. */
export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Daily totals with nothing in them. */
export function emptyDaily() {
  return { version: DAILY_VERSION, days: {} };
}

// A stored usage record as this version reads it, or null when it cannot (a newer record version).
function readUsage(record) {
  try {
    return addUsage(emptyUsage(), record);
  } catch {
    return null;
  }
}

/**
 * Daily totals from their stored JSON text. Anything unreadable gives empty totals; days with a malformed
 * key or a record this version cannot read are dropped. Totals written by a newer version are returned
 * empty with `readOnly: true`: the app shows nothing from them and must not write over them.
 */
export function readDaily(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return emptyDaily();
  }
  if (!data || typeof data !== 'object' || typeof data.version !== 'number') return emptyDaily();
  if (data.version > DAILY_VERSION) return { ...emptyDaily(), readOnly: true };
  const days = {};
  for (const [key, record] of Object.entries(data.days && typeof data.days === 'object' ? data.days : {})) {
    if (!DAY.test(key) || !record || typeof record !== 'object') continue;
    const usage = readUsage(record);
    if (usage) days[key] = usage;
  }
  return { version: DAILY_VERSION, days };
}

/** The days of `daily` within the last `keep` calendar days up to `now` (today included). */
export function pruneDaily(daily, now = Date.now(), keep = KEEP_DAYS) {
  const today = new Date(now);
  const first = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keep - 1)));
  const days = Object.fromEntries(Object.entries(daily.days).filter(([key]) => key >= first));
  return { ...daily, days };
}

/** Adds `usage` to the day of `now`, then prunes. Returns new totals; read-only totals come back unchanged. */
export function addToDaily(daily, usage, now = Date.now()) {
  if (daily.readOnly) return daily;
  const key = dayKey(now);
  const days = { ...daily.days, [key]: addUsage(daily.days[key] ?? emptyUsage(), usage) };
  return pruneDaily({ ...daily, days }, now);
}

const sum = (records) => records.reduce((a, b) => addUsage(a, b), emptyUsage());

/** The periods of the totals table, in order. */
export const PERIODS = ['today', 'thisMonth', 'lastMonth', 'all'];

/** Usage records for today, this month, last month (calendar months in local time) and all recorded days. */
export function periodTotals(daily, now = Date.now()) {
  const today = new Date(now);
  const thisMonth = dayKey(today).slice(0, 7);
  const lastMonth = dayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
  const entries = Object.entries(daily.days);
  const within = (test) => sum(entries.filter(([key]) => test(key)).map(([, usage]) => usage));
  return {
    today: within((key) => key === dayKey(today)),
    thisMonth: within((key) => key.startsWith(`${thisMonth}-`)),
    lastMonth: within((key) => key.startsWith(`${lastMonth}-`)),
    all: within(() => true),
  };
}

// One part of costOf: { usd, noPrice, partial }. noPrice: everything in it is used by models without a
// price, so no amount can be shown; partial: some of it is, and `usd` leaves that out.
function costPart(part) {
  const values = Object.values(part.byModel);
  const priced = values.some((v) => v !== null);
  return { usd: part.usd, noPrice: values.length > 0 && !priced, partial: priced && part.unpriced.length > 0 };
}

function tokenTotals(entries) {
  const out = { requests: 0, inputTokens: 0, outputTokens: 0 };
  for (const entry of Object.values(entries)) {
    out.requests += entry.requests;
    out.inputTokens += entry.inputTokens;
    out.outputTokens += entry.outputTokens;
  }
  return out;
}

/**
 * What the screen shows of one usage record:
 *   { listeningMs, translation, summary, diarization, requests, inputTokens, outputTokens, cost, unpriced }
 * translation, summary and diarization (speaker labels) are { requests, inputTokens, outputTokens } over all
 * models; requests and the token counts are their sums. cost has the parts transcription, translation,
 * summary, diarization and total, each
 * { usd, noPrice, partial } (see costPart). unpriced: the models used that have no price.
 */
export function usageView(usage, prices) {
  const record = readUsage(usage) ?? emptyUsage();
  const cost = costOf(record, prices);
  const view = {
    listeningMs: Object.values(record.transcription).reduce((ms, entry) => ms + entry.listeningMs, 0),
    cost: {},
    unpriced: cost.total.unpriced,
  };
  for (const kind of TOKEN_KINDS) view[kind] = tokenTotals(record[kind]);
  for (const field of ['requests', 'inputTokens', 'outputTokens']) {
    view[field] = TOKEN_KINDS.reduce((n, kind) => n + view[kind][field], 0);
  }
  for (const part of ['transcription', ...TOKEN_KINDS, 'total']) view.cost[part] = costPart(cost[part]);
  return view;
}

/** The rows of the totals table: [{ period, ...usageView }], in the order of PERIODS. */
export function totalsRows(daily, prices, now = Date.now()) {
  const totals = periodTotals(daily, now);
  return PERIODS.map((period) => ({ period, ...usageView(totals[period], prices) }));
}

/**
 * The rows of the sessions table, most recent first: { id, createdAt, title, recorded, partial, demo, view }.
 * A session without a usage record (made before usage was counted, or with one this version cannot read)
 * is `recorded: false` and has no view. partial: counting began after the session had already been used.
 * demo: the session was used in the demo mode, whose made-up usage is never added to the daily totals.
 */
export function sessionRows(sessions, prices) {
  return [...sessions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((sess) => {
      const usage = sess.usage ? readUsage(sess.usage) : null;
      return {
        id: sess.id,
        createdAt: sess.createdAt,
        title: sess.title,
        recorded: !!usage,
        partial: !!sess.usagePartial,
        demo: !!sess.demo,
        view: usage ? usageView(usage, prices) : null,
      };
    });
}

/** A duration as h:mm:ss (hours not padded). */
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/**
 * Price overrides from what the user typed in the settings: `fields` is { [model]: { [field]: text } }.
 * Empty text leaves a price out; a value equal to the default in `defaults` is left out too, so that a
 * later change of the default applies. Text that is not a number gives NaN, which mergePrices rejects.
 */
export function overridesFromFields(fields, defaults) {
  const overrides = {};
  for (const [model, values] of Object.entries(fields)) {
    for (const [field, text] of Object.entries(values)) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) continue;
      const value = Number(trimmed.replace(',', '.'));
      if (value === defaults.models?.[model]?.[field]) continue;
      overrides[model] = { ...overrides[model], [field]: value };
    }
  }
  return overrides;
}
