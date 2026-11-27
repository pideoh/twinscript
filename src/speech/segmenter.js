// Turns the recognizer's stream of interim / final results into display segments.
//
// The recognizer only finalizes an utterance at a pause, and its interim text is the
// whole utterance so far. Uninterrupted speech would therefore grow into one huge block,
// so finished sentences are split off the interim text here. Final results may also be
// missing or arrive after the next utterance has started; neither may lose text. Nor may a revision
// of words that were already split off: the next cut is found in the revised text (committedEnd).

const MIN_SPLIT_CHARS = 10; // shorter sentences are merged with the next one
const MAX_LIVE_CHARS = 180; // force a split at a clause boundary beyond this
const SENTENCE_END = /(?:[。！？]+[」』）]*|[.!?]+["')\]]*(?=\s))\s*/g;

const newUtterance = () => ({ committed: '', prevRest: '', full: '' });
const normalize = (t) => t.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// Interim results often come with a space between every Japanese word; drop those.
const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g');
const tidy = (text) => text.replace(CJK_GAP, '');

function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

// Whether `text` is the same utterance as `previous` (grown or revised) rather than a new one.
// The recognizer rewrites words, spacing and punctuation between updates, so the two are compared
// by how much of their beginnings they share in order, not character by character.
function continues(text, previous) {
  const a = normalize(text);
  const b = normalize(previous);
  const n = Math.min(a.length, b.length, 60);
  if (!n) return true;
  const span = Math.ceil(n * 1.3) + 4; // room for inserted or dropped characters
  return lcsLength(a.slice(0, span), b.slice(0, span)) >= n * 0.6;
}

// Returns the part of the utterance text that hasn't been split off into segments yet.
function stripCommitted(utt, text) {
  if (!utt.committed) return text;
  if (text.startsWith(utt.committed)) return text.slice(utt.committed.length);
  // The recognizer revised earlier words, which can change their length: cut where the text that
  // was split off ends now, not at the same character count.
  const cut = committedEnd(utt.committed, text);
  utt.committed = text.slice(0, cut);
  return text.slice(cut);
}

const ANCHOR_CHARS = 16; // the end of what was split off, looked for in the revised text
const ANCHOR_REACH = 80; // how far from its old place it is looked for
const ANCHOR_MAX_EDITS = Math.floor(ANCHOR_CHARS * 0.4); // an approximate match keeps 60% of it, as in continues()
const CLOSING_MARKS = /^(?:[、，。．！？」』）]+|[,.!?;:]+["')\]]*(?=\s|$))/;

// Where the text that was split off (`committed`) ends in `text`, a revision of the same utterance.
// Its last characters are looked for near the old cut: an exact match closest to it, else the
// substring with the fewest edits (the earliest of equals). When neither is found, the cut goes
// back by the anchor's length, so a few words may show twice rather than be lost. Only a stretch
// around the old cut is searched: `committed` grows for as long as someone talks without a pause.
function committedEnd(committed, text) {
  const at = Math.min(committed.length, text.length);
  const anchor = committed.slice(-ANCHOR_CHARS);
  const from = Math.max(0, at - ANCHOR_REACH - anchor.length);
  const to = Math.min(text.length, at + ANCHOR_REACH);
  let end = -1;
  for (let i = text.indexOf(anchor, from); i >= 0 && i + anchor.length <= to; i = text.indexOf(anchor, i + 1)) {
    const e = i + anchor.length;
    if (end < 0 || Math.abs(e - at) < Math.abs(end - at)) end = e;
  }
  if (end < 0) {
    const near = closestMatchEnd(anchor, text.slice(from, to));
    end = near < 0 ? Math.max(0, at - ANCHOR_CHARS) : from + near;
  }
  // A comma or full stop the revision added right after the cut closes the part already split off.
  return end + (text.slice(end).match(CLOSING_MARKS)?.[0].length ?? 0);
}

// End index in `span` of the substring closest to `pattern` (fewest insertions, deletions and
// substitutions, the earliest of equals), or -1 when even that one differs by too much.
function closestMatchEnd(pattern, span) {
  let row = Array.from({ length: pattern.length + 1 }, (_, i) => i);
  let best = -1;
  let bestEdits = ANCHOR_MAX_EDITS + 1;
  if (row[pattern.length] < bestEdits) [best, bestEdits] = [0, row[pattern.length]];
  for (let j = 1; j <= span.length; j++) {
    const next = [0];
    for (let i = 1; i <= pattern.length; i++) {
      next[i] = Math.min(row[i] + 1, next[i - 1] + 1, row[i - 1] + (pattern[i - 1] === span[j - 1] ? 0 : 1));
    }
    row = next;
    if (row[pattern.length] < bestEdits) [best, bestEdits] = [j, row[pattern.length]];
  }
  return best;
}

// Index at which `rest` can be split into a finished segment + remainder, or 0.
function findSplit(rest) {
  for (const m of rest.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (end >= MIN_SPLIT_CHARS && rest.slice(end).trim()) return end;
  }
  if (rest.length > MAX_LIVE_CHARS) {
    const head = rest.slice(0, MAX_LIVE_CHARS);
    const clause = Math.max(
      head.lastIndexOf('、'),
      head.lastIndexOf('，'),
      head.lastIndexOf(', ') + 1,
      head.lastIndexOf('; ') + 1,
    );
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

  interim(raw) {
    const text = tidy(raw);
    if (this.utt.full && !continues(text, this.utt.full)) this.#closeUtterance();
    const utt = this.utt;
    utt.full = text;
    let rest = stripCommitted(utt, text);
    // Split off sentences that are complete and unchanged since the previous update.
    for (;;) {
      const cut = findSplit(rest);
      if (!cut || !utt.prevRest.startsWith(rest.slice(0, cut))) break;
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

  final(raw) {
    const text = tidy(raw);
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
