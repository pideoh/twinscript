// Turns the recognizer's stream of interim / final results into display segments.
//
// The recognizer only finalizes an utterance at a pause, and its interim text is the
// whole utterance so far. Uninterrupted speech would therefore grow into one huge block,
// so finished sentences are split off the interim text here. Final results may also be
// missing or arrive after the next utterance has started; neither may lose text.

const MIN_SPLIT_CHARS = 10;   // shorter sentences are merged with the next one
const MAX_LIVE_CHARS = 180;   // force a split at a clause boundary beyond this
const SENTENCE_END = /(?:[。！？]+[」』）]*|[.!?]+["')\]]*(?=\s))\s*/g;

const newUtterance = () => ({ committed: '', prevRest: '', full: '' });
const normalize = (t) => t.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// Whether `text` is the same utterance as `previous` (grown or lightly revised) rather than a new one.
function continues(text, previous) {
  const a = normalize(text);
  const b = normalize(previous);
  const n = Math.min(a.length, b.length, 40);
  if (!n) return true;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same >= n * 0.6;
}

// Returns the part of the utterance text that hasn't been split off into segments yet.
function stripCommitted(utt, text) {
  if (!utt.committed) return text;
  if (text.startsWith(utt.committed)) return text.slice(utt.committed.length);
  // The recognizer revised earlier words. Cut at the sentence boundary closest to where we cut before.
  let cut = Math.min(utt.committed.length, text.length);
  let best = null;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (Math.abs(end - cut) <= 40 && (best === null || Math.abs(end - cut) < Math.abs(best - cut))) best = end;
  }
  if (best !== null) cut = best;
  utt.committed = text.slice(0, cut);
  return text.slice(cut);
}

// Index at which `rest` can be split into a finished segment + remainder, or 0.
function findSplit(rest) {
  for (const m of rest.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (end >= MIN_SPLIT_CHARS && rest.slice(end).trim()) return end;
  }
  if (rest.length > MAX_LIVE_CHARS) {
    const head = rest.slice(0, MAX_LIVE_CHARS);
    const clause = Math.max(head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf(', ') + 1, head.lastIndexOf('; ') + 1);
    if (clause > MAX_LIVE_CHARS / 2) return clause + 1;
    const space = head.lastIndexOf(' ');
    return space > MAX_LIVE_CHARS / 2 ? space + 1 : MAX_LIVE_CHARS;
  }
  return 0;
}

export class UtteranceTracker {
  // commit(text, aboveLive) -> handle : add a finished segment. Normally the live segment becomes
  //                                     the finished one; with aboveLive it is added above it instead.
  // setLive(text)                     : show the in-progress text ('' removes the live segment).
  // correct(handle, text)             : replace the text of an already finished segment.
  constructor({ commit, setLive, correct }) {
    this.cb = { commit, setLive, correct };
    this.utt = newUtterance();
    this.closed = null;
    this.liveText = '';
  }

  interim(text) {
    if (this.utt.full && !continues(text, this.utt.full)) this.#closeUtterance();
    const utt = this.utt;
    utt.full = text;
    let rest = stripCommitted(utt, text);
    // Split off sentences that are complete and unchanged since the previous update.
    for (let cut; (cut = findSplit(rest)) && utt.prevRest.startsWith(rest.slice(0, cut));) {
      const sentence = rest.slice(0, cut);
      utt.committed += sentence;
      utt.prevRest = utt.prevRest.slice(cut);
      rest = rest.slice(cut);
      this.#commitLive(sentence.trim());
    }
    utt.prevRest = rest;
    if (!rest.trim()) return;
    this.liveText = rest.trim();
    this.cb.setLive(this.liveText);
  }

  final(text) {
    const utt = this.utt;
    const isCurrent = utt.full && continues(text, utt.full);

    if (!isCurrent && this.closed && continues(text, this.closed.full)) {
      // Late final for an utterance that was already closed out: fix up its last segment.
      const { handle, text: shown } = this.closed;
      const rest = stripCommitted(this.closed, text).trim();
      this.closed = null;
      if (rest && handle && rest !== shown) this.cb.correct(handle, rest);
      else if (rest && !handle) this.cb.commit(rest, true);
      return;
    }
    if (!isCurrent && utt.full) {
      this.cb.commit(text, true); // unrelated to what is being spoken now
      return;
    }

    const rest = stripCommitted(utt, text).trim();
    this.utt = newUtterance();
    if (rest) {
      this.#commitLive(rest);
    } else {
      this.liveText = '';
      this.cb.setLive('');
    }
  }

  // Keep whatever is in progress (used when the session stops).
  flush() {
    if (this.liveText) this.#commitLive(this.liveText);
    this.utt = newUtterance();
    this.closed = null;
  }

  #commitLive(text) {
    this.liveText = '';
    return this.cb.commit(text, false);
  }

  // The recognizer moved on to a new utterance without (or before) finalizing the current one.
  // Keep what was heard so far; a late final result for it is reconciled in final().
  #closeUtterance() {
    const { full, committed } = this.utt;
    const text = this.liveText;
    let handle = null;
    if (text) handle = this.#commitLive(text);
    else this.cb.setLive('');
    this.closed = { full, committed, handle, text };
    this.utt = newUtterance();
  }
}
