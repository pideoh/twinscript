import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  availableLocales,
  catalogs,
  DEFAULT_LOCALE,
  getLocale,
  resolveLocale,
  setLocale,
  t,
} from '../../../src/ui/i18n.js';

afterEach(() => setLocale(DEFAULT_LOCALE));

test('resolveLocale follows the first supported browser language when set to auto', () => {
  assert.equal(resolveLocale('auto', ['ja-JP', 'en-US']), 'ja');
  assert.equal(resolveLocale('auto', ['ja']), 'ja');
  assert.equal(resolveLocale('auto', ['en-GB']), 'en');
  assert.equal(resolveLocale('auto', ['fr-FR', 'ja-JP']), 'ja', 'skips unsupported languages');
  assert.equal(resolveLocale('auto', ['fr-FR', 'de']), 'en', 'English when nothing matches');
  assert.equal(resolveLocale('auto', []), 'en');
  assert.equal(resolveLocale('auto', undefined), 'en');
  assert.equal(resolveLocale(undefined, ['ja-JP']), 'ja');
});

test('resolveLocale maps Simplified Chinese tags to zh-Hans and leaves Traditional to English', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh-hans-sg', 'ZH-cn']) {
    assert.equal(resolveLocale('auto', [tag]), 'zh-Hans', tag);
  }
  for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) {
    assert.equal(resolveLocale('auto', [tag]), 'en', tag);
  }
  assert.equal(resolveLocale('auto', ['zh-TW', 'ja']), 'ja');
});

test('an explicit setting wins over the browser; an unknown one counts as auto', () => {
  assert.equal(resolveLocale('en', ['ja-JP']), 'en');
  assert.equal(resolveLocale('zh-Hans', ['en-US']), 'zh-Hans');
  assert.equal(resolveLocale('ja', []), 'ja');
  assert.equal(resolveLocale('xx', ['ja-JP']), 'ja');
});

test('t fills placeholders and falls back to English, then to the key', () => {
  setLocale('ja');
  assert.equal(getLocale(), 'ja');
  assert.equal(t('toggle.start'), '翻訳開始');
  assert.equal(
    t('export.recording', { n: 2, date: '2026-11-15 09:05', length: '00:01:00' }),
    '録音 2 ・ 2026-11-15 09:05 ・ 00:01:00',
  );
  assert.equal(t('error.disconnectedCode', { code: 0 }), '接続が切れました（コード 0）', 'falsy values are filled in');
  assert.equal(t('error.connectFailed', {}), '接続できませんでした: {reason}', 'missing values leave the placeholder');
  assert.equal(t('settings.apiKey.helpBefore'), '', 'an empty translation is a translation');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('no.such.key', { a: 1 }), 'no.such.key');

  setLocale('en');
  assert.equal(t('toggle.start'), 'Start translating');
  assert.equal(setLocale('xx'), 'en', 'unknown locales fall back to English');
});

test('a key missing in the active locale falls back to English', () => {
  const ja = catalogs().ja;
  const saved = ja['toggle.stop'];
  delete ja['toggle.stop'];
  try {
    setLocale('ja');
    assert.equal(t('toggle.stop'), 'Stop');
  } finally {
    ja['toggle.stop'] = saved;
  }
});

const placeholders = (msg) => [...msg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every locale has exactly the keys of English, with the same placeholders', () => {
  const all = catalogs();
  const enKeys = Object.keys(all.en).sort();
  assert.ok(enKeys.length > 50);
  for (const [id, messages] of Object.entries(all)) {
    assert.deepEqual(Object.keys(messages).sort(), enKeys, `${id} has the same keys as en`);
    for (const key of enKeys) {
      assert.equal(typeof messages[key], 'string', `${id} ${key}`);
      assert.deepEqual(placeholders(messages[key]), placeholders(all.en[key]), `${id} ${key} placeholders`);
    }
  }
});

test('each language is offered under its own name', () => {
  assert.deepEqual(availableLocales(), [
    { id: 'en', name: 'English' },
    { id: 'ja', name: '日本語' },
    { id: 'zh-Hans', name: '简体中文' },
  ]);
});
