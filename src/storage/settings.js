// The user's settings: their defaults, how they are kept as JSON in localStorage under SETTINGS_KEY,
// and the rules the settings dialog follows (which choices it offers for the languages selected, what
// a field falls back to; src/ui/settings-dialog.js shows them). DOM-free: the storage (a Storage-like
// object with getItem / setItem) is passed in.
// The API key is not part of the settings and is never written here (see secrets.js).

import { DEFAULT_TEMPLATE } from '../session/summary-templates.js';
import { readAloudLanguages } from '../translation/read-aloud.js';
import { scriptsDiffer } from '../translation/script-hint.js';
import { LANGS } from '../ui/langs.js';

export const SETTINGS_KEY = 'rt-settings';

export const DEFAULTS = {
  langA: 'ja-JP',
  langB: 'en-US',
  langC: '', // an optional third language: every sentence is then translated into the other two
  source: 'mic',
  uiLang: 'auto',
  translateModel: 'gemini-3.5-flash-lite',
  interimTranslate: true,
  smart: false,
  record: true,
  glossary: '',
  vocabulary: '', // terms for the recognizer and `wrong => right` corrections, one per line
  fontSize: 18,
  // Speech in none of the selected languages goes into all of them ('all') or only into the one
  // in that place ('A', 'B' or 'C').
  otherInto: 'all',
  // Translations into which language are read aloud: 'off', 'A', 'B', 'C' (three languages only) or
  // 'both' (two languages only). A choice that does not fit the languages selected reads nothing.
  readAloud: 'off',
  captionItems: 3, // sentences kept in the caption zone, including the one being spoken
  captionContent: 'both', // 'both' or 'tgt' (translation only) in the caption zone
  // The same two with a third language, remembered apart. Translations only, so a sentence takes
  // two lines there as well; fewer sentences would be replaced before they can be read.
  captionItems3: 3,
  captionContent3: 'tgt',
  captionFontSize: 20, // text size while the caption zone is in the caption window
  captionOpacity: 90, // background of the desktop caption overlay, in percent
  clickThrough: false, // desktop caption overlay: mouse events go to the app underneath
  globalShortcuts: true, // desktop app: start / stop and the caption window from any app
  checkUpdates: true, // desktop app: ask GitHub once a day whether a newer version is out
  interimInterval: 1.5, // seconds between re-translations of the sentence being spoken
  summaryTemplate: DEFAULT_TEMPLATE, // the template, length and language last used for a summary
  summaryLength: 'standard',
  summaryLanguage: '', // a language code, or '' for the display language
  // Prices for cost estimates that differ from src/usage/pricing.js: { [model]: { input?, output?, ... } }.
  priceOverrides: {},
};

// The known settings only, each stored value over its default (unreadable JSON, or storage that
// cannot be read, gives the defaults), plus the API key an earlier version kept in the same JSON
// (undefined when there is none), so the caller can move it out.
export function loadSettings(storage) {
  let stored = {};
  try {
    stored = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}') ?? {};
  } catch {
    /* unreadable: start from the defaults */
  }
  const known = Object.fromEntries(Object.keys(DEFAULTS).map((name) => [name, stored[name] ?? DEFAULTS[name]]));
  return { settings: known, legacyKey: typeof stored.apiKey === 'string' ? stored.apiKey : undefined };
}

// Writes the settings; storage that refuses (private mode, full) leaves them unsaved for this page only.
export function saveSettings(storage, settings) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

// Drops stored choices that no longer fit, in place: a first or second language the app does not
// offer goes back to the default for its side (the second takes the other default when the two would
// be the same), a third language the app does not offer or
// that equals one of the first two is turned off, and a choice for other languages that is unknown,
// or names the third language when there is none, goes back to all of them. Returns the settings.
export function normalizeSettings(settings) {
  const offered = (code) => LANGS.some((l) => l.code === code);
  if (!offered(settings.langA)) settings.langA = DEFAULTS.langA;
  if (!offered(settings.langB)) settings.langB = DEFAULTS.langB;
  if (settings.langB === settings.langA)
    settings.langB = settings.langA === DEFAULTS.langB ? DEFAULTS.langA : DEFAULTS.langB;
  if (!LANGS.some((l) => l.code === settings.langC) || [settings.langA, settings.langB].includes(settings.langC))
    settings.langC = '';
  if (!['all', 'A', 'B', 'C'].includes(settings.otherInto) || (settings.otherInto === 'C' && !settings.langC))
    settings.otherInto = 'all';
  return settings;
}

// The codes of the languages selected: the first two, and the third when there is one.
export const selectedLangs = (settings) => [settings.langA, settings.langB, settings.langC].filter(Boolean);

// The display language setting, or 'auto' when it names none of `localeIds` (the display languages
// the app has).
export const knownUiLang = (uiLang, localeIds) => (localeIds.includes(uiLang) ? uiLang : 'auto');

// Where the audio comes from: the microphone when PC audio cannot be captured here, and when an
// audio file is stored but the file input (debug only) is not offered.
export function usableSource(source, { systemAudio, debug }) {
  if (!systemAudio) return 'mic';
  return !debug && source === 'file' ? 'mic' : source;
}

// The translation model typed in the settings, or the default when the field is left empty.
export const translateModelOr = (text) => text.trim() || DEFAULTS.translateModel;

// The choices for speech in none of the selected languages: all of them, or one of them (the third
// only while there is one). Each is { value } or { value, lang } with the code of that language.
export function otherIntoChoices(settings) {
  const sides = settings.langC ? ['A', 'B', 'C'] : ['A', 'B'];
  return [{ value: 'all' }, ...sides.map((s) => ({ value: s, lang: settings[`lang${s}`] }))];
}

// The choice shown for `value` among `choices`: itself when it is offered, otherwise all languages.
export const shownOtherInto = (value, choices) => (choices.some((c) => c.value === value) ? value : 'all');

// The choices for reading aloud: off, one per selected language, and both directions with two
// languages only. Each is { value } or { value, lang } as above.
export function readAloudChoices(settings) {
  const three = !!settings.langC;
  const sides = three ? ['A', 'B', 'C'] : ['A', 'B'];
  return [
    { value: 'off' },
    ...sides.map((s) => ({ value: s, lang: settings[`lang${s}`] })),
    ...(three ? [] : [{ value: 'both' }]),
  ];
}

// The reading-aloud choice shown: the stored one, or off when it does not fit the languages selected.
export const shownReadAloud = (settings) =>
  readAloudLanguages(settings.readAloud, selectedLangs(settings)).length ? settings.readAloud : 'off';

// Whether reading aloud can be chosen. With two languages it needs the language of each translation,
// which only the writing system tells, so the two must be written differently. With three, each
// translation line is requested into a known language.
export const canReadAloud = (settings) =>
  !!settings.langC ||
  scriptsDiffer(LANGS.find((l) => l.code === settings.langA).name, LANGS.find((l) => l.code === settings.langB).name);
