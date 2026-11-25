// The translation flow of a run: takes what the segmenter (src/speech/segmenter.js) makes of the
// recognizer's results and drives the translation of the sentence in progress (through the pacer,
// src/translation/pacer.js) and of each finished sentence, and reads finished translations aloud.
// DOM-free: it talks to the page only through the transcript view's API (src/ui/transcript-view.js),
// so it runs under node:test with a stand-in view, translator, pacer and reader.
//
// What is not obvious:
// - The sentence in progress (`live`) is one for the whole app, not per run: stop() drops it
//   (dropLive) and opening a session forgets it (forgetLive).
// - A segment can be translated again when its text is corrected; `seg.rev` counts its texts, and an
//   answer for an older text is dropped. A request refused for the rate limit is tried again after
//   1.5, 3 and 6 seconds, then the error is shown.
// - With the settle strategy, an in-progress translation of the same text as the finished one is
//   the final translation (the pacer's handover); a finished translation is read aloud once.
// - With a third language, or two and a sentence in neither, a sentence has one line per target.
// - scripts/tuning/replay.mjs repeats parts of this flow to replay traces outside the app; keep the
//   two in step.

import { UtteranceTracker } from '../speech/segmenter.js';
import { langName } from '../ui/langs.js';
import { createPacer } from './pacer.js';
import { readAloudLanguages } from './read-aloud.js';
import { languageByScript, scriptsDiffer, sourceByScript, targetByScript, targetLanguages } from './script-hint.js';
import { RateLimitError } from './translator.js';

const HISTORY_LINES = 3;

// A run `r` (made by the app's start()) carries what the translator was given: { session, langs:
// [{ code, name }] (two or three), otherInto, translator, pacer, tracker }; the flow makes its
// tracker (tracker(r)) and pacer (pacer(r)).
// view: the transcript view; reader: reads aloud (available, speak(text, code)); settings: the app's
// settings (interimTranslate, interimInterval, readAloud); getRun(): the run in progress, or null;
// selectedLangs(): the codes of the languages selected; markDirty(sess): saves it soon;
// errorText(err): an error's message; onRateLimit(): told when an in-progress request was refused
// for the rate limit; uid(): a new id; elapsedNow(): the session's active time now; strategy: the
// pacer's strategy; now(), wait(ms): the clock, and a promise that resolves after ms.
export function createFlow({
  view,
  reader,
  settings,
  getRun,
  selectedLangs,
  markDirty,
  errorText,
  onRateLimit,
  uid,
  elapsedNow,
  strategy,
  now = Date.now,
  wait = (ms) => new Promise((res) => setTimeout(res, ms)),
}) {
  let live = null; // segment currently being spoken

  function createSegment() {
    return view.mount({ id: uid(), at: now(), elapsed: elapsedNow(), src: '', tgt: '' }, true);
  }

  function createTracker(r) {
    return new UtteranceTracker({
      commit(text, aboveLive) {
        if (aboveLive) {
          const seg = createSegment();
          if (live) view.placeBefore(seg, live);
          commit(r, seg, text);
          return seg;
        }
        if (!live) live = createSegment();
        return finalize(r, text);
      },
      setLive(text) {
        if (!text) {
          if (live) view.unmount(live);
          live = null;
          r.pacer.cancel();
          return;
        }
        if (!live) live = createSegment();
        view.setText(live, 'src', text);
        r.pacer.update(text);
      },
      correct: (seg, text) => commit(r, seg, text),
    });
  }

  // The sentence being spoken is translated as it grows; src/translation/pacer.js decides when.
  function createInterimPacer(r) {
    return createPacer({
      strategy,
      options: {
        enabled: () => settings.interimTranslate,
        interval: () => settings.interimInterval,
      },
      translate: (text, context) =>
        r.langs.length > 2 || intoSeveral(r, text)
          ? translateInterimLines(r, live, text, context)
          : r.translator.translate(text, { history: recentHistory(r), previous: context.previous?.() }),
      show: (out) => {
        view.clearTargets(live);
        view.setText(live, 'tgt', out, 'pending');
      },
      onRateLimit,
    });
  }

  // With a third language, or two and a sentence in neither of them: the sentence in progress goes
  // into the other languages, one request per line, but only when its writing system tells which
  // language it is in (the model is not asked while the sentence is still growing).
  // context: the pacer's; with a strategy that carries the shown translation, each line continues its own.
  async function translateInterimLines(r, seg, text, context) {
    const source = sourceByScript(
      text,
      r.langs.map((l) => l.name),
    );
    if (!source) return;
    const targets = targetsFor(r, source);
    view.setTargets(seg, targets);
    const results = await Promise.allSettled(
      targets.map(async (code) => {
        const out = await r.translator.translate(text, {
          history: recentHistory(r, code),
          into: langName(code),
          previous: context.previous?.(code),
        });
        if (out) context.answer?.(code, out);
        if (seg === live && out && seg.tgts.some((x) => x.lang === code)) {
          view.setLine(seg, code, out, 'pending');
          context.keep?.(code, out);
        }
      }),
    );
    const limited = results.find((x) => x.status === 'rejected' && x.reason instanceof RateLimitError);
    if (limited) throw limited.reason;
  }
  // The codes of the languages a sentence goes into: the selected ones other than the one it was
  // spoken in (source: an English name or 'other'), in the order of the selects, narrowed by the
  // setting for other languages.
  const targetsFor = (r, source) =>
    targetLanguages(
      r.langs.map((l) => l.name),
      source,
      r.otherInto,
    ).map((name) => r.langs.find((l) => l.name === name).code);
  // With two languages, a sentence whose writing system shows it is in neither goes into both, one
  // tagged line each, unless the setting picks one of them. Everything else takes one request with
  // the rules for two languages, which never asks the model which language it is.
  const intoSeveral = (r, text) =>
    r.langs.length === 2 &&
    sourceByScript(
      text,
      r.langs.map((l) => l.name),
    ) === 'other' &&
    targetsFor(r, 'other').length > 1;

  function finalize(r, text) {
    const seg = live;
    live = null;
    // With a strategy that carries the shown translation, the final one continues it; with settle,
    // the pacer also tells whether what is shown already translates the finished text.
    seg.handover = r.pacer.finish(text);
    commit(r, seg, text);
    return seg;
  }

  function commit(r, seg, text) {
    view.markFinished(seg);
    seg.src = text;
    view.setText(seg, 'src', text);
    if (!r.session.segments.includes(seg)) r.session.segments.push(seg);
    markDirty(r.session);
    translateFinal(r, seg);
  }

  // lang: with a third language, the target whose own earlier translations are wanted.
  function recentHistory(r, lang) {
    return r.session.segments
      .filter((x) => x.tgt)
      .slice(-HISTORY_LINES)
      .map(({ src, tgt, tgts }) => ({ src, tgt: (lang && tgts?.find((x) => x.lang === lang)?.text) || tgt }));
  }

  // What the pacer handed over when the sentence was finished, only for its first final
  // translation: a corrected text is translated afresh. { previous, settled, pending }: previous(line)
  // is what was shown while the sentence was spoken; settled(line) (or the promise `pending` of it,
  // null when that request fails) the answers of an in-progress request made from the same text as
  // the finished one, which then are the final translation (settle strategy only).
  function takeHandover(seg) {
    const handed = seg.handover;
    delete seg.handover;
    if (typeof handed === 'function') return { previous: handed };
    return handed ?? {};
  }
  // The answers of a same-text in-progress request: settled(line), the promise `pending` of it, or
  // null when there is none (then nothing is awaited, so the final request goes out at once).
  const settledAnswers = ({ settled, pending }) => settled ?? pending ?? null;

  async function translateFinal(r, seg) {
    if (r.langs.length > 2 || intoSeveral(r, seg.src)) return translateFinalLines(r, seg);
    const handover = takeHandover(seg);
    const previous = handover.previous?.();
    const history = recentHistory(r);
    seg.rev = (seg.rev || 0) + 1; // a segment can be re-translated when its text is corrected
    const rev = seg.rev;
    view.clearTargets(seg);
    const shown = () => seg.rev === rev && view.isMounted(seg);
    // If a translation of the in-progress text is already on screen, swap it once when the final one
    // is complete rather than replacing it with a few words that grow again.
    const swapWhenDone = !!view.shownTranslation(seg);
    // settle: an in-progress translation of the same text is the final one, without another request.
    let answers = settledAnswers(handover);
    if (answers instanceof Promise) answers = await answers;
    if (seg.rev !== rev) return;
    const settled = answers?.();
    if (settled) {
      const target = r.translator.langs ? targetByScript(seg.src, r.translator.langs) : null; // as onTarget would say
      return finishFinal(r, seg, settled, target);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        let target = null;
        const out = await r.translator.translate(seg.src, {
          history,
          previous,
          onDelta: (partial) => {
            if (shown() && !swapWhenDone) view.setText(seg, 'tgt', partial);
          },
          onTarget: (language) => {
            target = language;
          },
        });
        if (seg.rev !== rev) return;
        return finishFinal(r, seg, out, target);
      } catch (err) {
        if (err instanceof RateLimitError && attempt < 3) {
          await wait(1500 * 2 ** attempt);
          continue;
        }
        if (shown()) view.setText(seg, 'tgt', errorText(err), 'error');
        return;
      }
    }
  }

  // With a third language: which language the sentence is in comes from its writing system, or else
  // from the model; then it is translated into each of the others at once, each into its own line.
  // With two languages this is only reached for a sentence the writing system shows is in neither.
  // The steps after a sentence's single final translation is in, whether it was requested or settled.
  function finishFinal(r, seg, out, target) {
    seg.tgt = out;
    if (view.isMounted(seg)) view.setText(seg, 'tgt', out);
    markDirty(r.session);
    if (!seg.spoken) seg.spoken = readTranslation(r, out, target);
  }

  async function translateFinalLines(r, seg) {
    const handover = takeHandover(seg);
    const { previous } = handover;
    seg.rev = (seg.rev || 0) + 1;
    const rev = seg.rev;
    const names = r.langs.map((l) => l.name);
    const source = sourceByScript(seg.src, names) ?? (await r.translator.identify(seg.src, names).catch(() => 'other'));
    if (seg.rev !== rev) return;
    seg.lang = r.langs.find((l) => l.name === source)?.code ?? 'other';
    view.tagSource(seg);
    const targets = targetsFor(r, source);
    // Lines already showing a translation of the text in progress are swapped once, when complete.
    const kept = !view.setTargets(seg, targets);
    const swap = new Set(kept ? targets.filter((code) => view.shownTranslation(seg, code)) : []);
    // settle: only when every line has an in-progress translation of the same text.
    let answers = settledAnswers(handover);
    if (answers instanceof Promise) answers = await answers;
    if (seg.rev !== rev) return;
    if (answers && targets.every((code) => answers(code))) {
      for (const code of targets) finishLine(r, seg, code, answers(code));
      return;
    }
    await Promise.all(targets.map((code) => translateLine(r, seg, rev, code, swap.has(code), previous?.(code))));
  }

  async function translateLine(r, seg, rev, code, swapWhenDone, previous) {
    const history = recentHistory(r, code);
    const shown = () => seg.rev === rev && view.isMounted(seg);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await r.translator.translate(seg.src, {
          history,
          into: langName(code),
          previous,
          onDelta: (partial) => {
            if (shown() && !swapWhenDone) view.setLine(seg, code, partial);
          },
        });
        if (seg.rev !== rev) return;
        return finishLine(r, seg, code, out);
      } catch (err) {
        if (err instanceof RateLimitError && attempt < 3) {
          await wait(1500 * 2 ** attempt);
          continue;
        }
        if (shown()) view.setLine(seg, code, errorText(err), 'error');
        return;
      }
    }
  }

  // The steps after one line's final translation is in, whether it was requested or settled.
  function finishLine(r, seg, code, out) {
    seg.tgts.find((x) => x.lang === code).text = out;
    seg.tgt = seg.tgts
      .map((x) => x.text)
      .filter(Boolean)
      .join('\n');
    if (view.isMounted(seg)) view.setLine(seg, code, out);
    markDirty(r.session);
    // Each line is in a known language, so the one(s) chosen for reading aloud are read.
    seg.spokenLines ??= new Set();
    if (seg.spokenLines.has(code)) return;
    const read = r.langs.length === 2 ? readTranslation(r, out, langName(code)) : readLine(r, out, code);
    if (read) seg.spokenLines.add(code);
  }

  // With three languages: reads a finished translation line aloud when it is into the language
  // chosen. A sentence in that language has no line into it, so it is not read. Returns whether it
  // was read.
  function readLine(r, text, code) {
    if (getRun() !== r || !reader.available) return false;
    if (!readAloudLanguages(settings.readAloud, selectedLangs()).includes(code)) return false;
    reader.speak(text, code);
    return true;
  }

  // Reads a finished translation aloud when it is in a language the user chose. Its language comes
  // from its writing system, else from what the translator was told to translate into; when neither
  // settles it, it is not read. Returns whether it was read.
  function readTranslation(r, text, target) {
    if (getRun() !== r || r.langs.length !== 2 || settings.readAloud === 'off' || !reader.available) return false;
    const [a, b] = r.langs;
    if (!scriptsDiffer(a.name, b.name)) return false;
    const name = languageByScript(text, a.name, b.name) ?? target;
    const lang = r.langs.find((l) => l.name === name);
    if (!lang || !readAloudLanguages(settings.readAloud, selectedLangs()).includes(lang.code)) return false;
    reader.speak(text, lang.code);
    return true;
  }

  return {
    tracker: createTracker,
    pacer: createInterimPacer,
    // The run stopped: the sentence in progress is taken off the page.
    dropLive() {
      if (live) {
        view.unmount(live);
        live = null;
      }
    },
    // Another session is shown (its segments were taken off the page already).
    forgetLive() {
      live = null;
    },
  };
}
