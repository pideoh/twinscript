import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocale, t } from '../../../../src/ui/i18n.js';
import { listenSummary } from '../../../../src/ui/listen-summary.js';

test('two languages read as a pair translated both ways, then the audio input', () => {
  setLocale('en');
  assert.equal(
    listenSummary({ languages: ['Japanese', 'English'], input: 'Microphone' }, t),
    'Japanese ⇄ English · Microphone',
  );
  setLocale('ja');
  assert.equal(listenSummary({ languages: ['日本語', '英語'], input: 'マイク' }, t), '日本語 ⇄ 英語 ・ マイク');
  setLocale('zh-Hans');
  assert.equal(listenSummary({ languages: ['日语', '英语'], input: '麦克风' }, t), '日语 ⇄ 英语 · 麦克风');
});

test('three languages are all named, in their order', () => {
  setLocale('en');
  assert.equal(
    listenSummary({ languages: ['Japanese', 'English', 'Chinese'], input: 'PC audio' }, t),
    'Japanese, English, Chinese · PC audio',
  );
  setLocale('ja');
  assert.equal(
    listenSummary({ languages: ['日本語', '英語', '中国語'], input: 'PC音声' }, t),
    '日本語、英語、中国語 ・ PC音声',
  );
});

test('no third language (an empty name) is two languages; a missing one is left out', () => {
  setLocale('en');
  assert.equal(
    listenSummary({ languages: ['Korean', 'English', ''], input: 'Microphone' }, t),
    'Korean ⇄ English · Microphone',
  );
  assert.equal(listenSummary({ languages: ['Korean', ''], input: 'Microphone' }, t), 'Korean · Microphone');
});
