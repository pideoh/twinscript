// UI translations. The core (locale resolution, lookup) has no DOM access so it can be unit-tested;
// applyTranslations() is the only part that touches the page.
// To add a language: add src/ui/locales/<id>.js and register it in LOCALES below.
import en from './locales/en.js';
import ja from './locales/ja.js';
import zhHans from './locales/zh-Hans.js';

export const DEFAULT_LOCALE = 'en';

// id: a BCP 47 tag, also used for <html lang> and Intl. aliases: browser languages that match
// exactly, in addition to the id itself and any tag that starts with `${id}-`.
const LOCALES = [
  { id: 'en', messages: en },
  { id: 'ja', messages: ja },
  { id: 'zh-Hans', messages: zhHans, aliases: ['zh', 'zh-CN', 'zh-SG'] },
];

const hasOwn = (obj, key) => Object.hasOwn(obj, key);
const catalog = (id) => LOCALES.find((l) => l.id === id)?.messages;

// [{ id, name }], each language named in itself.
export const availableLocales = () => LOCALES.map((l) => ({ id: l.id, name: l.messages['language.name'] }));

export const catalogs = () => Object.fromEntries(LOCALES.map((l) => [l.id, l.messages]));

function matchTag(tag) {
  const t = String(tag || '').toLowerCase();
  if (!t) return null;
  for (const l of LOCALES) {
    const id = l.id.toLowerCase();
    if (t === id || t.startsWith(`${id}-`)) return l.id;
    if (l.aliases?.some((a) => a.toLowerCase() === t)) return l.id;
  }
  return null;
}

// preferred: 'auto' or a locale id. navigatorLanguages: navigator.languages (most preferred first).
export function resolveLocale(preferred, navigatorLanguages = []) {
  if (preferred && preferred !== 'auto' && catalog(preferred)) return preferred;
  for (const tag of navigatorLanguages || []) {
    const id = matchTag(tag);
    if (id) return id;
  }
  return DEFAULT_LOCALE;
}

let active = DEFAULT_LOCALE;

export function setLocale(id) {
  active = catalog(id) ? id : DEFAULT_LOCALE;
  return active;
}

export const getLocale = () => active;

// Placeholders are written {name}. A key missing in the active locale falls back to English,
// and a key missing everywhere comes back as the key itself.
export function t(key, params) {
  const messages = catalog(active);
  const msg = hasOwn(messages, key) ? messages[key] : hasOwn(en, key) ? en[key] : key;
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name) => (hasOwn(params, name) ? String(params[name]) : m));
}

// Applies translations to static markup under `root`: data-i18n sets the text,
// data-i18n-title / -aria-label / -placeholder set those attributes. Also sets <html lang>.
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`))
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
  (root.documentElement ?? root.ownerDocument?.documentElement)?.setAttribute('lang', active);
}
