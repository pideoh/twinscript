#!/usr/bin/env node
// Measures how fast the translation model answers one short request, with the request options the
// app uses and with alternatives, so a slow replay can be told apart from a slow model.
// See docs/tuning.md.
//
//   GEMINI_API_KEY=... node scripts/tuning/latency.mjs [--model gemini-3.5-flash-lite] [--count 8]
//
// It sends a fixed, harmless sentence; nothing from a trace. The key is read from the environment
// and never printed.
import { pathToFileURL } from 'node:url';
import { GeminiTranslator } from '../../src/translator.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const TEXT = 'それでは本日の定例会議を始めます。まず先週の進捗について共有をお願いします。';
const SYSTEM =
  'You are a professional real-time interpreter. The user message contains a speech transcript inside <text>. Translate it into English. Output only the translation.';

// What is put into generationConfig for each variant; "app" is what src/translator.js sends.
export const VARIANTS = [
  { name: 'app (thinkingLevel minimal)', config: { thinkingConfig: { thinkingLevel: 'minimal' } } },
  { name: 'no thinking option', config: {} },
  { name: 'thinkingBudget 0', config: { thinkingConfig: { thinkingBudget: 0 } } },
  { name: 'thinkingLevel low', config: { thinkingConfig: { thinkingLevel: 'low' } } },
];

async function once({ apiKey, model, config, top = {}, fetchImpl = fetch, now = () => performance.now() }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: `<text>\n${TEXT}\n</text>` }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024, ...config },
    ...top,
  };
  const start = now();
  const res = await fetchImpl(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail;
    try {
      message = JSON.parse(detail).error.message;
    } catch {
      /* keep raw */
    }
    return { status: res.status, error: String(message).replace(/\s+/g, ' ').slice(0, 100) };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstMs = null;
  let thoughts = 0;
  let chars = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const chunk = JSON.parse(line.slice(5));
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        const text = parts
          .filter((p) => !p.thought)
          .map((p) => p.text || '')
          .join('');
        if (text && firstMs === null) firstMs = now() - start;
        chars += text.length;
        thoughts = chunk.usageMetadata?.thoughtsTokenCount ?? thoughts;
      } catch {
        /* partial line */
      }
    }
  }
  return {
    status: 200,
    firstMs,
    totalMs: now() - start,
    thoughts,
    chars,
    tier: res.headers.get('x-gemini-service-tier'),
  };
}

// The same model asked the way the app asks it (src/translator.js), one feature at a time, to see
// which part of a real request costs time. The sentences are fixed and harmless.
const HISTORY = [
  { src: 'おはようございます。', tgt: 'Good morning.' },
  { src: 'Thanks for joining today.', tgt: '本日はご参加ありがとうございます。' },
  { src: '資料は共有フォルダにあります。', tgt: 'The materials are in the shared folder.' },
];
export const APP_REQUESTS = [
  { name: 'translate', run: (tr, o) => tr.translate(TEXT, o) },
  { name: 'translate, earlier lines as context', run: (tr, o) => tr.translate(TEXT, { ...o, history: HISTORY }) },
  {
    name: 'translate, continuing a shown translation',
    run: (tr, o) => tr.translate(TEXT, { ...o, previous: "Let's begin today's regular meeting." }),
  },
  {
    name: 'translate, context and shown translation',
    run: (tr, o) => tr.translate(TEXT, { ...o, history: HISTORY, previous: "Let's begin today's regular meeting." }),
  },
  { name: 'translate, model picks the direction', run: (tr, o) => tr.translate('OK then', o) },
  { name: 'identify the language', run: (tr) => tr.identify('了解', ['Japanese', 'English']) },
];

export async function measureApp({
  apiKey,
  model,
  count,
  requests = APP_REQUESTS,
  now = () => performance.now(),
  say = () => {},
}) {
  const data = requests.map(() => ({ firsts: [], totals: [], error: null }));
  for (let round = 0; round < count; round++) {
    for (const [i, request] of requests.entries()) {
      // A new translator each time, as a session starts with one.
      const tr = new GeminiTranslator({ apiKey, model, langA: 'Japanese', langB: 'English' });
      const start = now();
      let first = null;
      try {
        await request.run(tr, {
          onDelta: () => {
            first ??= now() - start;
          },
        });
        data[i].totals.push(now() - start);
        if (first !== null) data[i].firsts.push(first);
      } catch (err) {
        data[i].error = String(err?.message ?? err)
          .replace(/\s+/g, ' ')
          .slice(0, 100);
      }
    }
    say(`  round ${round + 1} of ${count}`);
  }
  return requests.map((request, i) => ({
    name: request.name,
    count,
    ok: data[i].totals.length,
    firstMs: median(data[i].firsts),
    totalMs: median(data[i].totals),
    minMs: data[i].totals.length ? Math.min(...data[i].totals) : null,
    maxMs: data[i].totals.length ? Math.max(...data[i].totals) : null,
    thoughts: null,
    error: data[i].error,
  }));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const ms = (x) => (x === null ? '-' : String(Math.round(x)));

export function formatLatency(rows) {
  const head = [
    'request options',
    'ok',
    'first text ms (median)',
    'whole answer ms (median)',
    'fastest-slowest',
    'thinking tokens',
    'served by',
    'error',
  ];
  const lines = rows.map((r) => [
    r.name,
    `${r.ok}/${r.count}`,
    ms(r.firstMs),
    ms(r.totalMs),
    r.minMs == null ? '-' : `${ms(r.minMs)}-${ms(r.maxMs)}`,
    ms(r.thoughts),
    r.tier ?? '-',
    r.error ?? '',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const row = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [row(head), ...lines.map(row)].join('\n');
}

// Rounds, not blocks: every variant is asked once per round, in turn. The model's speed drifts from
// minute to minute, and asking one variant five times and then the next would measure the drift.
export async function measure({ apiKey, model, count, variants = VARIANTS, fetchImpl, now, say = () => {} }) {
  const results = variants.map(() => []);
  for (let round = 0; round < count; round++) {
    for (const [i, variant] of variants.entries())
      results[i].push(await once({ apiKey, model, config: variant.config, top: variant.top, fetchImpl, now }));
    say(`  round ${round + 1} of ${count}`);
  }
  return variants.map((variant, i) => {
    const good = results[i].filter((r) => r.status === 200);
    const bad = results[i].find((r) => r.error);
    const totals = good.map((r) => r.totalMs);
    return {
      name: variant.name,
      count,
      ok: good.length,
      firstMs: median(good.map((r) => r.firstMs).filter((x) => x !== null)),
      totalMs: median(totals),
      minMs: totals.length ? Math.min(...totals) : null,
      maxMs: totals.length ? Math.max(...totals) : null,
      thoughts: median(good.map((r) => r.thoughts)),
      tier: [...new Set(good.map((r) => r.tier).filter(Boolean))].join('/') || null,
      error: bad && `HTTP ${bad.status}: ${bad.error}`,
    };
  });
}

export async function main(argv, { log = console.log, warn = console.error, env = process.env } = {}) {
  let model = 'gemini-3.5-flash-lite';
  let count = 8;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') model = argv[++i];
    else if (argv[i] === '--count') count = Number(argv[++i]);
    else
      throw new Error(
        `Unknown option: ${argv[i]}\nUsage: GEMINI_API_KEY=... node scripts/tuning/latency.mjs [--model name] [--count 8]`,
      );
  }
  if (!(count > 0)) throw new Error('--count must be a positive number');
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Set GEMINI_API_KEY in the environment.');
  warn(
    `Model: ${model}. ${count} requests per row, asked in rounds so every row meets the same conditions; a few minutes.`,
  );
  const probe = new GeminiTranslator({ apiKey, model, langA: 'Japanese', langB: 'English' });
  warn(`The app sends the thinking option to this model: ${probe.useThinkingConfig ? 'yes' : 'no'}.`);
  warn('Request options, with a bare request:');
  const rows = await measure({ apiKey, model, count, say: warn });
  log(formatLatency(rows));
  warn('\nRequests as the app builds them:');
  const appRows = await measureApp({ apiKey, model, count, say: warn });
  log(`\n${formatLatency(appRows)}`);
  warn(`
Rows are asked in turn, round after round, because the model's speed drifts from minute to minute.
fastest-slowest   the spread of the whole answer; a wide spread means the model's speed was changing
first text ms     until the first piece of the translation arrives
whole answer ms   until the answer is complete
thinking tokens   tokens the model spent thinking before answering; 0 is what a live translation wants
served by         the service tier the response names (standard, priority), when it names one
In the first table, the first row is the option the app used to send to every model.
The second table uses the app's own requests: a row much slower than "translate" shows which part of a request costs time.`);
  return [...rows, ...appRows];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
