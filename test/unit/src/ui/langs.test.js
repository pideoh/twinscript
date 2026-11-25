import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  followLangChange,
  followPlace,
  followThirdLangChange,
  LANGS,
  langLabel,
  langName,
  langTag,
} from '../../../../src/ui/langs.js';

const places = (A, B, C = '') => ({ A, B, C });

test('every offered language has a unique code, a display tag and an English name', () => {
  assert.ok(LANGS.length > 2);
  assert.equal(new Set(LANGS.map((l) => l.code)).size, LANGS.length);
  for (const l of LANGS) {
    assert.match(l.code, /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/);
    assert.ok(l.display && l.name, l.code);
  }
});

test('the translation prompt names a language in English, and nothing for one the app does not offer', () => {
  assert.equal(langName('ja-JP'), 'Japanese');
  assert.equal(langName('cmn-Hant-TW'), 'Traditional Chinese');
  assert.equal(langName('xx-XX'), undefined);
  assert.equal(langName(''), undefined);
});

test('language menus show names in the display language', () => {
  const ja = new Intl.DisplayNames(['ja'], { type: 'language' });
  assert.equal(langLabel('en-US', ja), ja.of('en'));
  assert.equal(langLabel('cmn-Hans-CN', ja), ja.of('zh-Hans'));
  const en = new Intl.DisplayNames(['en'], { type: 'language' });
  assert.equal(langLabel('ja-JP', en), 'Japanese');
});

test('without display names, or when they fail, a language shows its English name', () => {
  assert.equal(langLabel('ko-KR', null), 'Korean');
  const broken = {
    of() {
      throw new RangeError('unsupported');
    },
  };
  assert.equal(langLabel('ko-KR', broken), 'Korean');
  assert.equal(langLabel('ko-KR', { of: () => undefined }), 'Korean');
});

test('an unknown language shows its code', () => {
  assert.equal(langLabel('xx-XX', new Intl.DisplayNames(['en'], { type: 'language' })), 'xx-XX');
});

test('translation lines lead with a short upper-case code', () => {
  assert.equal(langTag('en-US', ['ja-JP', 'en-US', '']), 'EN');
  assert.equal(langTag('ja-JP', ['ja-JP', 'en-US', '']), 'JA');
  assert.equal(langTag('cmn-Hans-CN', ['ja-JP', 'cmn-Hans-CN', '']), 'ZH');
});

test('Simplified and Traditional Chinese selected together keep their full codes', () => {
  const selected = ['cmn-Hans-CN', 'cmn-Hant-TW', 'en-US'];
  assert.equal(langTag('cmn-Hans-CN', selected), 'ZH-HANS');
  assert.equal(langTag('cmn-Hant-TW', selected), 'ZH-HANT');
  assert.equal(langTag('en-US', selected), 'EN');
});

test('a code that is not offered is shown upper-cased by its first part', () => {
  assert.equal(langTag('xx-YY', ['ja-JP', 'en-US', '']), 'XX');
});

test('swapping the languages keeps a choice on the same language', () => {
  const was = places('ja-JP', 'en-US');
  const now = places('en-US', 'ja-JP');
  assert.equal(followPlace('A', was, now, 'all'), 'B');
  assert.equal(followPlace('B', was, now, 'off'), 'A');
});

test('choices that name no place are kept when languages change', () => {
  const was = places('ja-JP', 'en-US', 'ko-KR');
  const now = places('en-US', 'ja-JP', '');
  assert.equal(followPlace('all', was, now, 'all'), 'all');
  assert.equal(followPlace('off', was, now, 'off'), 'off');
  assert.equal(followPlace('both', was, now, 'off'), 'both');
});

test('switching a third language on keeps choices on the first two', () => {
  const was = places('ja-JP', 'en-US');
  const now = places('ja-JP', 'en-US', 'ko-KR');
  assert.equal(followPlace('A', was, now, 'all'), 'A');
  assert.equal(followPlace('B', was, now, 'off'), 'B');
});

test('a third language that takes the place of one of the first two carries the choice along', () => {
  // Korean is chosen as the third language while it was the second: English moves to the second place.
  const was = places('ja-JP', 'ko-KR', 'en-US');
  const now = places('ja-JP', 'en-US', 'ko-KR');
  assert.equal(followPlace('B', was, now, 'all'), 'C');
  assert.equal(followPlace('C', was, now, 'off'), 'B');
});

test('switching the third language off turns a choice of it into the fallback', () => {
  const was = places('ja-JP', 'en-US', 'ko-KR');
  const now = places('ja-JP', 'en-US', '');
  assert.equal(followPlace('C', was, now, 'all'), 'all', 'speech in other languages goes into all of them');
  assert.equal(followPlace('C', was, now, 'off'), 'off', 'reading aloud stops');
  assert.equal(followPlace('A', was, now, 'off'), 'A');
});

test('a choice of a place whose language is no longer selected stays on that place', () => {
  const was = places('ja-JP', 'en-US');
  const now = places('ja-JP', 'fr-FR');
  assert.equal(followPlace('B', was, now, 'all'), 'B');
});

test('a choice of the third place with no third language before or after falls back', () => {
  const none = places('ja-JP', 'en-US');
  assert.equal(followPlace('C', none, none, 'all'), 'all');
  assert.equal(followPlace('C', none, places('en-US', 'ja-JP'), 'off'), 'off');
});

test('choosing another first or second language leaves the others as they are', () => {
  const stored = places('ja-JP', 'en-US', 'ko-KR');
  assert.deepEqual(followLangChange('A', places('fr-FR', 'en-US', 'ko-KR'), stored), places('fr-FR', 'en-US', 'ko-KR'));
  assert.deepEqual(followLangChange('B', places('ja-JP', 'de-DE'), places('ja-JP', 'en-US')), places('ja-JP', 'de-DE'));
});

test('choosing for one side the language of the other never leaves the two the same', () => {
  const stored = places('ja-JP', 'en-US');
  assert.deepEqual(followLangChange('A', places('en-US', 'en-US'), stored), places('en-US', 'ja-JP'));
  assert.deepEqual(followLangChange('B', places('ja-JP', 'ja-JP'), stored), places('en-US', 'ja-JP'));
});

test('choosing for one side the language of the other swaps the two', () => {
  const stored = places('ja-JP', 'en-US');
  assert.deepEqual(followLangChange('A', places('en-US', 'en-US'), stored), places('en-US', 'ja-JP'));
  assert.deepEqual(followLangChange('B', places('ja-JP', 'ja-JP'), stored), places('en-US', 'ja-JP'));
  const other = places('fr-FR', 'de-DE');
  assert.deepEqual(followLangChange('A', places('de-DE', 'de-DE'), other), places('de-DE', 'fr-FR'));
  assert.deepEqual(followLangChange('B', places('fr-FR', 'fr-FR'), other), places('de-DE', 'fr-FR'));
});

test("choosing the other side's language with a third language selected swaps the two and leaves the third", () => {
  const stored = places('ja-JP', 'en-US', 'ko-KR');
  assert.deepEqual(followLangChange('A', places('en-US', 'en-US', 'ko-KR'), stored), places('en-US', 'ja-JP', 'ko-KR'));
  assert.deepEqual(followLangChange('B', places('ja-JP', 'ja-JP', 'ko-KR'), stored), places('en-US', 'ja-JP', 'ko-KR'));
});

test('choosing the third language for the first or second moves the third to the language that was there', () => {
  const stored = places('ja-JP', 'en-US', 'ko-KR');
  assert.deepEqual(followLangChange('A', places('ko-KR', 'en-US', 'ko-KR'), stored), places('ko-KR', 'en-US', 'ja-JP'));
  assert.deepEqual(followLangChange('B', places('ja-JP', 'ko-KR', 'ko-KR'), stored), places('ja-JP', 'ko-KR', 'en-US'));
});

test('a third language chosen from the first two swaps places with the third language it replaces', () => {
  const stored = places('ja-JP', 'en-US', 'ko-KR');
  assert.deepEqual(followThirdLangChange(places('ja-JP', 'en-US', 'ja-JP'), stored), places('ko-KR', 'en-US', 'ja-JP'));
  assert.deepEqual(followThirdLangChange(places('ja-JP', 'en-US', 'en-US'), stored), places('ja-JP', 'ko-KR', 'en-US'));
});

test('a third language chosen from the first two, when there was none, leaves there the first language not in use', () => {
  const free = LANGS.find((l) => !['ja-JP', 'en-US'].includes(l.code)).code;
  const stored = places('ja-JP', 'en-US');
  assert.deepEqual(followThirdLangChange(places('ja-JP', 'en-US', 'ja-JP'), stored), places(free, 'en-US', 'ja-JP'));
});

test('turning the third language off or choosing a new one changes nothing else', () => {
  const stored = places('ja-JP', 'en-US', 'ko-KR');
  assert.deepEqual(followThirdLangChange(places('ja-JP', 'en-US', ''), stored), places('ja-JP', 'en-US', ''));
  assert.deepEqual(followThirdLangChange(places('ja-JP', 'en-US', 'fr-FR'), stored), places('ja-JP', 'en-US', 'fr-FR'));
});
