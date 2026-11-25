// Records what the API is used for as it happens. Each session keeps what it used in `usage`
// (src/usage/usage.js), saved with its metadata. The same usage is added to running totals per
// calendar day in localStorage (src/usage/usage-stats.js), which outlive the sessions. In the demo
// mode the made-up usage goes into its session only, which is marked `demo`; the daily totals, the
// only source of the totals shown, never see it. `usagePartial` marks a session from before usage
// was counted that was used again afterwards: only the later part is known.
// Also the prices estimates are made with: the defaults of src/usage/pricing.js with the user's
// overrides, and the models whose prices the settings offer to change. DOM-free: the storage (a
// Storage-like object with getItem / setItem) and the clock are passed in.

import { mergePrices, PRICES } from './pricing.js';
import { addListening, addUsage, emptyUsage } from './usage.js';
import { addToDaily, DAILY_KEY, emptyDaily, LIVE_MODEL, overridesFromFields, readDaily } from './usage-stats.js';

// The default prices with `overrides`; overrides that are not valid (edited by hand) are ignored.
export function pricesWith(overrides) {
  try {
    return mergePrices(PRICES, overrides);
  } catch {
    return PRICES;
  }
}

// The prices each kind of model is estimated with: listening time for the live model, tokens for
// the others.
export const PRICE_UNITS = { listening: ['inputPerMinute', 'outputPerMinute'], tokens: ['input', 'output'] };

// The models in use and the prices each is estimated with, as [[model, fields]]: the live model,
// the translation model (which also writes the summaries) and the speaker-label model. A model used
// for two of these is listed once, with the fields of both.
export function priceModels(translation, diarizeModel) {
  const models =
    translation === LIVE_MODEL
      ? [[LIVE_MODEL, [...PRICE_UNITS.listening, ...PRICE_UNITS.tokens]]]
      : [
          [LIVE_MODEL, PRICE_UNITS.listening],
          [translation, PRICE_UNITS.tokens],
        ];
  if (!models.some(([model]) => model === diarizeModel)) models.push([diarizeModel, PRICE_UNITS.tokens]);
  return models;
}

// A price field's text as it is shown: empty when the model has no such price.
export const priceText = (prices, model, field) =>
  prices[model]?.[field] === undefined ? '' : String(prices[model][field]);

// Whether a price field's text is something other than empty or a price (a number of at least 0;
// a decimal comma counts as a point).
export function notAPrice(text) {
  const trimmed = text.trim();
  return trimmed !== '' && !(Number(trimmed.replace(',', '.')) >= 0);
}

// The overrides the fields describe, or null while any of them is not a price. `shown` is
// { [model]: { [field]: text } } for the models shown; overrides in `stored` of a model not shown
// now (an earlier translation model) are kept, unless `reset`.
export function pendingOverrides(shown, stored, reset) {
  const overrides = overridesFromFields(shown, PRICES);
  if (!reset) {
    for (const [model, values] of Object.entries(stored ?? {})) {
      if (!(model in shown)) overrides[model] = values;
    }
  }
  try {
    mergePrices(PRICES, overrides);
    return overrides;
  } catch {
    return null;
  }
}

// settings: the live settings object (its priceOverrides are read each time); demo: the demo mode;
// isEmpty(sess): whether a session has neither speech nor recordings; markDirty(sess): schedules a
// save; onRecorded(): called after each record (the open usage dialog re-renders).
export function createUsageLog({
  settings,
  storage,
  demo = false,
  isEmpty,
  markDirty,
  onRecorded = () => {},
  now = () => Date.now(),
}) {
  const currentPrices = () => pricesWith(settings.priceOverrides);

  function readDailyTotals() {
    try {
      return readDaily(storage.getItem(DAILY_KEY));
    } catch {
      return emptyDaily();
    }
  }
  function addToDailyTotals(usage) {
    try {
      // Read again each time: another window of the app may have added to them.
      const daily = readDailyTotals();
      if (!daily.readOnly) storage.setItem(DAILY_KEY, JSON.stringify(addToDaily(daily, usage, now())));
    } catch {
      /* private mode or full storage: the session keeps its own record */
    }
  }

  // Adds `usage`, what one request or a stretch of listening used, to `sess` and to the totals.
  function recordUsage(sess, usage) {
    if (!sess.usage) {
      if (sess.activeMs > 0 || !isEmpty(sess)) sess.usagePartial = true;
      sess.usage = emptyUsage();
    }
    try {
      sess.usage = addUsage(sess.usage, usage);
    } catch {
      /* a record written by a newer version is left as it is */
    }
    if (demo) sess.demo = true;
    else addToDailyTotals(usage);
    markDirty(sess);
    onRecorded();
  }

  // Listening time counts while the recognizer is connected (state 'listening'): r.listeningSince
  // is when that began, or 0. The time up to now is recorded for r.session and counting goes on
  // from now. Recording re-renders an open usage dialog, which accrues again: that nested call
  // returns at once, or it would record (and re-render) again without end.
  let accruing = false;
  function accrueListening(r) {
    if (!r.listeningSince || accruing) return;
    const time = now();
    const ms = time - r.listeningSince;
    r.listeningSince = time;
    accruing = true;
    try {
      recordUsage(r.session, addListening(emptyUsage(), LIVE_MODEL, ms));
    } finally {
      accruing = false;
    }
  }

  return { currentPrices, readDailyTotals, recordUsage, accrueListening };
}
