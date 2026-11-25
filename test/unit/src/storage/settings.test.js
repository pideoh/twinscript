import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE } from '../../../../src/session/summary-templates.js';
import {
  canReadAloud,
  DEFAULTS,
  knownUiLang,
  loadSettings,
  normalizeSettings,
  otherIntoChoices,
  readAloudChoices,
  SETTINGS_KEY,
  saveSettings,
  selectedLangs,
  shownOtherInto,
  shownReadAloud,
  translateModelOr,
  usableSource,
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

test('a stored first or second language that is not offered goes back to the default for its side', () => {
  const fixed = normalizeSettings({ ...DEFAULTS, langA: 'xx-XX', langB: 'fr-FR' });
  assert.deepEqual([fixed.langA, fixed.langB], ['ja-JP', 'fr-FR']);
  const second = normalizeSettings({ ...DEFAULTS, langA: 'fr-FR', langB: 'xx-XX' });
  assert.deepEqual([second.langA, second.langB], ['fr-FR', 'en-US']);
  const both = normalizeSettings({ ...DEFAULTS, langA: 'xx-XX', langB: 'yy-YY' });
  assert.deepEqual([both.langA, both.langB], ['ja-JP', 'en-US']);
  const missing = normalizeSettings({ ...DEFAULTS, langA: undefined, langB: null });
  assert.deepEqual([missing.langA, missing.langB], ['ja-JP', 'en-US']);
});

test('a stored second language equal to the first takes the other default', () => {
  const same = normalizeSettings({ ...DEFAULTS, langA: 'fr-FR', langB: 'fr-FR' });
  assert.deepEqual([same.langA, same.langB], ['fr-FR', 'en-US']);
  const english = normalizeSettings({ ...DEFAULTS, langA: 'en-US', langB: 'en-US' });
  assert.deepEqual([english.langA, english.langB], ['en-US', 'ja-JP']);
  const japanese = normalizeSettings({ ...DEFAULTS, langA: 'xx-XX', langB: 'ja-JP' });
  assert.deepEqual([japanese.langA, japanese.langB], ['ja-JP', 'en-US']);
});

test('a stored language that is not offered no longer breaks reading aloud', () => {
  const settings = normalizeSettings({ ...DEFAULTS, langA: 'xx-XX', langB: 'yy-YY' });
  assert.doesNotThrow(() => canReadAloud(settings));
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

const two = { ...DEFAULTS, langA: 'ja-JP', langB: 'en-US', langC: '' };
const three = { ...two, langC: 'ko-KR' };

test('the languages in use are the first two, and the third while there is one', () => {
  assert.deepEqual(selectedLangs(two), ['ja-JP', 'en-US']);
  assert.deepEqual(selectedLangs(three), ['ja-JP', 'en-US', 'ko-KR']);
});

test('a display language the app does not have falls back to following the system', () => {
  assert.equal(knownUiLang('ja', ['en', 'ja']), 'ja');
  assert.equal(knownUiLang('auto', ['en', 'ja']), 'auto');
  assert.equal(knownUiLang('xx', ['en', 'ja']), 'auto');
});

test('the audio source falls back to the microphone where PC audio or an audio file cannot be used', () => {
  assert.equal(usableSource('system', { systemAudio: true, debug: false }), 'system');
  assert.equal(usableSource('system', { systemAudio: false, debug: false }), 'mic');
  assert.equal(usableSource('file', { systemAudio: false, debug: true }), 'mic');
  assert.equal(usableSource('file', { systemAudio: true, debug: false }), 'mic');
  assert.equal(usableSource('file', { systemAudio: true, debug: true }), 'file');
});

test('an empty translation model field means the default model; a typed one is kept without spaces', () => {
  assert.equal(translateModelOr(''), DEFAULTS.translateModel);
  assert.equal(translateModelOr('   '), DEFAULTS.translateModel);
  assert.equal(translateModelOr(' my-model \n'), 'my-model');
});

test('speech in other languages can go into all of them or one, the third only while there is one', () => {
  assert.deepEqual(otherIntoChoices(two), [
    { value: 'all' },
    { value: 'A', lang: 'ja-JP' },
    { value: 'B', lang: 'en-US' },
  ]);
  assert.deepEqual(
    otherIntoChoices(three).map((c) => c.value),
    ['all', 'A', 'B', 'C'],
  );
  assert.equal(otherIntoChoices(three).at(-1).lang, 'ko-KR');
});

test('a choice for other languages that is not offered shows as all of them', () => {
  assert.equal(shownOtherInto('B', otherIntoChoices(two)), 'B');
  assert.equal(shownOtherInto('C', otherIntoChoices(two)), 'all');
  assert.equal(shownOtherInto('', otherIntoChoices(two)), 'all');
  assert.equal(shownOtherInto('C', otherIntoChoices(three)), 'C');
});

test('reading aloud offers each language, and both directions with two languages only', () => {
  assert.deepEqual(readAloudChoices(two), [
    { value: 'off' },
    { value: 'A', lang: 'ja-JP' },
    { value: 'B', lang: 'en-US' },
    { value: 'both' },
  ]);
  assert.deepEqual(
    readAloudChoices(three).map((c) => c.value),
    ['off', 'A', 'B', 'C'],
  );
});

test('a reading-aloud choice that does not fit the languages selected shows as off', () => {
  assert.equal(shownReadAloud({ ...two, readAloud: 'both' }), 'both');
  assert.equal(shownReadAloud({ ...two, readAloud: 'C' }), 'off');
  assert.equal(shownReadAloud({ ...three, readAloud: 'both' }), 'off');
  assert.equal(shownReadAloud({ ...three, readAloud: 'C' }), 'C');
  assert.equal(shownReadAloud({ ...two, readAloud: 'off' }), 'off');
});

test('reading aloud can be chosen for two languages written differently, and always with three', () => {
  assert.equal(canReadAloud(two), true);
  assert.equal(canReadAloud({ ...two, langA: 'es-ES', langB: 'fr-FR' }), false);
  assert.equal(canReadAloud({ ...two, langA: 'es-ES', langB: 'fr-FR', langC: 'ja-JP' }), true);
});
