import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptClass, targetByScript } from '../src/script-hint.js';

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
});

test('writing systems are told apart', () => {
  assert.equal(scriptClass('ひらがなとカタカナ'), 'kana');
  assert.equal(scriptClass('สวัสดีครับ ยินดีต้อนรับ'), 'thai');
  assert.equal(scriptClass('Xin chào các bạn'), 'latin');
  assert.equal(scriptClass('مرحبا بكم جميعا'), 'other');
  assert.equal(scriptClass('12345 !!!'), null);
});
