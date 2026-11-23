import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_REQUESTS, formatLatency, measure, measureApp, VARIANTS } from '../scripts/tuning/latency.mjs';

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');

test('each set of request options is timed and its thinking tokens are reported', async () => {
  let t = 0;
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ body, key: init.headers['x-goog-api-key'], url: _url });
    const cfg = body.generationConfig.thinkingConfig;
    if (cfg?.thinkingBudget === 0)
      return new Response(JSON.stringify({ error: { message: 'thinkingBudget is not supported' } }), { status: 400 });
    t += cfg ? 500 : 3000; // answers are slower without a thinking option
    return new Response(
      sse([
        { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] },
        {
          candidates: [{ content: { parts: [{ text: "Let's begin." }] } }],
          usageMetadata: { thoughtsTokenCount: cfg ? 0 : 210 },
        },
      ]),
      { status: 200 },
    );
  };
  const rows = await measure({ apiKey: 'KEY', model: 'm-1', count: 2, fetchImpl, now: () => t });
  assert.equal(rows.length, VARIANTS.length);
  assert.deepEqual(
    rows.map((r) => [r.name, r.ok, r.totalMs, r.thoughts]),
    [
      ['app (thinkingLevel minimal)', 2, 500, 0],
      ['no thinking option', 2, 3000, 210],
      ['thinkingBudget 0', 0, null, null],
      ['thinkingLevel low', 2, 500, 0],
    ],
  );
  assert.match(rows[2].error, /^HTTP 400: thinkingBudget is not supported/);
  assert.ok(
    bodies.every((b) => b.key === 'KEY' && !b.url.includes('KEY')),
    'the key travels in a header only',
  );
  const table = formatLatency(rows);
  assert.ok(!table.includes('KEY'));
  assert.match(table.split('\n')[0], /^request options +ok +first text ms/);
});

test("the app's own requests are timed one feature at a time", async () => {
  const realFetch = globalThis.fetch;
  let t = 0;
  const systems = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const system = body.systemInstruction.parts[0].text;
    systems.push(system);
    t += /already on screen/.test(system) ? 3000 : 600; // continuing a shown translation is the slow part here
    const text = body.generationConfig.responseMimeType ? '{"language":"Japanese"}' : 'ok';
    return new Response(sse([{ candidates: [{ content: { parts: [{ text }] } }] }]), { status: 200 });
  };
  try {
    const rows = await measureApp({ apiKey: 'KEY', model: 'gemini-3.5-flash-lite', count: 1, now: () => t });
    assert.deepEqual(
      rows.map((r) => r.name),
      APP_REQUESTS.map((r) => r.name),
    );
    assert.ok(rows.every((r) => r.ok === 1 && !r.error));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.totalMs]));
    assert.equal(byName.translate, 600);
    assert.equal(byName['translate, continuing a shown translation'], 3000);
    assert.equal(systems.filter((x) => /already on screen/.test(x)).length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the tier that served a request is taken from the response and shown', async () => {
  let t = 0;
  const fetchImpl = async () => {
    t += 700;
    return new Response(sse([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]), {
      status: 200,
      headers: { 'x-gemini-service-tier': 'standard' },
    });
  };
  const variants = VARIANTS.filter((v) => /no thinking/.test(v.name));
  const rows = await measure({ apiKey: 'KEY', model: 'm-1', count: 3, variants, fetchImpl, now: () => t });
  assert.deepEqual(
    rows.map((r) => [r.name, r.totalMs, r.tier]),
    [['no thinking option', 700, 'standard']],
  );
  assert.match(formatLatency(rows), /served by/);
});
