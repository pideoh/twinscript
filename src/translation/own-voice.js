// Tells the app's own voice from the meeting's. When a translation is read aloud and the audio the app
// listens to picks it up (speakers heard by the microphone, a shared tab or screen, PC audio), the
// recognizer returns the sentence that was just read; the flow (src/translation/flow.js) asks here
// first and drops it. DOM-free, the clock is passed in.
//
// The rule. A reading counts from the moment it starts until lingerMs after it ends (the recognizer
// finishes a sentence a little after the audio). A recognized text is compared with the readings that
// count now, joined in the order they were read, after normalizing both: NFKC (full and half width),
// lower case, no spaces, punctuation or symbols. The measure is the share of the text's character
// bigrams (pairs of neighbouring characters, counted with repeats) that are found in the best stretch
// of the readings about as long as the text: one changed character costs at most two bigrams, a
// missing or extra word only its own, and it works the same with or without spaces between words.
// Because the stretch slides over the readings joined together, a sentence read aloud that comes back
// split in two, or joined with the next sentence read aloud, still matches.
// - isOwn (a finished sentence): the measure reaches THRESHOLD and the text is at least MIN_WEIGHT long
//   (a Han, kana or Hangul character weighs 2, any other 1), so that a short "OK" or "はい" a person
//   says is not dropped because the app's sentence contains it. A text equal (after normalizing) to a
//   whole reading is own at any length: otherwise a short sentence read in both languages would come
//   back, be translated and read again, round after round.
// - mayBeOwn (the sentence in progress): the same measure, at any length, so the start of a sentence
//   read aloud is not shown only to be taken away. A person's sentence that starts like what is being
//   read is held back until it grows away from it.
// Not handled: a sentence in which the recognizer mixed the app's voice with a person's (kept whole);
// a sentence the recognizer finishes later than lingerMs after the reading ended; a reading the
// recognizer heard so badly that a fifth of its bigrams changed (a number written in digits instead of
// characters costs that much in a short Japanese or Chinese sentence). A person who repeats what the
// app has just read, nearly word for word and within lingerMs, is dropped.
//
// THRESHOLD: one character changed in a ten-character Japanese sentence costs two of its nine or ten
// bigrams, and still counts. Scores of near misses (test/unit/src/translation/own-voice.test.js has
// the table): "The budget for next quarter is open." after "...is still open." 0.96 and "We will meet
// at 10 tomorrow morning" after "...at ten..." 0.89 are dropped, and so is a person asking back "Is the
// budget for next quarter final?" (0.83); "Let us move on to the next topic" after "...to the next item
// on the agenda." 0.79 and "明日の会議は10時からです" after "...十時..." 0.75 are kept.

const THRESHOLD = 0.8;
const MIN_WEIGHT = 16;
const MAX_READINGS = 8; // readings kept at most; older ones are forgotten first
const MAX_READING_MS = 60_000; // a reading whose end was never reported counts this long at most

const normalize = (text) =>
  String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const weight = (norm) => [...norm].reduce((sum, ch) => sum + (WIDE.test(ch) ? 2 : 1), 0);

const bigrams = (chars) => {
  const out = [];
  for (let i = 1; i < chars.length; i++) out.push(chars[i - 1] + chars[i]);
  return out;
};

// The share of the bigrams of `text` found in the best stretch of `within` (both normalized). The
// stretch is a quarter longer than the text (plus two characters), so that words the recognizer left
// out still fit in it; a text longer than `within` is compared with all of it. Pure.
export function similarity(text, within) {
  const a = [...text];
  const c = [...within];
  if (a.length < 2) return a.length === 1 && c.includes(a[0]) ? 1 : 0;
  const want = new Map();
  for (const g of bigrams(a)) want.set(g, (want.get(g) ?? 0) + 1);
  const total = a.length - 1;
  const span = Math.min(c.length, Math.ceil(a.length * 1.25) + 2);
  const grams = bigrams(c);
  const size = span - 1; // bigrams in a stretch
  if (size < 1) return 0;
  // Slide the stretch over `within`, keeping the count of the text's bigrams it holds.
  const have = new Map();
  let hit = 0;
  let best = 0;
  const add = (g) => {
    const n = have.get(g) ?? 0;
    if (n < (want.get(g) ?? 0)) hit++;
    have.set(g, n + 1);
  };
  const remove = (g) => {
    const n = have.get(g) - 1;
    have.set(g, n);
    if (n < (want.get(g) ?? 0)) hit--;
  };
  for (let i = 0; i < grams.length; i++) {
    add(grams[i]);
    if (i >= size) remove(grams[i - size]);
    if (i >= size - 1) best = Math.max(best, hit);
  }
  return best / total;
}

// now(): the clock in milliseconds; lingerMs: how long after its end a reading still counts.
export function createOwnVoice({ now = Date.now, lingerMs = 5000 } = {}) {
  let readings = []; // { text, norm, lang, start, end } in the order they started; end null while read

  function counting() {
    const t = now();
    readings = readings.filter((r) => {
      if (r.end === null && t - r.start > MAX_READING_MS) r.end = r.start + MAX_READING_MS;
      return r.end === null || t <= r.end + lingerMs;
    });
    return readings.filter((r) => r.start <= t);
  }

  const joined = (list) => list.map((r) => r.norm).join('');

  return {
    // A reading starts: text as given to the synthesizer, lang its language code.
    started(text, lang) {
      const norm = normalize(text);
      if (!norm) return;
      readings.push({ text, norm, lang, start: now(), end: null });
      while (readings.length > MAX_READINGS) readings.shift();
    },
    // A reading ended (read to the end, failed or cancelled): the oldest unfinished one of that text.
    ended(text) {
      const r = readings.find((x) => x.end === null && x.text === text);
      if (r) r.end = now();
    },
    // Whether a finished sentence is the app's own voice.
    isOwn(text) {
      const norm = normalize(text);
      if (!norm) return false;
      const list = counting();
      if (!list.length) return false;
      if (list.some((r) => r.norm === norm)) return true;
      return weight(norm) >= MIN_WEIGHT && similarity(norm, joined(list)) >= THRESHOLD;
    },
    // Whether the sentence in progress may still be the app's own voice.
    mayBeOwn(text) {
      const norm = normalize(text);
      if (!norm) return false;
      const list = counting();
      return list.length > 0 && similarity(norm, joined(list)) >= THRESHOLD;
    },
  };
}
