import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLatency, measure, VARIANTS } from '../scripts/tuning/latency.mjs';

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
