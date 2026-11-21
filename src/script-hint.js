// Tells from the writing system which way a transcript should be translated, so that the
// direction does not depend on the translation model recognizing the language. Pure functions.
// Languages are the English names the translator is given.

// Writing system of each language that does not use the Latin alphabet.
const SCRIPT = {
  Japanese: 'kana',
  'Simplified Chinese': 'han',
  'Traditional Chinese': 'han',
  Korean: 'hangul',
  Thai: 'thai',
  Hindi: 'devanagari',
};
const scriptOf = (language) => SCRIPT[language] ?? 'latin';

const COUNTERS = {
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  han: /\p{Script=Han}/gu,
  hangul: /\p{Script=Hangul}/gu,
  thai: /\p{Script=Thai}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  latin: /\p{Script=Latin}/gu,
};
const MIN_LETTERS = 4; // shorter text says too little
const MIN_HAN_ONLY = 8; // Japanese rarely runs this long without any kana
const DOMINANT = 0.6;

// 'kana' | 'han' | 'hangul' | 'thai' | 'devanagari' | 'latin' | 'other', or null when unclear.
export function scriptClass(text) {
  const s = String(text ?? '');
  const letters = s.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return null;
  const count = (name) => s.match(COUNTERS[name])?.length ?? 0;
  const kana = count('kana');
  const han = count('han');
  if (kana >= 2) return 'kana'; // Japanese, whatever foreign terms are mixed in
  if (kana) return null;
  if (han / letters >= DOMINANT) return han >= MIN_HAN_ONLY ? 'han' : null;
  let known = han;
  for (const name of ['hangul', 'thai', 'devanagari', 'latin']) {
    const n = count(name);
    if (n / letters >= DOMINANT) return name;
    known += n;
  }
  return (letters - known) / letters >= DOMINANT ? 'other' : null;
}

// The language to translate `text` into, or null when the writing system does not settle it
// (both languages share it, or the text is short or mixed).
export function targetByScript(text, { langA, langB, otherInto }) {
  const cls = scriptClass(text);
  if (!cls) return null;
  const a = scriptOf(langA) === cls;
  const b = scriptOf(langB) === cls;
  if (a && b) return null;
  if (a) return langB;
  if (b) return langA;
  return otherInto;
}
