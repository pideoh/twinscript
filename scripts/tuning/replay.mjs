#!/usr/bin/env node
// Replays a recorded recognizer trace through the app's segmentation and in-progress translation
// pacing, with the real translation model (or a fake one with --mock), and scores how the
// translations appeared: delay and flicker. See "Tuning tools" in CONTRIBUTING.md.
//
//   GEMINI_API_KEY=... node scripts/tuning/replay.mjs <trace.json> [--strategy interval[,other]]
//     [--interval 1.5] [--speed 1] [--mock] [--out result.json]
//
// The translation flow below mirrors src/app.js (createTracker, the pacer's callbacks,
// translateInterimLines, translateFinal, translateFinalLines, recentHistory) for two languages,
// without the DOM. Keep the two in step when that flow changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createPacer, DEFAULT_STRATEGY } from '../../src/pacer.js';
import { sourceByScript, targetByScript, targetLanguages } from '../../src/script-hint.js';
import { UtteranceTracker } from '../../src/segmenter.js';
import { GeminiTranslator, RateLimitError } from '../../src/translator.js';
import { createVirtualClock } from './clock.mjs';
import { aggregate, formatTable, sentenceMetrics } from './metrics.mjs';

// Codes and English names as in LANGS in src/app.js (test/tuning-replay.test.js keeps them equal).
export const LANGS = [
  ['ja-JP', 'Japanese'],
  ['en-US', 'English'],
  ['cmn-Hans-CN', 'Simplified Chinese'],
  ['cmn-Hant-TW', 'Traditional Chinese'],
  ['ko-KR', 'Korean'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['it-IT', 'Italian'],
  ['pt-BR', 'Portuguese'],
  ['vi-VN', 'Vietnamese'],
  ['th-TH', 'Thai'],
  ['id-ID', 'Indonesian'],
  ['hi-IN', 'Hindi'],
].map(([code, name]) => ({ code, name }));

// The app's defaults (DEFAULTS and HISTORY_LINES in src/app.js).
const MODEL = 'gemini-3.5-flash-lite';
const HISTORY_LINES = 3;
const OTHER_INTO = 'all';
const MOCK_LATENCY_MS = 400;

// A translator that answers after a fixed delay with the target and the text, the same every run.
export class MockTranslator {
  constructor({ langA, langB, otherInto = langA, setTimer, latencyMs = MOCK_LATENCY_MS }) {
    this.langs = { langA, langB, otherInto };
    this.setTimer = setTimer;
    this.latencyMs = latencyMs;
  }

  async translate(text, { onDelta, onTarget, into: chosen } = {}) {
    const into = chosen || targetByScript(text, this.langs);
    onTarget?.(into);
    await new Promise((resolve) => this.setTimer(resolve, this.latencyMs));
    const out = `[${into ?? 'auto'}] ${text}`;
    onDelta?.(out);
    return out;
  }

  async identify() {
    return 'other';
  }
}

// Runs one strategy over a trace. clock: { now, setTimer, clearTimer } plus runAll() when simulated.
export async function replay({ trace, strategy = DEFAULT_STRATEGY, interval = 1.5, speed = 1, clock, translator }) {
  const langs = trace.langs.slice(0, 2).map((code) => {
    const lang = LANGS.find((l) => l.code === code);
    if (!lang) throw new Error(`Unknown language code in trace: ${code}`);
    return lang;
  });
  const names = langs.map((l) => l.name);
  const counts = { requests: 0, rateLimited: 0 };
  const counted = async (call) => {
    counts.requests++;
    try {
      return await call();
    } catch (err) {
      if (err instanceof RateLimitError) counts.rateLimited++;
      throw err;
    }
  };
  const tr = {
    translate: (text, opts) => counted(() => translator.translate(text, opts)),
    identify: (text, list) => counted(() => translator.identify(text, list)),
  };

  const segments = []; // finished sentences, in the order the app keeps them
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };
  let nextId = 1;
  let live = null;

  const newRecord = () => ({
    id: nextId++,
    src: '',
    firstInterimAt: null,
    finishedAt: null,
    finalShownAt: null,
    finalText: null,
    displays: [],
    single: '',
    tgts: null, // [{ lang, text }] for a sentence in neither language (one line per target)
    lines: null, // Map code -> shown text
    tgt: '',
    rev: 0,
  });
  const shownText = (rec) =>
    rec.lines
      ? rec.tgts
          .map((x) => rec.lines.get(x.lang))
          .filter(Boolean)
          .join('\n')
      : rec.single;
  const redraw = (rec) => {
    const text = shownText(rec);
    if (text !== (rec.displays.at(-1)?.text ?? '')) rec.displays.push({ t: clock.now(), text });
  };
  const setSingle = (rec, text) => {
    rec.single = text;
    redraw(rec);
  };
  const setLine = (rec, code, text) => {
    rec.lines.set(code, text);
    redraw(rec);
  };
  const setTargets = (rec, codes) => {
    if (rec.tgts && rec.lines && rec.tgts.map((x) => x.lang).join() === codes.join()) return false;
    rec.tgts = codes.map((lang) => ({ lang, text: '' }));
    rec.lines = new Map();
    redraw(rec);
    return true;
  };
  const clearTargets = (rec) => {
    if (!rec.tgts) return;
    rec.single = shownText(rec);
    rec.tgts = null;
    rec.lines = null;
  };

  const langName = (code) => langs.find((l) => l.code === code)?.name;
  const targetsFor = (source) =>
    targetLanguages(names, source, OTHER_INTO).map((name) => langs.find((l) => l.name === name).code);
  const intoSeveral = (text) => sourceByScript(text, names) === 'other' && targetsFor('other').length > 1;
  const recentHistory = (lang) =>
    segments
      .filter((x) => x.tgt)
      .slice(-HISTORY_LINES)
      .map(({ src, tgt, tgts }) => ({ src, tgt: (lang && tgts?.find((x) => x.lang === lang)?.text) || tgt }));
  const wait = (ms) => new Promise((resolve) => clock.setTimer(resolve, ms));

  async function interimLines(rec, text, isCurrent) {
    const source = sourceByScript(text, names);
    if (!source) return;
    const targets = targetsFor(source);
    setTargets(rec, targets);
    const results = await Promise.allSettled(
      targets.map(async (code) => {
        const out = await tr.translate(text, { history: recentHistory(code), into: langName(code) });
        if (isCurrent() && out && rec.tgts?.some((x) => x.lang === code)) setLine(rec, code, out);
      }),
    );
    const limited = results.find((x) => x.status === 'rejected' && x.reason instanceof RateLimitError);
    if (limited) throw limited.reason;
  }

  async function translateFinal(rec) {
    if (intoSeveral(rec.src)) return translateFinalLines(rec);
    const history = recentHistory();
    rec.rev++;
    const rev = rec.rev;
    clearTargets(rec);
    const swapWhenDone = !!shownText(rec);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await tr.translate(rec.src, {
          history,
          onDelta: (partial) => {
            if (rec.rev === rev && !swapWhenDone) setSingle(rec, partial);
          },
        });
        if (rec.rev !== rev) return;
        rec.tgt = out;
        setSingle(rec, out);
        rec.finalText = out;
        rec.finalShownAt = clock.now();
        return;
      } catch (err) {
        if (err instanceof RateLimitError && attempt < 3) {
          await wait(1500 * 2 ** attempt);
          continue;
        }
        if (rec.rev === rev) rec.error = String(err.message ?? err);
        return;
      }
    }
  }

  async function translateFinalLines(rec) {
    rec.rev++;
    const rev = rec.rev;
    const source = sourceByScript(rec.src, names) ?? (await tr.identify(rec.src, names).catch(() => 'other'));
    if (rec.rev !== rev) return;
    const targets = targetsFor(source);
    const kept = !setTargets(rec, targets);
    const swap = new Set(kept ? targets.filter((code) => rec.lines.get(code)) : []);
    await Promise.all(targets.map((code) => translateLine(rec, rev, code, swap.has(code))));
    if (rec.rev === rev && rec.tgts.every((x) => x.text)) {
      rec.finalText = shownText(rec);
      rec.finalShownAt = clock.now();
    }
  }

  async function translateLine(rec, rev, code, swapWhenDone) {
    const history = recentHistory(code);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await tr.translate(rec.src, {
          history,
          into: langName(code),
          onDelta: (partial) => {
            if (rec.rev === rev && !swapWhenDone) setLine(rec, code, partial);
          },
        });
        if (rec.rev !== rev) return;
        rec.tgts.find((x) => x.lang === code).text = out;
        rec.tgt = rec.tgts
          .map((x) => x.text)
          .filter(Boolean)
          .join('\n');
        setLine(rec, code, out);
        return;
      } catch (err) {
        if (err instanceof RateLimitError && attempt < 3) {
          await wait(1500 * 2 ** attempt);
          continue;
        }
        if (rec.rev === rev) rec.error = String(err.message ?? err);
        return;
      }
    }
  }

  const pacer = createPacer({
    strategy,
    options: { interval },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    translate: (text, { isCurrent }) => {
      const p = intoSeveral(text)
        ? interimLines(live, text, isCurrent)
        : tr.translate(text, { history: recentHistory() });
      track(p.catch(() => {}));
      return p;
    },
    show: (out) => {
      clearTargets(live);
      setSingle(live, out);
    },
  });

  const commit = (rec, text) => {
    rec.src = text;
    rec.finishedAt = clock.now();
    if (!segments.includes(rec)) segments.push(rec);
    track(translateFinal(rec));
    return rec;
  };
  const tracker = new UtteranceTracker({
    commit(text, aboveLive) {
      if (aboveLive) return commit(newRecord(), text);
      const rec = live ?? newRecord();
      live = null;
      pacer.finish();
      return commit(rec, text);
    },
    setLive(text) {
      if (!text) {
        live = null;
        pacer.cancel();
        return;
      }
      live ??= newRecord();
      live.firstInterimAt ??= clock.now();
      live.src = text;
      pacer.update(text);
    },
    correct: (rec, text) => commit(rec, text),
  });

  const start = clock.now();
  const at = (ms) => Math.max(0, start + ms / speed - clock.now());
  for (const e of trace.events) {
    clock.setTimer(() => (e.kind === 'final' ? tracker.final(e.text) : tracker.interim(e.text)), at(e.t));
  }
  const end = Math.max(trace.durationMs ?? 0, ...trace.events.map((e) => e.t));
  const ended = new Promise((resolve) =>
    clock.setTimer(() => {
      // as stop() does
      tracker.flush();
      pacer.cancel();
      resolve();
    }, at(end)),
  );
  if (clock.runAll) await clock.runAll();
  await ended;
  while (pending.size || clock.pending?.()) {
    if (clock.runAll) await clock.runAll();
    await Promise.all([...pending]);
  }

  const sentences = segments.map((rec) => ({
    id: rec.id,
    src: rec.src,
    firstInterimAt: rec.firstInterimAt === null ? null : rec.firstInterimAt - start,
    finishedAt: rec.finishedAt - start,
    finalShownAt: rec.finalShownAt === null ? null : rec.finalShownAt - start,
    finalText: rec.finalText,
    error: rec.error,
    displays: rec.displays.map((d) => ({ t: d.t - start, text: d.text })),
  }));
  const rows = sentences.map((s) => ({ id: s.id, ...sentenceMetrics(s) }));
  return {
    label: `${strategy} ${interval}s`,
    strategy,
    options: { interval, speed },
    summary: aggregate(rows, counts),
    sentences: sentences.map((s, i) => ({ ...s, metrics: rows[i] })),
  };
}

export function parseArgs(argv) {
  const args = { strategies: [DEFAULT_STRATEGY], interval: 1.5, speed: 1, mock: false, out: null, trace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--strategy') args.strategies = value().split(',').filter(Boolean);
    else if (a === '--interval') args.interval = Number(value());
    else if (a === '--speed') args.speed = Number(value());
    else if (a === '--mock') args.mock = true;
    else if (a === '--out') args.out = value();
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else args.trace = a;
  }
  if (!args.trace) throw new Error('Usage: node scripts/tuning/replay.mjs <trace.json> [options]');
  if (!(args.interval > 0)) throw new Error('--interval must be a positive number of seconds');
  if (!(args.speed > 0)) throw new Error('--speed must be a positive number');
  return args;
}

function realClock() {
  return {
    // Wall-clock based like Date.now() in the app: the pacer's "last request" starts at 0.
    now: () => performance.timeOrigin + performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
  };
}

export async function main(argv, { log = console.log, warn = console.error, env = process.env } = {}) {
  const args = parseArgs(argv);
  const trace = JSON.parse(readFileSync(args.trace, 'utf8'));
  if (trace.version !== 1) throw new Error(`Unsupported trace version: ${trace.version}`);
  if (trace.langs.length > 2) warn(`Note: the trace has ${trace.langs.length} languages; only the first two are used.`);
  const apiKey = env.GEMINI_API_KEY;
  if (!args.mock && !apiKey) throw new Error('Set GEMINI_API_KEY in the environment, or pass --mock.');
  const [langA, langB] = trace.langs.slice(0, 2).map((code) => LANGS.find((l) => l.code === code)?.name);
  const runs = [];
  for (const strategy of args.strategies) {
    // --mock runs on a simulated clock: instant and the same on every run.
    const clock = args.mock ? createVirtualClock(Date.parse(trace.startedAt) || Date.UTC(2026, 0, 1)) : realClock();
    const translator = args.mock
      ? new MockTranslator({ langA, langB, setTimer: clock.setTimer })
      : new GeminiTranslator({ apiKey, model: MODEL, langA, langB, otherInto: langA });
    runs.push(await replay({ trace, strategy, interval: args.interval, speed: args.speed, clock, translator }));
  }
  log(formatTable(runs));
  if (args.out) writeFileSync(args.out, `${JSON.stringify({ trace: args.trace, mock: args.mock, runs }, null, 2)}\n`);
  return runs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
