import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  comparePrices,
  decide,
  main,
  markdownReport,
  nextTable,
  PricingError,
  parseModelPrices,
  parsePage,
  parsePriceCell,
  readPricesBlock,
  replacePricesBlock,
} from '../../../scripts/update-pricing.mjs';
import { PRICES } from '../../../src/usage/pricing.js';

const LIVE = 'gemini-3.5-transcribe-live';
const LITE = 'gemini-3.5-flash-lite';
const root = fileURLToPath(new URL('../../..', import.meta.url));
// Line endings are normalized: a checkout on Windows may turn them into CRLF.
const fixture = (name) => readFileSync(join(root, 'test', 'fixtures', name), 'utf8').replaceAll('\r\n', '\n');
const PAGE = `# Gemini Developer API pricing\n\n${fixture('pricing-transcribe-live.md')}\n${fixture('pricing-flash-lite.md')}`;
const SOURCE = readFileSync(join(root, 'src', 'usage', 'pricing.js'), 'utf8');

test('the saved pricing page gives the prices in the table, per-minute prices included', () => {
  assert.deepEqual(parseModelPrices(PAGE, LIVE, PRICES.models[LIVE]), PRICES.models[LIVE]);
  assert.deepEqual(parseModelPrices(PAGE, LITE, PRICES.models[LITE]), PRICES.models[LITE]);
  // A neighbouring model with a similar name is a different section.
  assert.deepEqual(parseModelPrices(PAGE, 'gemini-3.5-transcribe', { input: 0, output: 0 }), { input: 2, output: 12 });
  assert.deepEqual(comparePrices(PRICES, parsePage(PAGE, PRICES)), { changes: [], missing: [] });
});

test('price cells are read only in the shapes the page uses', () => {
  assert.deepEqual(parsePriceCell('$3.50 or $0.005/min{% sup %}*{% /sup %} (audio)'), {
    perMillion: 3.5,
    perMinute: 0.005,
  });
  assert.deepEqual(parsePriceCell('$2.50'), { perMillion: 2.5 });
  assert.deepEqual(parsePriceCell('$0.30 (text / image / video / audio)'), { perMillion: 0.3 });
  for (const cell of ['Free of charge', '$0.30, prompts <= 200k tokens $0.60, prompts > 200k', '€0.30', '$', '0.30']) {
    assert.throws(() => parsePriceCell(cell), PricingError, cell);
  }
});

test('a changed price on the page is reported as a change', () => {
  const page = PAGE.replace('* $2.50\n', '* $2.75\n');
  assert.deepEqual(comparePrices(PRICES, parsePage(page, PRICES)), {
    changes: [{ model: LITE, field: 'output', from: 2.5, to: 2.75, suspicious: false }],
    missing: [],
  });
});

test('a model that is not on the page is reported as missing', () => {
  const page = PAGE.replace('{% id="gemini-3.5-flash-lite" %}', '{% id="gemini-4-flash-lite" %}');
  assert.deepEqual(parsePage(page, PRICES).missing, [LITE]);
});

test('a page that is not the pricing text, or a price that cannot be read, is an error', () => {
  for (const page of ['', '<!doctype html><html><body>Pricing</body></html>', 'garbage\n## \u0000 {% id=']) {
    assert.throws(() => parsePage(page, PRICES), PricingError);
  }
  const unreadable = PAGE.replace('$3.50 or $0.005/min', '$3.50 per hour');
  assert.throws(() => parsePage(unreadable, PRICES), /gemini-3.5-transcribe-live input price/);
  const noPerMinute = PAGE.replace('$21.00 or $0.004/min', '$21.00');
  assert.throws(() => parsePage(noPerMinute, PRICES), /per-minute/);
  const otherUnit = PAGE.replaceAll('Paid Tier, per 1M tokens in USD', 'Paid Tier, per 1K tokens in USD');
  assert.throws(() => parsePage(otherUnit, PRICES), /Paid Tier/);
  const noStandard = PAGE.replace('{% tab title="Standard" %}', '{% tab title="Priority" %}');
  assert.throws(() => parsePage(noStandard, PRICES), /Standard/);
});

test('the Batch prices are not mistaken for the Standard ones', () => {
  const page = PAGE.replace('* $0.30 (text', '* $0.31 (text');
  const { changes } = comparePrices(PRICES, parsePage(page, PRICES));
  assert.deepEqual(
    changes.map((c) => [c.field, c.to]),
    [['input', 0.31]],
  );
});

test('differences fail the check, and are written only with --write', () => {
  const same = { changes: [], missing: [] };
  assert.deepEqual(decide(same), { exitCode: 0, write: false, refused: [] });
  assert.deepEqual(decide(same, { write: true }), { exitCode: 0, write: false, refused: [] });
  const small = { changes: [{ model: LITE, field: 'output', from: 2.5, to: 12.5, suspicious: false }], missing: [] };
  assert.deepEqual(decide(small), { exitCode: 1, write: false, refused: [] });
  assert.deepEqual(decide(small, { write: true }), { exitCode: 0, write: true, refused: [] });
});

test('a price that moves more than 5x, or a missing model, is refused unless forced', () => {
  for (const [from, to, suspicious] of [
    [2.5, 12.5, false],
    [2.5, 12.6, true],
    [2.5, 0.5, false],
    [2.5, 0.49, true],
    [2.5, 0, true],
    [0, 0.1, true],
  ]) {
    const { changes } = comparePrices(
      { models: { [LITE]: { input: 0.3, output: from } } },
      { found: { [LITE]: { input: 0.3, output: to } }, missing: [] },
    );
    assert.equal(changes[0].suspicious, suspicious, `${from} -> ${to}`);
  }
  const big = { changes: [{ model: LITE, field: 'input', from: 0.3, to: 3, suspicious: true }], missing: [] };
  assert.equal(decide(big).exitCode, 2);
  assert.equal(decide(big, { write: true }).write, false);
  assert.equal(decide(big, { write: true }).exitCode, 2);
  assert.match(decide(big, { write: true }).refused[0], /more than 5x/);
  assert.deepEqual(decide(big, { write: true, force: true }), { exitCode: 0, write: true, refused: [] });
  const gone = { changes: [], missing: [LIVE] };
  assert.equal(decide(gone, { write: true }).exitCode, 2);
  assert.match(decide(gone).refused[0], /not on the page/);
  assert.equal(decide(gone, { write: true, force: true }).write, true);
});

test('rewriting the table with its own prices leaves the file unchanged', async () => {
  assert.equal(replacePricesBlock(SOURCE, PRICES), SOURCE);
  assert.deepEqual(await readPricesBlock(SOURCE), PRICES);
});

test('the written table reads back with the new prices and date, and the rest of the file is kept', async () => {
  const comparison = {
    changes: [{ model: LITE, field: 'output', from: 2.5, to: 2.75, suspicious: false }],
    missing: [LIVE],
  };
  const table = nextTable(PRICES, comparison, '2027-01-02');
  const written = replacePricesBlock(SOURCE, table);
  assert.deepEqual(await readPricesBlock(written), {
    ...PRICES,
    asOf: '2027-01-02',
    models: { 'gemini-3.5-transcribe': { input: 2, output: 12 }, [LITE]: { input: 0.3, output: 2.75 } },
  });
  assert.equal(replacePricesBlock(written, table), written);
  assert.equal(written.slice(written.indexOf('// END PRICES')), SOURCE.slice(SOURCE.indexOf('// END PRICES')));
  assert.equal(PRICES.models[LITE].output, 2.5);
  assert.throws(() => replacePricesBlock('no markers', table), PricingError);
  assert.throws(() => replacePricesBlock(SOURCE, { ...table, asOf: 'soon' }), PricingError);
  assert.throws(() => replacePricesBlock(SOURCE, { ...table, models: { "x'; evil": { input: 1 } } }), PricingError);
});

test('the report lists each change with the old and new price', () => {
  const report = markdownReport(PRICES, {
    changes: [{ model: LITE, field: 'output', from: 2.5, to: 2.75, suspicious: false }],
    missing: [LIVE],
  });
  assert.match(report, /\| `gemini-3.5-flash-lite` \| output, per 1M tokens \| \$2.50 \| \$2.75 \|/);
  assert.match(report, /`gemini-3.5-transcribe-live` is no longer on the page/);
});

test('the script checks, writes and refuses as its exit code says', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pricing.js');
  const page = join(dir, 'page.md');
  const report = join(dir, 'report.md');
  const quiet = { log() {}, error() {} };
  const run = (...args) => main([...args, '--file', file, '--page', page], { today: '2027-01-02', log: quiet });
  writeFileSync(file, SOURCE);

  writeFileSync(page, PAGE);
  assert.equal(await run(), 0);
  assert.equal(await run('--write'), 0);
  assert.equal(readFileSync(file, 'utf8'), SOURCE, 'nothing is written when the prices match');

  writeFileSync(page, PAGE.replace('* $2.50\n', '* $2.75\n'));
  assert.equal(await run('--report', report), 1);
  assert.equal(readFileSync(file, 'utf8'), SOURCE, 'a check writes nothing');
  assert.match(readFileSync(report, 'utf8'), /\$2.75/);
  assert.equal(await run('--write'), 0);
  assert.equal((await readPricesBlock(readFileSync(file, 'utf8'))).models[LITE].output, 2.75);
  assert.equal((await readPricesBlock(readFileSync(file, 'utf8'))).asOf, '2027-01-02');

  writeFileSync(file, SOURCE);
  writeFileSync(page, PAGE.replace('* $2.50\n', '* $25.00\n'));
  assert.equal(await run('--write'), 2);
  assert.equal(readFileSync(file, 'utf8'), SOURCE, 'a refused change writes nothing');
  assert.equal(await run('--write', '--force'), 0);
  assert.equal((await readPricesBlock(readFileSync(file, 'utf8'))).models[LITE].output, 25);

  writeFileSync(file, SOURCE);
  writeFileSync(page, 'garbage');
  await assert.rejects(run('--write', '--force'), PricingError);
  assert.equal(readFileSync(file, 'utf8'), SOURCE);
  await assert.rejects(main(['--bogus'], { log: quiet }), PricingError);
});

test('rewriting keeps the line endings of the file, as checked out on Windows', async () => {
  const lf = readFileSync(new URL('../../../src/usage/pricing.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const crlf = lf.replaceAll('\n', '\r\n');
  const table = await readPricesBlock(lf);
  assert.equal(replacePricesBlock(lf, table), lf);
  assert.equal(replacePricesBlock(crlf, table), crlf);
  assert.deepEqual(await readPricesBlock(crlf), table);
});
