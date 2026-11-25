import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineBefore, sameTargets, singleLineLang, sourceLineLang } from '../../../../src/ui/transcript-view.js';

const JA = 'ja-JP';
const EN = 'en-US';
const ES = 'es-ES';
const KO = 'ko-KR';

test('a translation is tagged with the language its writing system shows', () => {
  assert.equal(singleLineLang('今日は晴れです。', 'It is sunny today.', [JA, EN]), JA);
  assert.equal(singleLineLang('It is sunny today.', '今日は晴れです。', [JA, EN]), EN);
});

test('a translation whose writing system does not tell is tagged as the other language than its source', () => {
  // Digits alone settle nothing; the Japanese source does.
  assert.equal(singleLineLang('2026', '二〇二六年です。', [JA, EN]), EN);
});

test('a translation gets no tag when the two languages share a writing system or there is no text yet', () => {
  assert.equal(singleLineLang('Hace sol hoy.', 'It is sunny today.', [ES, EN]), null);
  assert.equal(singleLineLang('', '今日は晴れです。', [JA, EN]), null);
  assert.equal(singleLineLang('今日は晴れです。', 'x', ['xx-XX', EN]), null);
});

test('the source is tagged with the language found when it was translated', () => {
  const selected = [JA, EN, KO];
  assert.equal(sourceLineLang({ lang: KO, text: 'It is sunny.', translation: '', selected, multi: true }), KO);
});

test('speech in none of the selected languages gets no source tag', () => {
  const selected = [JA, EN, KO];
  assert.equal(sourceLineLang({ lang: 'other', text: 'Hace sol.', translation: '', selected, multi: true }), null);
});

test('without a language found yet the source is tagged from its own writing system', () => {
  const selected = [JA, EN, ''];
  assert.equal(sourceLineLang({ text: '今日は晴れです。', translation: '', selected, multi: false }), JA);
});

test('a source whose writing system does not tell is tagged as the other language than its single translation', () => {
  const selected = [JA, EN, ''];
  assert.equal(sourceLineLang({ text: '2026', translation: '二〇二六年です。', selected, multi: false }), EN);
  // With a line per target language, the translation does not tell.
  assert.equal(sourceLineLang({ text: '2026', translation: '二〇二六年です。', selected, multi: true }), null);
});

test('a segment keeps its translation lines when they are for the same languages in the same order', () => {
  const tgts = [
    { lang: EN, text: 'Hi' },
    { lang: KO, text: '' },
  ];
  assert.equal(sameTargets(tgts, [EN, KO]), true);
  assert.equal(sameTargets(tgts, [KO, EN]), false);
  assert.equal(sameTargets(tgts, [EN]), false);
  assert.equal(sameTargets(undefined, [EN, KO]), false);
});

test('translation lines stay in the order of the target languages, whichever arrives first', () => {
  // KO is shown; EN comes before it.
  assert.equal(lineBefore([EN, KO], [KO], EN), KO);
  // EN is shown; KO goes last.
  assert.equal(lineBefore([EN, KO], [EN], KO), undefined);
  assert.equal(lineBefore([JA, EN, KO], [KO], EN), KO);
  assert.equal(lineBefore([JA, EN, KO], [EN, KO], JA), EN);
});
