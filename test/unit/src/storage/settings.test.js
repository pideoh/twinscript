import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE } from '../../../../src/session/summary-templates.js';
import {
  DEFAULTS,
  loadSettings,
  normalizeSettings,
  SETTINGS_KEY,
  saveSettings,
} from '../../../../src/storage/settings.js';

// A Storage-like object over a Map, as localStorage would be.
function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (name) => (map.has(name) ? map.get(name) : null),
    setItem: (name, value) => map.set(name, String(value)),
    map,
  };
}
const stored = (value) => memoryStorage({ [SETTINGS_KEY]: JSON.stringify(value) });
const throwing = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('full', 'QuotaExceededError');
  },
};

test('settings are kept under rt-settings', () => {
  assert.equal(SETTINGS_KEY, 'rt-settings');
});

test('a first start gets the defaults', () => {
  const { settings, legacyKey } = loadSettings(memoryStorage());
  assert.deepEqual(settings, DEFAULTS);
  assert.equal(legacyKey, undefined);
  assert.equal(settings.langA, 'ja-JP');
  assert.equal(settings.langB, 'en-US');
  assert.equal(settings.langC, '');
  assert.equal(settings.summaryTemplate, DEFAULT_TEMPLATE);
});

test('stored settings win over the defaults, and missing ones take their default', () => {
  const { settings } = loadSettings(stored({ langA: 'ko-KR', fontSize: 24, interimTranslate: false }));
  assert.equal(settings.langA, 'ko-KR');
  assert.equal(settings.fontSize, 24);
  assert.equal(settings.interimTranslate, false, 'a stored false is kept');
  assert.equal(settings.langB, DEFAULTS.langB);
  assert.equal(settings.readAloud, DEFAULTS.readAloud);
});

test('a stored null or missing value takes its default; an empty string is kept', () => {
  const { settings } = loadSettings(stored({ translateModel: null, glossary: '' }));
  assert.equal(settings.translateModel, DEFAULTS.translateModel);
  assert.equal(settings.glossary, '');
});

test('settings an earlier version stored that no longer exist are dropped', () => {
  const { settings } = loadSettings(stored({ langA: 'en-US', theme: 'dark', oldThing: 1 }));
  assert.deepEqual(Object.keys(settings), Object.keys(DEFAULTS));
  assert.equal(settings.langA, 'en-US');
});

test('an API key an earlier version kept in the settings is handed over and left out of them', () => {
  const { settings, legacyKey } = loadSettings(stored({ apiKey: 'old-key', langB: 'fr-FR' }));
  assert.equal(legacyKey, 'old-key');
  assert.equal('apiKey' in settings, false);
  assert.equal(settings.langB, 'fr-FR');
  assert.equal(loadSettings(stored({ apiKey: 42 })).legacyKey, undefined, 'only a string counts as a key');
});

test('unreadable stored settings start from the defaults', () => {
  for (const raw of ['{broken', 'null', '', '7', '"text"', '[]']) {
    const { settings, legacyKey } = loadSettings(memoryStorage({ [SETTINGS_KEY]: raw }));
    assert.deepEqual(settings, DEFAULTS, raw);
    assert.equal(legacyKey, undefined, raw);
  }
});

test('storage that cannot be read starts from the defaults', () => {
  assert.deepEqual(loadSettings(throwing).settings, DEFAULTS);
});

test('saved settings come back on the next start, without the API key', () => {
  const storage = memoryStorage();
  const { settings } = loadSettings(storage);
  settings.langC = 'ko-KR';
  settings.priceOverrides = { 'gemini-3.5-flash-lite': { input: 0.2 } };
  saveSettings(storage, settings);
  assert.deepEqual(JSON.parse(storage.map.get(SETTINGS_KEY)), settings);
  assert.deepEqual(loadSettings(storage).settings, settings);
});

test('storage that refuses to save leaves the app running', () => {
  assert.doesNotThrow(() => saveSettings(throwing, { ...DEFAULTS }));
});

test('a stored third language that is not offered, or equals one of the first two, is turned off', () => {
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: 'xx-XX' }).langC, '');
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: 'ja-JP' }).langC, '');
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: 'en-US' }).langC, '');
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: 'ko-KR' }).langC, 'ko-KR');
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: '' }).langC, '');
});

test('speech in other languages goes into all of them when the stored choice no longer fits', () => {
  assert.equal(normalizeSettings({ ...DEFAULTS, otherInto: 'both' }).otherInto, 'all', 'unknown choice');
  assert.equal(normalizeSettings({ ...DEFAULTS, otherInto: 'C' }).otherInto, 'all', 'no third language');
  assert.equal(
    normalizeSettings({ ...DEFAULTS, langC: 'ja-JP', otherInto: 'C' }).otherInto,
    'all',
    'the third language was turned off first',
  );
  assert.equal(normalizeSettings({ ...DEFAULTS, langC: 'ko-KR', otherInto: 'C' }).otherInto, 'C');
  assert.equal(normalizeSettings({ ...DEFAULTS, otherInto: 'B' }).otherInto, 'B');
});

test('settings that fit are left as they are, in the same object', () => {
  const settings = { ...DEFAULTS, langC: 'ko-KR', otherInto: 'A', readAloud: 'C' };
  const copy = { ...settings };
  assert.equal(normalizeSettings(settings), settings);
  assert.deepEqual(settings, copy);
});
