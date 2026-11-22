// Tells from the writing system which way a transcript should be translated (or, with three
// languages, which language it is in), so that the
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
const SHARED = new Set(['latin', 'devanagari']);
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
  if (!a && !b) return otherInto;
  const written = a ? langA : langB;
  const other = a ? langB : langA;
  // Many languages share these writing systems, so the text may also be a third language.
  // That only matters when a third language would go the other way.
  if (SHARED.has(cls) && otherInto === written) return null;
  return other;
}

// Which of `languages` `text` is spoken in, told from its writing system: the one language that
// uses it, 'other' when none of them does, or null when the writing system does not settle it
// (the text is short or mixed, or two of the languages share it). A language outside the list
// written like one in it (French with English selected) counts as that one.
export function sourceByScript(text, languages) {
  const cls = scriptClass(text);
  if (!cls) return null;
  const matching = languages.filter((language) => scriptOf(language) === cls);
  if (matching.length > 1) return null;
  return matching[0] ?? 'other';
}

// Whether text in langA can be told from text in langB by its writing system alone.
export const scriptsDiffer = (langA, langB) => scriptOf(langA) !== scriptOf(langB);

// Which of the two languages `text` is written in (langA or langB), or null when the writing
// system does not settle it (both languages share it, or the text is short or mixed).
export function languageByScript(text, langA, langB) {
  if (!scriptsDiffer(langA, langB)) return null;
  const cls = scriptClass(text);
  if (cls === scriptOf(langA)) return langA;
  if (cls === scriptOf(langB)) return langB;
  return null;
}
