// Checks the Gemini prices in src/pricing.js against Google's pricing page and, with --write, updates them.
//
// Usage: node scripts/update-pricing.mjs [--write] [--force] [--report <file>] [--page <file>] [--file <file>]
//   (no option)      print the differences; exit 1 when there are any (a check)
//   --write          rewrite the price block in src/pricing.js, with today's date as "as of", when prices changed
//   --force          accept changes that look wrong: a price that moves by more than 5x, or a model that is no
//                    longer on the page (it is removed from the table)
//   --report <file>  also write the differences as Markdown (used as the pull request body by
//                    .github/workflows/pricing-check.yml)
//   --page <file>    read the page text from a file instead of fetching it
//   --file <file>    the price table to check (default: src/pricing.js)
//
// Exit codes: 0 nothing to do (or written), 1 differences found (without --write), 2 the page could not be read
// or parsed, or a change was refused. Nothing is written unless every model was parsed without doubt.
//
// The page is read as Markdown (Google serves the documentation as text at the .md.txt address). For each model
// in the table it reads the section headed `{% id="<model>" %}`, its "Standard" tab, and in the table there the
// "Paid Tier, per 1M tokens in USD" column of the "Input price" and "Output price" rows. A price must read
// "$3.50", "$3.50 (audio)" or "$3.50 or $0.005/min (audio)"; anything else is an error, never a guess.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGE_TEXT_URL = 'https://aistudio.google.com/docs/pricing.md.txt';
export const MAX_RATIO = 5;
const PRICING_FILE = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'pricing.js');
const FIELDS = ['input', 'output', 'inputPerMinute', 'outputPerMinute'];
const BEGIN = '// BEGIN PRICES';
const END = '// END PRICES';

export class PricingError extends Error {}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The lines of the section for `model`: from its heading to the next `## ` heading. */
export function modelSection(pageText, model) {
  const lines = pageText.split(/\r?\n/);
  const heading = new RegExp(`^##\\s.*\\{%\\s*id="${escapeRegExp(model)}"\\s*%\\}\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^##?\s/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end);
}

function standardTab(section, model) {
  const hasTabs = section.some((line) => /\{%\s*tab\s+title=/.test(line));
  if (!hasTabs) return section;
  const start = section.findIndex((line) => /\{%\s*tab\s+title="Standard"\s*%\}/.test(line));
  if (start === -1) throw new PricingError(`${model}: the section has tabs but no "Standard" tab`);
  const end = section.findIndex((line, i) => i > start && /\{%\s*\/tab\s*%\}/.test(line));
  return section.slice(start + 1, end === -1 ? section.length : end);
}

function tableRows(lines, model) {
  const start = lines.findIndex((line) => /\{%\s*table\s*%\}/.test(line));
  const end = lines.findIndex((line, i) => i > start && /\{%\s*\/table\s*%\}/.test(line));
  if (start === -1 || end === -1) throw new PricingError(`${model}: no price table in the section`);
  const rows = [[]];
  for (const raw of lines.slice(start + 1, end)) {
    const line = raw.trim();
    if (line === '---') rows.push([]);
    else if (line.startsWith('* ') || line === '*') rows.at(-1).push(line.slice(1).trim());
    else if (line && rows.at(-1).length) rows.at(-1)[rows.at(-1).length - 1] += ` ${line}`;
  }
  return rows.filter((row) => row.length);
}

function plainCell(cell) {
  return cell
    .replace(/\{%\s*sup\s*%\}.*?\{%\s*\/sup\s*%\}/g, '')
    .replace(/\{%.*?%\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRICE = /^\$(\d+(?:\.\d+)?)(?: or \$(\d+(?:\.\d+)?)\/min)?(?: \([^()]*\))?$/;

/** Parses one paid-tier cell: { perMillion, perMinute? }. Throws a PricingError when it does not fit. */
export function parsePriceCell(cell, what = 'price') {
  const text = plainCell(cell);
  const match = PRICE.exec(text);
  if (!match) throw new PricingError(`${what}: cannot read "${text}" as a price`);
  const result = { perMillion: Number(match[1]) };
  if (match[2] !== undefined) result.perMinute = Number(match[2]);
  return result;
}

/**
 * The prices of `model` on the page, with the same fields as `expected` (its entry in the current table, which
 * says whether per-minute prices are needed). Returns null when the model is not on the page; throws a
 * PricingError when it is there but cannot be read.
 */
export function parseModelPrices(pageText, model, expected = { input: 0, output: 0 }) {
  const section = modelSection(pageText, model);
  if (!section) return null;
  const rows = tableRows(standardTab(section, model), model);
  const header = rows[0] ?? [];
  if (!/^Paid Tier, per 1M tokens in USD$/.test(plainCell(header[2] ?? ''))) {
    throw new PricingError(`${model}: the third column is not "Paid Tier, per 1M tokens in USD"`);
  }
  const cell = (label) => {
    const found = rows.filter((row) => plainCell(row[0] ?? '').startsWith(label));
    if (found.length !== 1) throw new PricingError(`${model}: expected one "${label}" row, found ${found.length}`);
    return parsePriceCell(found[0][2] ?? '', `${model} ${label.toLowerCase()}`);
  };
  const input = cell('Input price');
  const output = cell('Output price');
  const prices = { input: input.perMillion, output: output.perMillion };
  for (const [field, side] of [
    ['inputPerMinute', input],
    ['outputPerMinute', output],
  ]) {
    if (!(field in expected)) continue;
    if (side.perMinute === undefined) throw new PricingError(`${model}: no per-minute price for ${field}`);
    prices[field] = side.perMinute;
  }
  return prices;
}

/**
 * Parses every model of `table` from the page. Returns { found: { [model]: prices }, missing: [model] }.
 * Throws a PricingError when a model is there but unreadable, or when none of the models is on the page
 * (the page is not what this parser expects).
 */
export function parsePage(pageText, table) {
  const found = {};
  const missing = [];
  for (const [model, expected] of Object.entries(table.models)) {
    const prices = parseModelPrices(pageText, model, expected);
    if (prices) found[model] = prices;
    else missing.push(model);
  }
  if (!Object.keys(found).length) {
    throw new PricingError('None of the models is on the page: it is not the pricing page text this script reads');
  }
  return { found, missing };
}

function looksWrong(from, to) {
  if (from === to) return false;
  if (from === 0 || to === 0) return true;
  return to / from > MAX_RATIO || from / to > MAX_RATIO;
}

/**
 * Compares the table with what the page says. Returns
 *   { changes: [{ model, field, from, to, suspicious }], missing: [model] }
 * A change is suspicious when the price moves by more than MAX_RATIO times either way, or to or from zero.
 */
export function comparePrices(table, { found, missing }) {
  const changes = [];
  for (const [model, current] of Object.entries(table.models)) {
    const next = found[model];
    if (!next) continue;
    for (const field of FIELDS) {
      if (!(field in current) || current[field] === next[field]) continue;
      changes.push({
        model,
        field,
        from: current[field],
        to: next[field],
        suspicious: looksWrong(current[field], next[field]),
      });
    }
  }
  return { changes, missing: [...missing] };
}

/**
 * What to do with a comparison: { exitCode, write, refused } where `refused` lists the reasons a write was
 * refused (changes that look wrong, missing models) without --force.
 */
export function decide({ changes, missing }, { write = false, force = false } = {}) {
  const different = changes.length > 0 || missing.length > 0;
  if (!different) return { exitCode: 0, write: false, refused: [] };
  const refused = force
    ? []
    : [
        ...changes
          .filter((change) => change.suspicious)
          .map((c) => `${c.model} ${c.field} moves from ${c.from} to ${c.to}, more than ${MAX_RATIO}x`),
        ...missing.map((model) => `${model} is not on the page`),
      ];
  if (!write) return { exitCode: refused.length ? 2 : 1, write: false, refused };
  if (refused.length) return { exitCode: 2, write: false, refused };
  return { exitCode: 0, write: true, refused };
}

/** The table after the comparison: changed prices applied, missing models removed, `asOf` set to `date`. */
export function nextTable(table, { changes, missing }, date) {
  const models = {};
  for (const [model, prices] of Object.entries(table.models)) {
    if (missing.includes(model)) continue;
    models[model] = { ...prices };
  }
  for (const { model, field, to } of changes) if (models[model]) models[model][field] = to;
  return { ...table, asOf: date, models };
}

function quote(text, what) {
  if (typeof text !== 'string' || /['\\\n\r]/.test(text)) throw new PricingError(`Cannot write ${what}: ${text}`);
  return `'${text}'`;
}

function number(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PricingError(`Cannot write ${what}: ${value}`);
  }
  return String(value);
}

/** The price block as it stands in src/pricing.js, in the project's formatting, markers included. */
export function renderPricesBlock(table) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(table.asOf)) throw new PricingError(`Cannot write the date: ${table.asOf}`);
  const lines = [
    BEGIN,
    'export const PRICES = {',
    `  currency: ${quote(table.currency, 'the currency')},`,
    `  asOf: ${quote(table.asOf, 'the date')},`,
    `  source: ${quote(table.source, 'the source')},`,
    '  models: {',
  ];
  for (const [model, prices] of Object.entries(table.models)) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(model)) throw new PricingError(`Cannot write the model name: ${model}`);
    lines.push(`    '${model}': {`);
    for (const field of FIELDS) {
      if (field in prices) lines.push(`      ${field}: ${number(prices[field], `${model} ${field}`)},`);
    }
    lines.push('    },');
  }
  lines.push('  },', '};', END);
  return lines.join('\n');
}

function blockRange(source) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start || source.indexOf(BEGIN, start + 1) !== -1) {
    throw new PricingError(`The price file needs exactly one "${BEGIN}" ... "${END}" block`);
  }
  return [start, end + END.length];
}

/** `source` (the text of src/pricing.js) with its price block replaced by `table`. */
export function replacePricesBlock(source, table) {
  const [start, end] = blockRange(source);
  return source.slice(0, start) + renderPricesBlock(table) + source.slice(end);
}

/** Reads the price table from the text of src/pricing.js by evaluating only its price block. */
export async function readPricesBlock(source) {
  const [start, end] = blockRange(source);
  const block = source.slice(start, end);
  const module = await import(`data:text/javascript,${encodeURIComponent(block)}`);
  return module.PRICES;
}

function usd(value) {
  const decimals = (String(value).split('.')[1] ?? '').length;
  return `$${value.toFixed(Math.max(2, decimals))}`;
}

const FIELD_NAMES = {
  input: 'input, per 1M tokens',
  output: 'output, per 1M tokens',
  inputPerMinute: 'input, per minute',
  outputPerMinute: 'output, per minute',
};

/** The differences as plain text lines, for the console. */
export function describe({ changes, missing }) {
  return [
    ...changes.map(
      (c) =>
        `${c.model} ${FIELD_NAMES[c.field]}: ${usd(c.from)} -> ${usd(c.to)}${c.suspicious ? ' (more than 5x: check)' : ''}`,
    ),
    ...missing.map((model) => `${model}: not on the page`),
  ];
}

/** The differences as Markdown, for a pull request body. */
export function markdownReport(table, comparison) {
  const lines = [
    `The prices on ${table.source} (paid tier, Standard) differ from \`src/pricing.js\` (as of ${table.asOf}):`,
    '',
  ];
  if (comparison.changes.length) {
    lines.push('| Model | Price | Was | Now |', '| --- | --- | --- | --- |');
    for (const c of comparison.changes) {
      lines.push(`| \`${c.model}\` | ${FIELD_NAMES[c.field]} | ${usd(c.from)} | ${usd(c.to)} |`);
    }
    lines.push('');
  }
  for (const model of comparison.missing) lines.push(`- \`${model}\` is no longer on the page.`);
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseArgs(argv) {
  const options = { write: false, force: false, file: PRICING_FILE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--report' || arg === '--page' || arg === '--file') {
      if (!argv[i + 1]) throw new PricingError(`${arg} needs a file name`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new PricingError(`Unknown option: ${arg}`);
  }
  return options;
}

async function fetchPage() {
  const response = await fetch(PAGE_TEXT_URL, {
    headers: { accept: 'text/markdown, text/plain' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new PricingError(`Fetching ${PAGE_TEXT_URL} failed: HTTP ${response.status}`);
  return response.text();
}

export async function main(argv, { today = new Date().toISOString().slice(0, 10), log = console } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
    return 0;
  }
  const source = readFileSync(options.file, 'utf8');
  const table = await readPricesBlock(source);
  const page = options.page ? readFileSync(options.page, 'utf8') : await fetchPage();
  const comparison = comparePrices(table, parsePage(page, table));
  const decision = decide(comparison, options);
  if (decision.exitCode === 0 && !decision.write) {
    log.log(`The prices match the pricing page (table as of ${table.asOf}).`);
    return 0;
  }
  log.log('The prices differ from the pricing page:');
  for (const line of describe(comparison)) log.log(`  ${line}`);
  if (options.report) writeFileSync(options.report, markdownReport(table, comparison));
  if (decision.refused.length) {
    log.error('Refused (check the page by hand, then run again with --force to accept):');
    for (const reason of decision.refused) log.error(`  ${reason}`);
  }
  if (decision.write) {
    writeFileSync(options.file, replacePricesBlock(source, nextTable(table, comparison, today)));
    log.log(`Updated ${options.file} (as of ${today}).`);
  }
  return decision.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof PricingError ? `Error: ${error.message}` : error);
      process.exitCode = 2;
    },
  );
}
