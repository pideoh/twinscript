// The user's settings: their defaults, and how they are kept as JSON in localStorage under
// SETTINGS_KEY. DOM-free: the storage (a Storage-like object with getItem / setItem) is passed in.
// The API key is not part of the settings and is never written here (see secrets.js).

import { DEFAULT_TEMPLATE } from '../session/summary-templates.js';
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

// Drops stored choices that no longer fit, in place: a third language the app does not offer or
// that equals one of the first two is turned off, and a choice for other languages that is unknown,
// or names the third language when there is none, goes back to all of them. Returns the settings.
export function normalizeSettings(settings) {
  if (!LANGS.some((l) => l.code === settings.langC) || [settings.langA, settings.langB].includes(settings.langC))
    settings.langC = '';
  if (!['all', 'A', 'B', 'C'].includes(settings.otherInto) || (settings.otherInto === 'C' && !settings.langC))
    settings.otherInto = 'all';
  return settings;
}
