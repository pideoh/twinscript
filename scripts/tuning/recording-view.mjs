// A stand-in for the transcript view (src/ui/transcript-view.js) that the replay hands to the app's
// translation flow (src/translation/flow.js): instead of drawing, it records for each segment what
// would be on screen and when, which is what scripts/tuning/metrics.mjs scores.
//
// What is not obvious:
// - Like the real view, it keeps a segment's lines in `seg.tgts` (setTargets / clearTargets), since
//   the flow reads and writes them there. After clearTargets the text of the lines stays shown as
//   the single translation until a new one replaces it.
// - The shown text of a segment is its single translation, or its lines with text joined by line
//   breaks in the order of its targets; `displays` gets an entry each time that text changes.
// - The view is not told which text is the final translation. It counts one when the flow shows a
//   finished segment's translation equal to what the flow saved as final (`seg.tgt`, or every line
//   of `seg.tgts` in place). A partial answer that happens to equal the text saved before a
//   correction would count too, until the final one replaces it.
// - A sentence is `settled` when its final translation was shown with no final request for its text
//   since it was finished: the replay reports each final request with finalRequested(text).
// - Text shown with the class 'error' is the sentence's error, not a translation.

export function createRecordingView({ now }) {
  const records = new Map(); // seg -> record
  const finalRequests = new Map(); // source text -> final requests sent for it

  const shownText = (seg, rec) =>
    rec.lines
      ? (seg.tgts ?? [])
          .map((x) => rec.lines.get(x.lang))
          .filter(Boolean)
          .join('\n')
      : rec.single;
  const redraw = (seg, rec) => {
    const text = shownText(seg, rec);
    if (text !== (rec.displays.at(-1)?.text ?? '')) rec.displays.push({ t: now(), text });
  };
  const finalShown = (seg, rec) => {
    rec.finalText = shownText(seg, rec);
    rec.finalShownAt = now();
    rec.settled = (finalRequests.get(seg.src) ?? 0) === rec.askedBefore;
  };

  const view = {
    mount(seg) {
      records.set(seg, {
        finished: false,
        mounted: true,
        firstInterimAt: null,
        finishedAt: null,
        finalShownAt: null,
        finalText: null,
        displays: [],
        single: '',
        lines: null, // Map code -> shown text, while the segment has one line per target
        settled: false,
        askedBefore: 0,
        error: undefined,
      });
      return seg;
    },
    unmount(seg) {
      records.get(seg).mounted = false;
    },
    placeBefore() {},
    markFinished(seg) {
      const rec = records.get(seg);
      rec.finished = true;
      rec.finishedAt = now();
    },
    isMounted: (seg) => records.get(seg).mounted,
    shownTranslation(seg, code) {
      const rec = records.get(seg);
      return code === undefined ? shownText(seg, rec) : rec.lines?.get(code);
    },
    setText(seg, part, text, cls) {
      const rec = records.get(seg);
      if (part === 'src') {
        if (!rec.finished) rec.firstInterimAt ??= now();
        else {
          // The sentence was finished (or corrected): its final translation is asked for from here.
          rec.askedBefore = finalRequests.get(text) ?? 0;
          rec.settled = false;
        }
        return;
      }
      if (cls === 'error') {
        rec.error = text;
        return;
      }
      rec.single = text;
      redraw(seg, rec);
      if (rec.finished && cls === undefined && text === seg.tgt) finalShown(seg, rec);
    },
    setTargets(seg, codes) {
      const rec = records.get(seg);
      if (rec.lines && seg.tgts && seg.tgts.map((x) => x.lang).join() === codes.join()) return false;
      seg.tgts = codes.map((lang) => ({ lang, text: '' }));
      rec.lines = new Map();
      redraw(seg, rec);
      return true;
    },
    clearTargets(seg) {
      if (!seg.tgts) return;
      const rec = records.get(seg);
      rec.single = shownText(seg, rec);
      rec.lines = null;
      delete seg.tgts;
      delete seg.lang;
    },
    setLine(seg, code, text, cls) {
      const rec = records.get(seg);
      if (cls === 'error') {
        rec.error = text;
        return;
      }
      rec.lines.set(code, text);
      redraw(seg, rec);
      const done = rec.finished && cls === undefined && seg.tgts.every((x) => x.text);
      if (done && seg.tgts.find((x) => x.lang === code).text === text) finalShown(seg, rec);
    },
    tagSource() {},
  };

  return {
    view,
    // A final translation was asked for `text` (a request that streams its answer).
    finalRequested(text) {
      finalRequests.set(text, (finalRequests.get(text) ?? 0) + 1);
    },
    // What was recorded for a segment, with times counted from `start`.
    sentence(seg, start = 0) {
      const rec = records.get(seg);
      const since = (t) => (t === null ? null : t - start);
      return {
        id: seg.id,
        src: seg.src,
        firstInterimAt: since(rec.firstInterimAt),
        finishedAt: since(rec.finishedAt),
        finalShownAt: since(rec.finalShownAt),
        finalText: rec.finalText,
        error: rec.error,
        settled: rec.settled,
        displays: rec.displays.map((d) => ({ t: d.t - start, text: d.text })),
      };
    },
  };
}
