#!/usr/bin/env node
// Replays a recorded recognizer trace through the app's translation flow (src/translation/flow.js:
// segmentation, in-progress translation paced by src/translation/pacer.js, final translations), with
// the real translation model (or a fake one with --mock), and scores how the translations appeared:
// delay and flicker. See docs/tuning.md.
//
//   GEMINI_API_KEY=... node scripts/tuning/replay.mjs <trace.json> [--strategy interval[,other]]
//     [--interval 1.5] [--speed 1] [--mock | --mock=rephrase] [--out result.json]
//
// The flow runs as in the app for two languages, with a view that records what would be shown
// (recording-view.mjs), the clock of the run (simulated with --mock) and reading aloud off.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createFlow } from '../../src/translation/flow.js';
import { DEFAULT_STRATEGY, STRATEGIES } from '../../src/translation/pacer.js';
import { targetByScript } from '../../src/translation/script-hint.js';
import { GeminiTranslator, RateLimitError } from '../../src/translation/translator.js';
import { createVirtualClock } from './clock.mjs';
import { aggregate, formatHealth, formatTable, health, sentenceMetrics } from './metrics.mjs';
import { createRecordingView } from './recording-view.mjs';

// Codes and English names as in LANGS in src/ui/langs.js (test/unit/scripts/tuning-replay.test.js keeps them equal).
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

// The app's defaults (DEFAULTS in src/storage/settings.js).
const MODEL = 'gemini-3.5-flash-lite';
const OTHER_INTO = 'all';
const MOCK_LATENCY_MS = 400;

// The units the fake translator works in: words where the speech has spaces, else characters.
const spaced = (text) => /\s/.test(text);
const units = (s, text) => (spaced(text) ? s.split(/\s+/).filter(Boolean) : Array.from(s));

// A translator that answers after a fixed delay with the target and the text, the same every run.
// rephrase: like a model that reorders, it puts the newest unit (word or character) first, so its
// answer for a longer text is not an extension of its answer for a shorter one; flicker shows.
// Given `previous` (a translation already shown), it keeps that and appends the units of the text
// beyond as many as `previous` holds (rephrased the same way), so a strategy that carries the shown
// translation does not flicker.
export class MockTranslator {
  constructor({ langA, langB, otherInto = langA, setTimer, latencyMs = MOCK_LATENCY_MS, rephrase = false }) {
    this.langs = { langA, langB, otherInto };
    this.setTimer = setTimer;
    this.latencyMs = latencyMs;
    this.rephrase = rephrase;
  }

  #render(list, text) {
    const order = this.rephrase && list.length > 1 ? [list.at(-1), ...list.slice(0, -1)] : list;
    return order.join(spaced(text) ? ' ' : '');
  }

  async translate(text, { onDelta, onTarget, into: chosen, previous } = {}) {
    const into = chosen || targetByScript(text, this.langs);
    onTarget?.(into);
    await new Promise((resolve) => this.setTimer(resolve, this.latencyMs));
    let out;
    if (previous) {
      const rest = units(text, text).slice(units(previous.replace(/^\[[^\]]*\] /, ''), text).length);
      out = rest.length ? `${previous}${spaced(text) ? ' ' : ''}${this.#render(rest, text)}` : previous;
    } else if (this.rephrase) out = `[${into ?? 'auto'}] ${this.#render(units(text, text), text)}`;
    else out = `[${into ?? 'auto'}] ${text}`;
    onDelta?.(out);
    return out;
  }

  async identify() {
    return 'other';
  }
}

// Runs one strategy over a trace through the app's translation flow (src/translation/flow.js), with
// a view that records what would be shown (recording-view.mjs). clock: { now, setTimer, clearTimer }
// plus runAll() and pending() when simulated. onProgress({ traceMs, sentences, requests, rateLimited,
// failed, answered, lastError }) is called whenever one of those changes; traceMs is how far into
// the trace the replay is.
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
  const recording = createRecordingView({ now: clock.now });
  const session = { segments: [] };
  const counts = { requests: 0, rateLimited: 0, failed: 0, answered: 0, lastError: null, answerMs: [] };
  let traceNow = () => 0;
  const report = () =>
    onProgress?.({
      traceMs: traceNow(),
      sentences: session.segments.length,
      requests: counts.requests,
      rateLimited: counts.rateLimited,
      failed: counts.failed,
      answered: counts.answered,
      lastError: counts.lastError,
    });

  // What is still on its way (requests, and waits before a refused request is tried again): the
  // replay ends only when the flow has nothing left to do.
  const pending = new Set();
  const track = (promise) => {
    const done = promise.catch(() => {});
    pending.add(done);
    done.finally(() => pending.delete(done));
    return promise;
  };
  const counted = (call) =>
    track(
      (async () => {
        counts.requests++;
        const asked = clock.now();
        try {
          const out = await call();
          counts.answered++;
          counts.answerMs.push(clock.now() - asked);
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
      })(),
    );
  // The run as the app's start() makes it, for two languages.
  const run = {
    session,
    langs,
    otherInto: OTHER_INTO,
    translator: {
      translate: (text, options) => {
        // A final translation streams its answer (onDelta); an in-progress one does not.
        if (options?.onDelta) recording.finalRequested(text);
        return counted(() => translator.translate(text, options));
      },
      identify: (text, names) => counted(() => translator.identify(text, names)),
    },
  };

  let ids = 0;
  let sentences = 0;
  const flow = createFlow({
    view: recording.view,
    reader: { available: false },
    settings: { interimTranslate: true, interimInterval: interval, readAloud: 'off' },
    getRun: () => run,
    selectedLangs: () => langs.map((l) => l.code),
    markDirty: () => {
      if (session.segments.length === sentences) return;
      sentences = session.segments.length;
      report();
    },
    errorText: (err) => String(err?.message ?? err),
    onRateLimit: () => {},
    uid: () => ++ids,
    elapsedNow: () => 0,
    strategy,
    now: clock.now,
    wait: (ms) => track(new Promise((resolve) => clock.setTimer(resolve, ms))),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  run.tracker = flow.tracker(run);
  run.pacer = flow.pacer(run);

  const start = clock.now();
  const at = (ms) => Math.max(0, start + ms / speed - clock.now());
  traceNow = () => Math.round((clock.now() - start) * speed);
  for (const e of trace.events) {
    clock.setTimer(() => (e.kind === 'final' ? run.tracker.final(e.text) : run.tracker.interim(e.text)), at(e.t));
  }
  const end = Math.max(trace.durationMs ?? 0, ...trace.events.map((e) => e.t));
  const ended = new Promise((resolve) =>
    clock.setTimer(() => {
      // as the app's stop() does
      run.tracker.flush();
      flow.dropLive();
      run.pacer.cancel();
      resolve();
    }, at(end)),
  );
  if (clock.runAll) await clock.runAll();
  await ended;
  const idle = () => new Promise((resolve) => setImmediate(resolve));
  for (;;) {
    if (clock.runAll) await clock.runAll();
    await Promise.all([...pending]);
    await idle(); // the flow acts on the last answers first, and may send another request
    if (!pending.size && !clock.pending?.()) break;
  }

  const shown = session.segments.map((seg) => recording.sentence(seg, start));
  const rows = shown.map((s) => ({ id: s.id, ...sentenceMetrics(s) }));
  return {
    label: strategy === 'chunk' ? strategy : `${strategy} ${interval}s`, // chunk does not use the interval
    strategy,
    options: { interval, speed },
    summary: aggregate(rows, counts),
    // Whether the run itself was sound: failed requests, how long answers took, and how many
    // sentences had a translation on screen before they were finished.
    health: health(shown, counts),
    sentences: shown.map((s, i) => ({ ...s, metrics: rows[i] })),
  };
}

export const USAGE = `Replays a recorded recognizer trace and scores how the translations appeared.

  GEMINI_API_KEY=... node scripts/tuning/replay.mjs <trace.json> [options]
  node scripts/tuning/replay.mjs test/fixtures/replay-trace.json --mock

Options
  --strategy a,b   pacing strategies to compare, one run each (default: interval);
                   one of ${Object.keys(STRATEGIES).join(', ')}
  --interval 1.5   seconds between in-progress translations for interval, steady, carry and settle
  --speed 1        play the speech faster; delays are then not comparable, use it for a dry run only
  --mock           fake translator on a simulated clock: no key, instant, same numbers every time
  --mock=rephrase  the same, but it reorders like a real model, so flicker shows unless the
                   strategy passes the shown translation to continue (carry, chunk, settle)
  --limit 120      replay only the first N seconds of the trace: a quick check
  --together       run the strategies at the same time, so they meet the same model speed
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
Each cell is mean/median/p90 over the sentences.

Second table: was the run sound?
failed     requests that ended in an error other than the rate limit (with the last error)
answer ms  how long the model took to answer a request, mean/median/p90
live       sentences that had a translation on screen before they were finished
settled    sentences whose final translation was the in-progress one, with no final request (settle)
A strategy with many failed requests, slow answers or a low "live" share was not measured fairly.`;

export function parseArgs(argv) {
  const args = {
    strategies: [DEFAULT_STRATEGY],
    interval: 1.5,
    speed: 1,
    mock: false,
    limit: null,
    together: false,
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
    else if (a === '--limit') args.limit = Number(value());
    else if (a === '--together') args.together = true;
    else if (a === '--mock') args.mock = true;
    else if (a === '--mock=rephrase') args.mock = 'rephrase';
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
  if (args.limit !== null && !(args.limit > 0)) throw new Error('--limit must be a positive number of seconds');
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
  const unknown = args.strategies.find((name) => !Object.hasOwn(STRATEGIES, name));
  if (unknown) throw new Error(`Unknown strategy: ${unknown}. Known: ${Object.keys(STRATEGIES).join(', ')}`);
  const trace = JSON.parse(readFileSync(args.trace, 'utf8'));
  if (trace.version !== 1) throw new Error(`Unsupported trace version: ${trace.version}`);
  if (!Array.isArray(trace.events) || !trace.events.length) throw new Error('The trace has no recognizer results.');
  if (trace.langs.length > 2) warn(`Note: the trace has ${trace.langs.length} languages; only the first two are used.`);
  if (args.limit !== null) {
    const until = args.limit * 1000;
    trace.events = trace.events.filter((e) => e.t <= until);
    trace.durationMs = Math.min(trace.durationMs ?? until, until);
    if (!trace.events.length) throw new Error(`The trace has no recognizer results in its first ${args.limit} s.`);
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!args.mock && !apiKey) throw new Error('Set GEMINI_API_KEY in the environment, or pass --mock.');
  const [langA, langB] = trace.langs.slice(0, 2).map((code) => LANGS.find((l) => l.code === code)?.name);
  const say = args.quiet ? () => {} : warn; // progress goes to stderr, so stdout holds only the table
  const lengthMs = Math.max(trace.durationMs ?? 0, ...trace.events.map((e) => e.t));
  const finals = trace.events.filter((e) => e.kind === 'final').length;
  say(
    `Trace: ${clockTime(lengthMs)} of speech, ${trace.events.length} recognizer results (${finals} final), ${langA} / ${langB}.`,
  );
  if (args.mock)
    say(
      `Translator: mock${args.mock === 'rephrase' ? ' that rephrases' : ''} on a simulated clock; this takes a moment.`,
    );
  else {
    const each = lengthMs / args.speed;
    const all = args.together ? each : each * args.strategies.length;
    say(
      `Translator: ${MODEL}. Each strategy replays in real time: about ${clockTime(each)}` +
        (args.strategies.length > 1
          ? `, ${clockTime(all)} for all ${args.strategies.length}${args.together ? ' (run together)' : ''}.`
          : '.'),
    );
    if (args.speed !== 1)
      say('Note: with --speed the speech is shortened but the model answers no faster, so delays are not comparable.');
  }

  const runOne = async (strategy) => {
    // --mock runs on a simulated clock: instant and the same on every run.
    const clock = args.mock ? createVirtualClock(Date.parse(trace.startedAt) || Date.UTC(2026, 0, 1)) : realClock();
    const translator = args.mock
      ? new MockTranslator({ langA, langB, setTimer: clock.setTimer, rephrase: args.mock === 'rephrase' })
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
      return await Promise.race([run, failure]);
    } finally {
      clearInterval(ticker);
      line();
    }
  };
  // One after another by default. --together starts them at once: the model's speed changes over
  // time, and strategies replayed one after another may not have met the same conditions.
  let runs = [];
  if (args.together && !args.mock) runs = await Promise.all(args.strategies.map(runOne));
  else for (const strategy of args.strategies) runs.push(await runOne(strategy));
  log(formatTable(runs));
  log(`\n${formatHealth(runs)}`);
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
