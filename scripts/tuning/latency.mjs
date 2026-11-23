#!/usr/bin/env node
// Measures how fast the translation model answers one short request, with the request options the
// app uses and with alternatives, so a slow replay can be told apart from a slow model.
// See docs/tuning.md.
//
//   GEMINI_API_KEY=... node scripts/tuning/latency.mjs [--model gemini-3.5-flash-lite] [--count 5]
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

async function once({ apiKey, model, config, fetchImpl = fetch, now = () => performance.now() }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: `<text>\n${TEXT}\n</text>` }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024, ...config },
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
  return { status: 200, firstMs, totalMs: now() - start, thoughts, chars };
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
  const rows = [];
  for (const request of requests) {
    const firsts = [];
    const totals = [];
    let error = null;
    for (let i = 0; i < count; i++) {
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
        totals.push(now() - start);
        if (first !== null) firsts.push(first);
      } catch (err) {
        error = String(err?.message ?? err)
          .replace(/\s+/g, ' ')
          .slice(0, 100);
      }
    }
    rows.push({
      name: request.name,
      count,
      ok: totals.length,
      firstMs: median(firsts),
      totalMs: median(totals),
      thoughts: null,
      error,
    });
    say(`  ${request.name}: done`);
  }
  return rows;
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
    'thinking tokens',
    'error',
  ];
  const lines = rows.map((r) => [
    r.name,
    `${r.ok}/${r.count}`,
    ms(r.firstMs),
    ms(r.totalMs),
    ms(r.thoughts),
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

export async function measure({ apiKey, model, count, variants = VARIANTS, fetchImpl, now, say = () => {} }) {
  const rows = [];
  for (const variant of variants) {
    const results = [];
    for (let i = 0; i < count; i++) results.push(await once({ apiKey, model, config: variant.config, fetchImpl, now }));
    const good = results.filter((r) => r.status === 200);
    rows.push({
      name: variant.name,
      count,
      ok: good.length,
      firstMs: median(good.map((r) => r.firstMs).filter((x) => x !== null)),
      totalMs: median(good.map((r) => r.totalMs)),
      thoughts: median(good.map((r) => r.thoughts)),
      error:
        results.find((r) => r.error)?.error &&
        `HTTP ${results.find((r) => r.error).status}: ${results.find((r) => r.error).error}`,
    });
    say(`  ${variant.name}: done`);
  }
  return rows;
}

export async function main(argv, { log = console.log, warn = console.error, env = process.env } = {}) {
  let model = 'gemini-3.5-flash-lite';
  let count = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') model = argv[++i];
    else if (argv[i] === '--count') count = Number(argv[++i]);
    else
      throw new Error(
        `Unknown option: ${argv[i]}\nUsage: GEMINI_API_KEY=... node scripts/tuning/latency.mjs [--model name] [--count 5]`,
      );
  }
  if (!(count > 0)) throw new Error('--count must be a positive number');
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Set GEMINI_API_KEY in the environment.');
  warn(`Model: ${model}. ${count} requests per row, one after another; about a minute.`);
  const probe = new GeminiTranslator({ apiKey, model, langA: 'Japanese', langB: 'English' });
  warn(`The app sends the thinking option to this model: ${probe.useThinkingConfig ? 'yes' : 'no'}.`);
  warn('Request options, with a bare request:');
  const rows = await measure({ apiKey, model, count, say: warn });
  log(formatLatency(rows));
  warn('\nRequests as the app builds them:');
  const appRows = await measureApp({ apiKey, model, count, say: warn });
  log(`\n${formatLatency(appRows)}`);
  warn(`
first text ms     until the first piece of the translation arrives
whole answer ms   until the answer is complete
thinking tokens   tokens the model spent thinking before answering; 0 is what a live translation wants
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
