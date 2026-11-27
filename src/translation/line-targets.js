// What a finished line is translated into and what it is sent with, decided the same way for a line
// heard while listening (src/translation/flow.js) and for lines translated after the fact: whether
// it gets one translation line per target language, which languages those are, and the earlier
// lines sent as context. Pure functions.
//
// langs: [{ code, name }], the two or three languages of the session in the order of the selects;
// otherInto: the setting for speech in none of them ('A', 'B', 'C' or 'all').

import { sourceByScript, targetLanguages } from './script-hint.js';

export const HISTORY_LINES = 3;

// The codes of the languages a line goes into: the selected ones other than the one it was spoken in
// (source: an English name or 'other'), in the order of the selects, narrowed by the setting for
// other languages.
export const targetCodes = (langs, source, otherInto) =>
  targetLanguages(
    langs.map((l) => l.name),
    source,
    otherInto,
  ).map((name) => langs.find((l) => l.name === name).code);

// With two languages, a line whose writing system shows it is in neither goes into both, one tagged
// line each, unless the setting picks one of them. Everything else takes one request with the rules
// for two languages, which never asks the model which language it is.
export const intoSeveral = (langs, text, otherInto) =>
  langs.length === 2 &&
  sourceByScript(
    text,
    langs.map((l) => l.name),
  ) === 'other' &&
  targetCodes(langs, 'other', otherInto).length > 1;

// Whether a line is translated into one line per target language: always with a third language,
// and with two for a line in neither of them (intoSeveral).
export const perTarget = (langs, text, otherInto) => langs.length > 2 || intoSeveral(langs, text, otherInto);

// The earlier lines sent with a request as context: the last HISTORY_LINES of `segments` that have a
// translation, as [{ src, tgt }]. lang: with one line per target, the target whose own earlier
// translations are wanted (a line without one gives its joined translations).
export const recentHistory = (segments, lang) =>
  segments
    .filter((x) => x.tgt)
    .slice(-HISTORY_LINES)
    .map(({ src, tgt, tgts }) => ({ src, tgt: (lang && tgts?.find((x) => x.lang === lang)?.text) || tgt }));
