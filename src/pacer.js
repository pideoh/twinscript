// When the sentence being spoken is translated, and what is shown for it. DOM-free: the clock and
// timers are injected, so the same code runs in the app, in Node (scripts/tuning/replay.mjs) and in
// tests with fake timers.
//
// One pacer serves one line of in-progress text (the sentence being spoken) for a whole session:
//   update(text)  the in-progress text changed (the whole sentence so far)
//   finish()      the sentence was finished; a result still on its way for it is not shown
//   cancel()      the sentence was dropped, or the session stopped; same for results
// The caller supplies
//   translate(text, { sentence, isCurrent }) -> Promise<result>  sends the request(s). With several
//       targets it may send one per target and show each line itself, checking isCurrent(); a
//       falsy result then means there is nothing more for the pacer to show.
//   show(result, { text, sentence })  shows a result for the sentence still being spoken; it
//       replaces whatever was shown for it before.
//   onRateLimit(err)  told when a request was refused for the rate limit.
// Strategies decide when to call translate; add one to STRATEGIES and select it with `strategy`.
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

export const STRATEGIES = { interval: intervalStrategy };
export const DEFAULT_STRATEGY = 'interval';

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
