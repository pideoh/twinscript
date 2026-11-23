// When the sentence being spoken is translated, and what is shown for it. DOM-free: the clock and
// timers are injected, so the same code runs in the app, in Node (scripts/tuning/replay.mjs) and in
// tests with fake timers.
//
// One pacer serves one line of in-progress text (the sentence being spoken) for a whole session:
//   update(text)  the in-progress text changed (the whole sentence so far)
//   finish(finalText)  the sentence was finished (finalText: its finished text); a result still on
//                 its way for it is not shown. With a strategy that carries the shown translation
//                 (carry, chunk) it returns previous(line), what was last shown for that sentence,
//                 for its final translation; with settle, { previous, settled, pending } (see
//                 pacedStrategy); otherwise nothing
//   cancel()      the sentence was dropped, or the session stopped; same for results
// The caller supplies
//   translate(text, { sentence, isCurrent, previous?, keep? }) -> Promise<result>  sends the
//       request(s). With several targets it may send one per target and show each line itself,
//       checking isCurrent(); a falsy result then means there is nothing more for the pacer to
//       show. Strategies that carry the shown translation add previous(line) (what is shown for the
//       sentence: line omitted for the single translation, or a target's code) and keep(line, out)
//       (the caller showed `out` on that line itself). settle adds answer(line, out): the caller got
//       `out` for that line, whether or not the sentence is still being spoken.
//   show(result, { text, sentence })  shows a result for the sentence still being spoken; it
//       replaces whatever was shown for it before.
//   onRateLimit(err)  told when a request was refused for the rate limit.
// Strategies decide when to call translate; add one to STRATEGIES and select it with `strategy`.
import { scriptClass } from './script-hint.js';
import { RateLimitError } from './translator.js';

const value = (v) => (typeof v === 'function' ? v() : v);

// Today's rule. A request at most every `interval` seconds while updates keep coming, never two at
// once, not for text shorter than `minLength`, none for `pauseMs` after a rate-limit error, and one
// more after a request during which the text changed. The timing (last request, pause, a request
// in flight) is kept across sentences.
function intervalStrategy({ translate, show, now, setTimer, clearTimer, isRateLimit, onRateLimit, options }) {
  const { interval = 1.5, minLength = 4, pauseMs = 60_000, enabled = true } = options;
  const s = { busy: false, lastAt: 0, pausedUntil: 0, timer: null, text: '', sentence: 0 };

  function schedule() {
    if (!value(enabled) || s.busy || s.timer !== null) return;
    const t = now();
    if (t < s.pausedUntil) return;
    const wait = Math.max(0, s.lastAt + value(interval) * 1000 - t);
    s.timer = setTimer(fire, wait);
  }

  async function fire() {
    s.timer = null;
    const { sentence, text } = s;
    if (text.length < minLength) return;
    const isCurrent = () => s.sentence === sentence;
    s.busy = true;
    s.lastAt = now();
    try {
      const out = await translate(text, { sentence, isCurrent });
      if (isCurrent() && out) show(out, { text, sentence });
    } catch (err) {
      if (isRateLimit(err)) {
        s.pausedUntil = now() + pauseMs;
        onRateLimit?.(err);
      }
    } finally {
      s.busy = false;
      if (isCurrent() && s.text !== text) schedule();
    }
  }

  function end() {
    if (s.timer !== null) clearTimer(s.timer);
    s.timer = null;
    s.text = '';
    s.sentence++;
  }

  return {
    update(text) {
      s.text = text;
      schedule();
    },
    finish: end,
    cancel: end,
  };
}

// Sentence or clause punctuation in the supported scripts. `.`, `,` and `:` between two digits
// (3.5, 1,000, 10:30) are not boundaries. Nor is the end of a sentence as the last character: the
// recognizer's final result, and with it the final translation, usually follows within a second, so
// a request for the same text just before it is wasted (the maximum wait still covers a final
// result that does not come).
const BOUNDARY = /[、。，,.;:!?！？；：…｡､।॥]/u;
const SENTENCE_END = /[。.!?！？…｡।॥]/u;
// Commas and full stops, which the recognizer adds or moves between an in-progress result and the
// final one without changing what was said. A stop or comma between digits (3.5, 1,000) stays.
const NEUTRAL =
  /(?<!\p{Nd})[、。，,.｡､](?!\p{Nd})|(?<=\p{Nd})[、。，,.｡､](?!\p{Nd})|(?<!\p{Nd})[、。，,.｡､](?=\p{Nd})/gu;

// Whether two texts of a sentence say the same thing: equal after trimming, collapsing whitespace,
// and ignoring case, commas and full stops. The recognizer's final result often differs from its
// last in-progress one only by a closing full stop. Marks that change the meaning count as a
// difference: a question or exclamation mark, a percent or currency sign, an apostrophe. Empty
// texts are never the same. Pure.
export function sameText(a, b) {
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFKC')
      .replace(/[’‘]/gu, "'")
      .replace(NEUTRAL, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase();
  const x = norm(a);
  return x !== '' && x === norm(b);
}
const NUMERIC = new Set(['.', ',', ':']);
const DIGIT = /\p{Nd}/u;
// Writing systems that pack a clause into few characters.
const DENSE = new Set(['kana', 'han', 'hangul', 'thai']);
const DENSE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

const isBoundary = (cs, i) =>
  BOUNDARY.test(cs[i]) &&
  !(NUMERIC.has(cs[i]) && DIGIT.test(cs[i - 1] ?? '') && DIGIT.test(cs[i + 1] ?? '')) &&
  !(i === cs.length - 1 && SENTENCE_END.test(cs[i]));

// How many characters of growth make a chunk worth translating, by writing system. Text too short
// or too mixed for scriptClass counts as dense when it has any kana, Han, Hangul or Thai.
export function growthFor(text, { growthDense = 12, growthSpaced = 28 } = {}) {
  const cls = scriptClass(text);
  const dense = cls ? DENSE.has(cls) : DENSE_CHAR.test(String(text ?? ''));
  return dense ? growthDense : growthSpaced;
}

// Whether `text` (the sentence so far) has gained enough since `sent` (the text of the last request
// for it, '' before the first) to be translated again: 'boundary' when a clause boundary appeared
// after the part the two share, 'growth' when it grew by at least growthFor(text) characters, or
// null. Pure.
export function chunkTrigger(sent, text, options) {
  const a = Array.from(sent ?? '');
  const b = Array.from(text ?? '');
  let from = 0;
  while (from < a.length && from < b.length && a[from] === b[from]) from++;
  for (let i = from; i < b.length; i++) if (isBoundary(b, i)) return 'boundary';
  return b.length - a.length >= growthFor(text, options) ? 'growth' : null;
}

// steady, carry, settle and chunk. Unlike interval, all timing is per sentence: a new sentence's first
// request goes out as soon as it qualifies, whatever is still in flight or was sent for the one
// before; never two requests at once for the same sentence; none for text that was already sent.
//   steady  a request at most every `interval` seconds while the text keeps changing.
//   carry   steady, and each request passes what is shown for the sentence (context.previous) so
//           the model continues it instead of starting over.
//   settle  carry, and finish(finalText) tells whether the finished sentence's last request was
//           made from the same text (sameText) as its finished text, so the caller can keep that
//           request's answer as the final translation instead of asking again. It returns
//             previous(line)  as carry does;
//             settled  null, or answer(line): that request's answers, when it has been answered
//                      (line: a target's code, or omitted for the single translation; undefined
//                      for a line it gave nothing for);
//             pending  null, or a promise of answer(line) (null when it fails) for that request
//                      when it is still on its way.
//           A settled translation may lack the closing punctuation of the source, since the text
//           it was made from did; nothing patches it in.
//   chunk   carry, but a request when the text gained a clause boundary or grew by growthDense /
//           growthSpaced characters since the last one, at most every `minGap` seconds, or when it
//           has stood still for `maxWait` seconds without being sent.
function pacedStrategy(
  { translate, show, now, setTimer, clearTimer, isRateLimit, onRateLimit, options },
  { carry = false, chunk = false, settle = false },
) {
  const {
    interval = 1.5,
    minLength = 4,
    pauseMs = 60_000,
    enabled = true,
    minGap = 0.8,
    maxWait = 2.5,
    growthDense = 12,
    growthSpaced = 28,
  } = options;
  const sentence = (id) => ({
    id,
    text: '',
    changedAt: 0,
    sent: null,
    lastAt: null,
    busy: false,
    timer: null,
    shown: new Map(),
    last: null, // settle: the latest request, { text, answers, done, ok, result }
  });
  let cur = sentence(0);
  let pausedUntil = 0;

  // line: a target's code, or undefined for the single translation. Showing one replaces the other.
  const previousOf = (c) => (line) => c.shown.get(line ?? '');
  function keep(c, line, out) {
    if (line == null) c.shown.clear();
    else c.shown.delete('');
    c.shown.set(line ?? '', out);
  }

  function schedule() {
    const c = cur;
    if (c.timer !== null) {
      if (!chunk) return; // interval timing: the waiting request takes the text as it is then
      clearTimer(c.timer); // chunk: whether and when depends on the latest text
      c.timer = null;
    }
    if (!value(enabled) || c.busy) return;
    const t = now();
    if (t < pausedUntil || c.text === c.sent || c.text.length < minLength) return;
    let due = t;
    if (!chunk) {
      if (c.lastAt !== null) due = c.lastAt + value(interval) * 1000;
    } else {
      if (c.lastAt !== null) due = c.lastAt + value(minGap) * 1000;
      const growth = { growthDense: value(growthDense), growthSpaced: value(growthSpaced) };
      if (!chunkTrigger(c.sent ?? '', c.text, growth)) due = Math.max(due, c.changedAt + value(maxWait) * 1000);
    }
    c.timer = setTimer(() => fire(c), Math.max(0, due - t));
  }

  async function fire(c) {
    c.timer = null;
    const { text } = c;
    if (cur !== c || text.length < minLength || text === c.sent) return;
    const isCurrent = () => cur === c;
    c.busy = true;
    c.sent = text;
    c.lastAt = now();
    const context = { sentence: c.id, isCurrent };
    // settle: what this request answers is kept for the sentence even when it arrives after the
    // sentence was finished, so finish() can hand it over as the final translation.
    let req = null;
    let resolve = null;
    if (settle) {
      req = { text, answers: new Map(), done: false, ok: false };
      req.result = new Promise((r) => {
        resolve = r;
      });
      c.last = req;
    }
    const answer = (line, out) => {
      if (req && out) req.answers.set(line ?? '', out);
    };
    if (carry) {
      context.previous = previousOf(c);
      context.keep = (line, out) => {
        if (isCurrent() && out) keep(c, line, out);
      };
    }
    if (settle) context.answer = answer;
    try {
      const out = await translate(text, context);
      answer(undefined, out);
      if (req) req.ok = true;
      if (isCurrent() && out) {
        show(out, { text, sentence: c.id });
        keep(c, undefined, out);
      }
    } catch (err) {
      if (isRateLimit(err)) {
        pausedUntil = now() + pauseMs;
        onRateLimit?.(err);
      }
    } finally {
      c.busy = false;
      if (req) {
        req.done = true;
        resolve(req.ok ? answersOf(req) : null);
      }
      if (isCurrent()) schedule();
    }
  }
  const answersOf = (req) => (line) => req.answers.get(line ?? '');

  function end() {
    const c = cur;
    if (c.timer !== null) clearTimer(c.timer);
    c.timer = null;
    cur = sentence(c.id + 1);
    return c;
  }

  return {
    update(text) {
      if (text !== cur.text) {
        cur.text = text;
        cur.changedAt = now();
      }
      schedule();
    },
    finish(finalText) {
      const c = end();
      if (!settle) return carry ? previousOf(c) : undefined;
      const req = c.last;
      const same = !!req && sameText(req.text, finalText);
      return {
        previous: previousOf(c),
        settled: same && req.done && req.ok ? answersOf(req) : null,
        pending: same && !req.done ? req.result : null,
      };
    },
    cancel() {
      end();
    },
  };
}

export const STRATEGIES = {
  interval: intervalStrategy,
  steady: (deps) => pacedStrategy(deps, {}),
  carry: (deps) => pacedStrategy(deps, { carry: true }),
  chunk: (deps) => pacedStrategy(deps, { carry: true, chunk: true }),
  settle: (deps) => pacedStrategy(deps, { carry: true, settle: true }),
};
export const DEFAULT_STRATEGY = 'carry';

// The strategy called `name`, or the default (with a warning when a name was given but is unknown).
export function strategyNamed(name, warn = console.warn) {
  if (!name) return DEFAULT_STRATEGY;
  if (Object.hasOwn(STRATEGIES, name)) return name;
  warn(`Unknown pacing strategy "${name}"; using ${DEFAULT_STRATEGY}.`);
  return DEFAULT_STRATEGY;
}

export function createPacer({
  strategy = DEFAULT_STRATEGY,
  translate,
  show,
  onRateLimit,
  isRateLimit = (err) => err instanceof RateLimitError,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  options = {},
}) {
  const make = STRATEGIES[strategy];
  if (!make) throw new Error(`Unknown pacing strategy: ${strategy}`);
  return make({ translate, show, now, setTimer, clearTimer, isRateLimit, onRateLimit, options });
}
