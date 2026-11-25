import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  languageByScript,
  scriptClass,
  scriptsDiffer,
  sourceByScript,
  targetByScript,
  targetLanguages,
} from '../../../src/script-hint.js';

const jaEn = { langA: 'Japanese', langB: 'English', otherInto: 'Japanese' };

test('Chinese and Hindi in a Japanese-English meeting go to the chosen language, not to English', () => {
  assert.equal(targetByScript('但是我想我们这一批人,或者我们这一代人,有一个东西', jaEn), 'Japanese');
  assert.equal(targetByScript('और यह है छोटे सिंक्रोनस मोटर।', jaEn), 'Japanese');
  assert.equal(targetByScript('Это небольшой синхронный двигатель.', jaEn), 'Japanese');
  assert.equal(targetByScript('这是一个很小的同步电动机', { ...jaEn, otherInto: 'English' }), 'English');
});

test('each of the two languages goes to the other one', () => {
  assert.equal(targetByScript('それでは会議を始めます。', jaEn), 'English');
  assert.equal(targetByScript('Let us start the meeting.', jaEn), 'Japanese');
  assert.equal(targetByScript('Kubernetes の設定を見直します', jaEn), 'English');
  const zhJa = { langA: 'Simplified Chinese', langB: 'Japanese', otherInto: 'Japanese' };
  assert.equal(targetByScript('我们这一代人要为未来思考', zhJa), 'Japanese');
  assert.equal(targetByScript('未来について考える責任があります', zhJa), 'Simplified Chinese');
  assert.equal(targetByScript('안녕하세요, 회의를 시작하겠습니다', { ...jaEn, langB: 'Korean' }), 'Japanese');
});

test('the model decides when the writing system does not settle it', () => {
  assert.equal(targetByScript('你好', jaEn), null, 'too short');
  assert.equal(targetByScript('東京都知事', jaEn), null, 'a few kanji could be Japanese');
  assert.equal(targetByScript('OK', jaEn), null);
  assert.equal(targetByScript('', jaEn), null);
  assert.equal(targetByScript('Bonjour à tous', { langA: 'English', langB: 'French', otherInto: 'English' }), null);
  assert.equal(targetByScript('会議 mtg 会議', jaEn), null, 'mixed');
  // French and English look alike; with third languages set to go into English they part ways.
  const intoEn = { ...jaEn, otherInto: 'English' };
  assert.equal(targetByScript('Bonjour à tous et bienvenue', intoEn), null);
  assert.equal(targetByScript('Bonjour à tous et bienvenue', jaEn), 'Japanese', 'either way it goes to Japanese');
  assert.equal(targetByScript('それでは会議を始めます。', intoEn), 'English', 'kana is only Japanese');
});

test('writing systems are told apart', () => {
  assert.equal(scriptClass('ひらがなとカタカナ'), 'kana');
  assert.equal(scriptClass('สวัสดีครับ ยินดีต้อนรับ'), 'thai');
  assert.equal(scriptClass('Xin chào các bạn'), 'latin');
  assert.equal(scriptClass('مرحبا بكم جميعا'), 'other');
  assert.equal(scriptClass('12345 !!!'), null);
});

test('a translation is known to be in one of the two languages when their writing systems differ', () => {
  assert.equal(languageByScript('それでは会議を始めます。', 'Japanese', 'English'), 'Japanese');
  assert.equal(languageByScript("Let's begin the meeting.", 'Japanese', 'English'), 'English');
  assert.equal(languageByScript('안녕하세요, 회의를 시작하겠습니다', 'English', 'Korean'), 'Korean');
  assert.equal(languageByScript('我们这一代人要为未来思考', 'Simplified Chinese', 'Japanese'), 'Simplified Chinese');
  assert.equal(languageByScript('未来について考える責任があります', 'Simplified Chinese', 'Japanese'), 'Japanese');
});

test('the language of a translation stays unknown when the text does not tell', () => {
  assert.equal(languageByScript('OK', 'Japanese', 'English'), null, 'too short');
  assert.equal(languageByScript('東京都知事', 'Japanese', 'English'), null, 'a few kanji');
  assert.equal(languageByScript('会議 mtg 会議', 'Japanese', 'English'), null, 'mixed');
  assert.equal(languageByScript('สวัสดีครับ ยินดีต้อนรับ', 'Japanese', 'English'), null, 'neither');
  assert.equal(languageByScript('Bonjour à tous et bienvenue', 'English', 'French'), null, 'same alphabet');
});

test('reading aloud is possible only for two languages with different writing systems', () => {
  assert.equal(scriptsDiffer('Japanese', 'English'), true);
  assert.equal(scriptsDiffer('Korean', 'Thai'), true);
  assert.equal(scriptsDiffer('English', 'French'), false);
  assert.equal(scriptsDiffer('Simplified Chinese', 'Traditional Chinese'), false);
});

const jaEnZh = ['Japanese', 'English', 'Simplified Chinese'];

test('with three languages, each is recognized by its writing system', () => {
  assert.equal(sourceByScript('それでは会議を始めます。', jaEnZh), 'Japanese');
  assert.equal(sourceByScript("Let's begin the meeting.", jaEnZh), 'English');
  assert.equal(sourceByScript('我们这一代人要为未来思考', jaEnZh), 'Simplified Chinese');
  assert.equal(sourceByScript('Kubernetes の設定を見直します', jaEnZh), 'Japanese', 'kana decides');
});

test('with three languages, speech in a fourth writing system is another language', () => {
  assert.equal(sourceByScript('और यह है छोटे सिंक्रोनस मोटर।', jaEnZh), 'other');
  assert.equal(sourceByScript('안녕하세요, 회의를 시작하겠습니다', jaEnZh), 'other');
  assert.equal(sourceByScript('مرحبا بكم جميعا', jaEnZh), 'other');
});

test('with three languages, a language written like a selected one counts as that one', () => {
  assert.equal(sourceByScript('Bonjour à tous et bienvenue', jaEnZh), 'English');
});

test('with three languages, the model is asked when the writing system does not tell', () => {
  assert.equal(sourceByScript('你好', jaEnZh), null, 'too short');
  assert.equal(sourceByScript('東京都知事', jaEnZh), null, 'a few Han characters could be Japanese');
  assert.equal(sourceByScript('会議 mtg 会議', jaEnZh), null, 'mixed');
  assert.equal(sourceByScript('', jaEnZh), null);
  const latin = ['Japanese', 'English', 'French'];
  assert.equal(sourceByScript('Bonjour à tous et bienvenue', latin), null, 'two selected languages share it');
  assert.equal(sourceByScript('それでは会議を始めます。', latin), 'Japanese');
  const han = ['English', 'Simplified Chinese', 'Traditional Chinese'];
  assert.equal(sourceByScript('我们这一代人要为未来思考', han), null);
});

test('a short Japanese interjection is still Japanese', () => {
  const jaEn = { langA: 'Japanese', langB: 'English', otherInto: 'Japanese' };
  assert.equal(targetByScript('おお。', jaEn), 'English');
  assert.equal(targetByScript('はい', jaEn), 'English');
  assert.equal(targetByScript('うん。', jaEn), 'English');
  assert.equal(targetByScript('おー。', jaEn), 'English');
  assert.equal(targetByScript('ね', jaEn), null, 'one letter is too little');
  assert.equal(targetByScript('OK', jaEn), null, 'short Latin text may be any language');
});

test('speech is translated into every selected language but its own; another language goes where the setting says', () => {
  const two = ['Japanese', 'English'];
  const three = ['Japanese', 'English', 'Korean'];
  const cases = [
    // [languages, source, otherInto, expected]
    [two, 'Japanese', 'all', ['English']],
    [two, 'English', 'all', ['Japanese']],
    [two, 'Japanese', 'B', ['English'], 'a selected language is not affected by the setting'],
    [two, 'other', 'all', ['Japanese', 'English']],
    [two, 'other', 'A', ['Japanese']],
    [two, 'other', 'B', ['English']],
    [two, 'other', 'C', ['Japanese', 'English'], 'a place with no language means all'],
    [two, 'other', undefined, ['Japanese', 'English'], 'all by default'],
    [three, 'Korean', 'all', ['Japanese', 'English']],
    [three, 'English', 'C', ['Japanese', 'Korean']],
    [three, 'other', 'all', ['Japanese', 'English', 'Korean']],
    [three, 'other', 'A', ['Japanese']],
    [three, 'other', 'B', ['English']],
    [three, 'other', 'C', ['Korean']],
  ];
  for (const [languages, source, otherInto, expected, why] of cases)
    assert.deepEqual(targetLanguages(languages, source, otherInto), expected, why ?? `${source} / ${otherInto}`);
});
