#!/usr/bin/env node
// Replays a recorded recognizer trace through the app's segmentation and in-progress translation
// pacing, with the real translation model (or a fake one with --mock), and scores how the
// translations appeared: delay and flicker. See docs/tuning.md.
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
// onProgress({ traceMs, sentences, requests, rateLimited, failed, lastError }) is called whenever one
// of those changes; traceMs is how far into the trace the replay is.
export async function replay({
  trace,
  strategy = DEFAULT_STRATEGY,
  interval = 1.5,
  speed = 1,
  clock,
  translator,
  onProgress,
}) {
  const langs = trace.langs.slice(0, 2).map((code) => {
    const lang = LANGS.find((l) => l.code === code);
    if (!lang) throw new Error(`Unknown language code in trace: ${code}`);
    return lang;
  });
  const names = langs.map((l) => l.name);
  const counts = { requests: 0, rateLimited: 0, failed: 0, answered: 0, lastError: null };
  let traceNow = () => 0;
  const report = () =>
    onProgress?.({
      traceMs: traceNow(),
      sentences: segments.length,
      requests: counts.requests,
      rateLimited: counts.rateLimited,
      failed: counts.failed,
      answered: counts.answered,
      lastError: counts.lastError,
    });
  const counted = async (call) => {
    counts.requests++;
    try {
      const out = await call();
      counts.answered++;
      return out;
    } catch (err) {
      if (err instanceof RateLimitError) counts.rateLimited++;
      else {
        counts.failed++;
        counts.lastError = String(err?.message ?? err);
      }
      throw err;
    } finally {
      report();
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
    if (!segments.includes(rec)) {
      segments.push(rec);
      report();
    }
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
  traceNow = () => Math.round((clock.now() - start) * speed);
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

export const USAGE = `Replays a recorded recognizer trace and scores how the translations appeared.

  GEMINI_API_KEY=... node scripts/tuning/replay.mjs <trace.json> [options]
  node scripts/tuning/replay.mjs test/fixtures/replay-trace.json --mock

Options
  --strategy a,b   pacing strategies to compare, one run each (default: interval)
  --interval 1.5   seconds between in-progress translations for the interval strategy
  --speed 1        play the speech faster; delays are then not comparable, use it for a dry run only
  --mock           fake translator on a simulated clock: no key, instant, same numbers every time
  --out file.json  also write every sentence's timeline
  --quiet          print only the table
  --help           this text

A trace comes from the app opened with ?debug=1 (Download → recognizer trace).
With the real model a run takes as long as the speech in the trace. See docs/tuning.md.`;

const LEGEND = `
first ms   from a sentence's first words to its first translation on screen (lower is better)
final ms   from the end of a sentence to its complete translation (lower is better)
flicker    share of shown translation that was erased rather than extended; 0 = it only ever grew
erased / updates   the totals behind flicker
requests   translation requests sent; rateLimited: how many hit the rate limit
Each cell is mean/median/p90 over the sentences.`;

export function parseArgs(argv) {
  const args = {
    strategies: [DEFAULT_STRATEGY],
    interval: 1.5,
    speed: 1,
    mock: false,
    out: null,
    trace: null,
    help: false,
    quiet: false,
  };
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
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') args.out = value();
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else args.trace = a;
  }
  if (args.help) return args;
  if (!args.trace) throw new Error(`No trace file given.\n\n${USAGE}`);
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

const clockTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const PROGRESS_EVERY_MS = 10_000;
// Requests that fail before any has succeeded mean the key or the model is wrong: stop early
// instead of replaying the whole trace for nothing.
const GIVE_UP_AFTER_FAILURES = 5;

export async function main(argv, { log = console.log, warn = console.error, env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return [];
  }
  const trace = JSON.parse(readFileSync(args.trace, 'utf8'));
  if (trace.version !== 1) throw new Error(`Unsupported trace version: ${trace.version}`);
  if (!Array.isArray(trace.events) || !trace.events.length) throw new Error('The trace has no recognizer results.');
  if (trace.langs.length > 2) warn(`Note: the trace has ${trace.langs.length} languages; only the first two are used.`);
  const apiKey = env.GEMINI_API_KEY;
  if (!args.mock && !apiKey) throw new Error('Set GEMINI_API_KEY in the environment, or pass --mock.');
  const [langA, langB] = trace.langs.slice(0, 2).map((code) => LANGS.find((l) => l.code === code)?.name);
  const say = args.quiet ? () => {} : warn; // progress goes to stderr, so stdout holds only the table
  const lengthMs = Math.max(trace.durationMs ?? 0, ...trace.events.map((e) => e.t));
  const finals = trace.events.filter((e) => e.kind === 'final').length;
  say(
    `Trace: ${clockTime(lengthMs)} of speech, ${trace.events.length} recognizer results (${finals} final), ${langA} / ${langB}.`,
  );
  if (args.mock) say('Translator: mock on a simulated clock; this takes a moment.');
  else {
    const each = lengthMs / args.speed;
    say(
      `Translator: ${MODEL}. Each strategy replays in real time: about ${clockTime(each)}` +
        (args.strategies.length > 1
          ? `, ${clockTime(each * args.strategies.length)} for all ${args.strategies.length}.`
          : '.'),
    );
    if (args.speed !== 1)
      say('Note: with --speed the speech is shortened but the model answers no faster, so delays are not comparable.');
  }

  const runs = [];
  for (const strategy of args.strategies) {
    // --mock runs on a simulated clock: instant and the same on every run.
    const clock = args.mock ? createVirtualClock(Date.parse(trace.startedAt) || Date.UTC(2026, 0, 1)) : realClock();
    const translator = args.mock
      ? new MockTranslator({ langA, langB, setTimer: clock.setTimer })
      : new GeminiTranslator({ apiKey, model: MODEL, langA, langB, otherInto: langA });
    let last = null;
    let giveUp = null;
    const failure = new Promise((_resolve, reject) => {
      giveUp = reject;
    });
    const line = () =>
      last &&
      say(
        `  ${strategy}: ${clockTime(last.traceMs)} / ${clockTime(lengthMs)}, ${last.sentences} sentences, ` +
          `${last.requests} requests` +
          (last.rateLimited ? `, ${last.rateLimited} rate-limited` : '') +
          (last.failed ? `, ${last.failed} failed (${last.lastError})` : ''),
      );
    const ticker = args.mock ? null : setInterval(line, PROGRESS_EVERY_MS);
    try {
      const run = replay({
        trace,
        strategy,
        interval: args.interval,
        speed: args.speed,
        clock,
        translator,
        onProgress: (p) => {
          last = p;
          if (!p.answered && p.failed >= GIVE_UP_AFTER_FAILURES)
            giveUp(
              new Error(`Stopped: the first ${p.failed} translation requests all failed. Last error: ${p.lastError}`),
            );
        },
      });
      runs.push(await Promise.race([run, failure]));
    } finally {
      clearInterval(ticker);
    }
    line();
  }
  log(formatTable(runs));
  say(LEGEND);
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify({ trace: args.trace, mock: args.mock, runs }, null, 2)}\n`);
    say(`Every sentence's timeline is in ${args.out} (it contains what was said; keep it out of the repository).`);
  }
  return runs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0), // do not wait for requests still in flight after an early stop
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
