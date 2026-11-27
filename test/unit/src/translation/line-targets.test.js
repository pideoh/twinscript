import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HISTORY_LINES,
  intoSeveral,
  perTarget,
  recentHistory,
  targetCodes,
} from '../../../../src/translation/line-targets.js';
import { LANGS } from '../../../../src/ui/langs.js';

const lang = (code) => LANGS.find((l) => l.code === code);
const JA = lang('ja-JP');
const EN = lang('en-US');
const KO = lang('ko-KR');

test('a line goes into every other selected language, in the order of the selects', () => {
  assert.deepEqual(targetCodes([JA, EN, KO], 'English', 'all'), ['ja-JP', 'ko-KR']);
  assert.deepEqual(targetCodes([JA, EN], 'Japanese', 'all'), ['en-US']);
});

test('a line in none of the languages goes into all of them, or only the one the setting names', () => {
  assert.deepEqual(targetCodes([JA, EN, KO], 'other', 'all'), ['ja-JP', 'en-US', 'ko-KR']);
  assert.deepEqual(targetCodes([JA, EN, KO], 'other', 'C'), ['ko-KR']);
  assert.deepEqual(targetCodes([JA, EN], 'other', 'B'), ['en-US']);
});

test('with two languages only a line written in neither gets a line per target, unless the setting picks one', () => {
  assert.equal(intoSeveral([JA, EN], 'Hello, how are you today?', 'all'), false);
  assert.equal(intoSeveral([JA, EN], '안녕하세요 오늘 회의를 시작합니다', 'all'), true);
  assert.equal(intoSeveral([JA, EN], '안녕하세요 오늘 회의를 시작합니다', 'A'), false);
  assert.equal(perTarget([JA, EN], '안녕하세요 오늘 회의를 시작합니다', 'all'), true);
  assert.equal(perTarget([JA, EN], 'Hello, how are you today?', 'all'), false);
});

test('with a third language every line gets a line per target', () => {
  assert.equal(perTarget([JA, EN, KO], 'Hello, how are you today?', 'all'), true);
});

test('the context of a request is the last translated lines, per target where there are several', () => {
  const segments = [
    { src: 'a', tgt: 'A' },
    { src: 'b', tgt: '' },
    {
      src: 'c',
      tgt: 'C1\nC2',
      tgts: [
        { lang: 'ja-JP', text: 'C1' },
        { lang: 'ko-KR', text: 'C2' },
      ],
    },
    { src: 'd', tgt: 'D' },
    { src: 'e', tgt: 'E' },
  ];
  assert.equal(HISTORY_LINES, 3);
  assert.deepEqual(recentHistory(segments), [
    { src: 'c', tgt: 'C1\nC2' },
    { src: 'd', tgt: 'D' },
    { src: 'e', tgt: 'E' },
  ]);
  assert.deepEqual(recentHistory(segments, 'ko-KR')[0], { src: 'c', tgt: 'C2' });
  assert.deepEqual(recentHistory([]), []);
});
