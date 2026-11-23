// Gemini API prices used to estimate what a session cost, and the arithmetic on them. Pure functions,
// DOM-free.
//
// The prices are the paid tier, Standard (not Batch), as published on the pricing page. The block between
// the BEGIN and END markers is rewritten by `node scripts/update-pricing.mjs --write`; edit it by hand only
// in the same format. Per model:
//   input, output                    USD per 1M tokens (output includes thinking tokens)
//   inputPerMinute, outputPerMinute  USD per minute of audio, for the live transcription model, whose usage
//                                    is counted as listening time. Google derives them from 25 audio tokens
//                                    per second in and 175 text tokens per minute out, and rounds them.

// BEGIN PRICES
export const PRICES = {
  currency: 'USD',
  asOf: '2026-11-23',
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  models: {
    'gemini-3.5-transcribe-live': {
      input: 3.5,
      output: 21,
      inputPerMinute: 0.005,
      outputPerMinute: 0.004,
    },
    'gemini-3.5-flash-lite': {
      input: 0.3,
      output: 2.5,
    },
  },
};
// END PRICES

/** The price fields a model may have. */
export const PRICE_FIELDS = ['input', 'output', 'inputPerMinute', 'outputPerMinute'];

/** The kinds of usage, in the order a breakdown lists them. */
export const COST_KINDS = ['transcription', 'translation', 'summary'];

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const MS_PER_MINUTE = 60_000;

/** True for a usable price: a finite number, zero or more. */
export function isValidPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Returns a new price table: `defaults` with individual prices replaced by `overrides`, which has the shape
 * `{ [model]: { input?, output?, inputPerMinute?, outputPerMinute? } }`. A model that is not in `defaults` is
 * added. An undefined value keeps the default. Throws a RangeError for an unknown field or a price that is
 * not a finite number of zero or more; nothing is merged in that case. Neither argument is changed.
 */
export function mergePrices(defaults, overrides = {}) {
  const models = {};
  for (const [model, prices] of Object.entries(defaults.models ?? {})) models[model] = { ...prices };
  for (const [model, prices] of Object.entries(overrides ?? {})) {
    if (model === '__proto__') throw new RangeError('Invalid model name');
    if (!prices || typeof prices !== 'object') throw new RangeError(`Prices for ${model} must be an object`);
    for (const [field, value] of Object.entries(prices)) {
      if (!PRICE_FIELDS.includes(field)) throw new RangeError(`Unknown price field ${field} for ${model}`);
      if (value === undefined) continue;
      if (!isValidPrice(value)) throw new RangeError(`Price ${field} for ${model} must be a number of 0 or more`);
      models[model] = { ...models[model], [field]: value };
    }
  }
  return { ...defaults, models };
}

function emptyPart() {
  return { usd: 0, unpriced: [], byModel: {} };
}

function addToPart(part, model, usd) {
  part.byModel[model] = usd;
  if (usd === null) {
    if (!part.unpriced.includes(model)) part.unpriced.push(model);
  } else {
    part.usd += usd;
  }
}

function listeningCost(prices, ms) {
  if (!prices || !isValidPrice(prices.inputPerMinute) || !isValidPrice(prices.outputPerMinute)) return null;
  return (ms / MS_PER_MINUTE) * (prices.inputPerMinute + prices.outputPerMinute);
}

function tokenCost(prices, inputTokens, outputTokens) {
  if (!prices || !isValidPrice(prices.input) || !isValidPrice(prices.output)) return null;
  return (inputTokens * prices.input + outputTokens * prices.output) / TOKENS_PER_PRICE_UNIT;
}

/**
 * What a usage record (src/usage.js) cost under a price table. Returns
 *   { currency, transcription, translation, summary, total }
 * where each part is { usd, unpriced, byModel }:
 *   usd       the cost of the usage whose model has a price;
 *   unpriced  the models that were used but have no price ("no price", not zero). When it is not empty,
 *             usd covers only part of the usage and must not be shown as the whole cost;
 *   byModel   { [model]: usd, or null for no price }. In `total`, the costs are summed across kinds.
 * Amounts are not rounded; format them with formatUsd.
 */
export function costOf(usage, prices = PRICES) {
  const table = prices.models ?? {};
  const result = { currency: prices.currency ?? 'USD', total: emptyPart() };
  for (const kind of COST_KINDS) {
    const part = emptyPart();
    for (const [model, entry] of Object.entries(usage?.[kind] ?? {})) {
      const usd =
        kind === 'transcription'
          ? listeningCost(table[model], entry.listeningMs ?? 0)
          : tokenCost(table[model], entry.inputTokens ?? 0, entry.outputTokens ?? 0);
      addToPart(part, model, usd);
      const sofar = result.total.byModel[model];
      result.total.byModel[model] = usd === null || sofar === null ? null : (sofar ?? 0) + usd;
      if (usd === null && !result.total.unpriced.includes(model)) result.total.unpriced.push(model);
    }
    result[kind] = part;
    result.total.usd += part.usd;
  }
  return result;
}

const SMALLEST = 0.000001;

/**
 * Formats a USD amount for display: two decimals from $1 up ($1.27), two significant digits below
 * ($0.54, $0.0042, $0.05), so that a cost above zero never reads $0.00. Amounts above zero but below
 * $0.000001 read "<$0.000001". Throws a TypeError for anything but a finite number.
 */
export function formatUsd(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError('formatUsd needs a finite number');
  if (amount < 0) return `-${formatUsd(-amount)}`;
  if (amount === 0) return '$0.00';
  if (amount < SMALLEST) return `<$${SMALLEST.toFixed(6)}`;
  const value = amount < 1 ? Number(amount.toPrecision(2)) : amount;
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Two significant digits, at least two decimals, no trailing zeros beyond that: 0.05, 0.0042, 0.004.
  const decimals = Math.max(2, -Math.floor(Math.log10(value)) + 1);
  let text = value.toFixed(decimals);
  while (text.endsWith('0') && text.length - text.indexOf('.') - 1 > 2) text = text.slice(0, -1);
  return `$${text}`;
}
