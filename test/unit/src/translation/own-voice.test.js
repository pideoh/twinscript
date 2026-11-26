import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnVoice, similarity } from '../../../../src/translation/own-voice.js';

// The module on a clock the test moves, with one sentence read from t=0 to t=3 s by default.
function setup(text = 'The budget for next quarter is still open.', lang = 'en-US', { readMs = 3000 } = {}) {
  let time = 0;
  const own = createOwnVoice({ now: () => time, lingerMs: 5000 });
  if (text) {
    own.started(text, lang);
    time = readMs;
    own.ended(text);
  }
  return { own, at: (ms) => (time = ms) };
}

test('a sentence read aloud and recognized as it was read is the app’s own voice', () => {
  const { own } = setup();
  assert.equal(own.isOwn('The budget for next quarter is still open.'), true);
});

test('differences of case, spacing, punctuation and width do not hide the app’s own voice', () => {
  const { own } = setup();
  assert.equal(own.isOwn('the budget for next quarter, is still open'), true);
  assert.equal(own.isOwn('ＴＨＥ ＢＵＤＧＥＴ ＦＯＲ ＮＥＸＴ ＱＵＡＲＴＥＲ ＩＳ ＳＴＩＬＬ ＯＰＥＮ！'), true);
  const ja = setup('明日の会議は十時からです。', 'ja-JP');
  assert.equal(ja.own.isOwn('明日の 会議は 十時から です'), true);
});

test('a few words the recognizer got wrong or left out do not hide the app’s own voice', () => {
  const { own } = setup();
  assert.equal(own.isOwn('The budget for the next quarter is still open.'), true);
  assert.equal(own.isOwn('The budget for next quarter is open.'), true);
  assert.equal(own.isOwn('The budge for next quart is still opened'), true);
});

test('a sentence read aloud that comes back in two parts is dropped part by part', () => {
  const { own } = setup('We reviewed the numbers yesterday, and the budget for next quarter is still open.');
  assert.equal(own.isOwn('We reviewed the numbers yesterday.'), true);
  assert.equal(own.isOwn('And the budget for next quarter is still open.'), true);
});

test('two sentences read one after the other that come back as one are dropped together', () => {
  let time = 0;
  const own = createOwnVoice({ now: () => time });
  own.started('明日の会議は十時からです。', 'ja-JP');
  time = 2000;
  own.ended('明日の会議は十時からです。');
  own.started('場所は三階の会議室です。', 'ja-JP');
  time = 4000;
  own.ended('場所は三階の会議室です。');
  assert.equal(own.isOwn('明日の会議は十時からです場所は三階の会議室です'), true);
});

test('the app’s own voice is recognized in Japanese, English and Chinese', () => {
  for (const [text, lang, heard] of [
    ['明日の会議は十時からです。', 'ja-JP', '明日の会議は十時からです'],
    ['We will meet at ten tomorrow morning.', 'en-US', 'We will meet at 10 tomorrow morning.'],
    ['我们明天上午在三楼会议室开会。', 'cmn-Hans-CN', '我们明天上午在三楼的会议室开会'],
  ]) {
    assert.equal(setup(text, lang).own.isOwn(heard), true, heard);
  }
});

test('a short word a person says is kept even when the sentence read aloud contains it', () => {
  const en = setup('OK, then let us start with the budget.');
  assert.equal(en.own.isOwn('OK.'), false);
  assert.equal(en.own.isOwn('Let us start.'), false);
  const ja = setup('はい、それでは予算から始めましょう。', 'ja-JP');
  assert.equal(ja.own.isOwn('はい。'), false);
});

test('a short sentence read aloud is dropped when it comes back whole, so it is not read back and forth', () => {
  const { own } = setup('Yes.', 'en-US', { readMs: 500 });
  assert.equal(own.isOwn('yes'), true);
});

test('a sentence a person says that is unlike what was read aloud is kept', () => {
  const { own } = setup();
  assert.equal(own.isOwn('The budget for the last quarter was closed.'), false);
  assert.equal(own.isOwn('Could you share the slides after the meeting?'), false);
});

test('the same sentence said by a person a minute later is kept', () => {
  const { own, at } = setup();
  at(60_000);
  assert.equal(own.isOwn('The budget for next quarter is still open.'), false);
  assert.equal(own.mayBeOwn('The budget for next'), false);
});

test('a reading counts from its start until a few seconds after its end', () => {
  const { own, at } = setup();
  at(1000); // still being read
  assert.equal(own.isOwn('The budget for next quarter is still open.'), true);
  at(3000 + 5000);
  assert.equal(own.isOwn('The budget for next quarter is still open.'), true);
  at(3000 + 5001);
  assert.equal(own.isOwn('The budget for next quarter is still open.'), false);
});

test('a reading that never reported its end is forgotten after a minute', () => {
  let time = 0;
  const own = createOwnVoice({ now: () => time, lingerMs: 5000 });
  own.started('The budget for next quarter is still open.', 'en-US');
  time = 30_000;
  assert.equal(own.isOwn('The budget for next quarter is still open.'), true);
  time = 66_000;
  assert.equal(own.isOwn('The budget for next quarter is still open.'), false);
});

test('only the last eight readings are kept', () => {
  const time = 0;
  const own = createOwnVoice({ now: () => time });
  const sentence = (i) =>
    [
      'Please send the slides before Friday.',
      'The budget for next quarter is still open.',
      'We will meet at ten tomorrow morning.',
      'Marketing wants a decision by the end of June.',
      'Our team in Osaka has finished the review.',
      'Could you share the minutes with everyone?',
      'The release has moved to the second week.',
      'Customer feedback was mostly positive overall.',
      'Let us move on to the next item on the agenda.',
    ][i];
  for (let i = 0; i < 9; i++) own.started(sentence(i), 'en-US'); // none ended yet
  assert.equal(own.isOwn(sentence(0)), false);
  assert.equal(own.isOwn(sentence(1)), true);
});

test('with nothing read aloud nothing is the app’s own voice', () => {
  const { own } = setup('');
  assert.equal(own.isOwn('The budget for next quarter is still open.'), false);
  assert.equal(own.mayBeOwn('The budget'), false);
});

test('the beginning of a sentence being read aloud may be the app’s own voice', () => {
  const { own, at } = setup();
  at(1000);
  for (const heard of ['The', 'The budget', 'The budget for next', 'budget for next quarter']) {
    assert.equal(own.mayBeOwn(heard), true, heard);
  }
  const ja = setup('明日の会議は十時からです。', 'ja-JP');
  assert.equal(ja.own.mayBeOwn('明日の'), true);
  assert.equal(ja.own.mayBeOwn('明日の会議は'), true);
});

test('a sentence in progress that grows away from what is read aloud is no longer the app’s own voice', () => {
  const { own, at } = setup();
  at(1000);
  assert.equal(own.mayBeOwn('The budget'), true);
  assert.equal(own.mayBeOwn('The budget was approved by the board last week'), false);
  assert.equal(own.mayBeOwn('Could you'), false);
});

test('an ended reading is matched by its text, the oldest unfinished one first', () => {
  let time = 0;
  const own = createOwnVoice({ now: () => time, lingerMs: 1000 });
  own.started('The budget for next quarter is still open.', 'en-US');
  own.ended('Something else entirely, never started.');
  time = 10_000;
  assert.equal(own.isOwn('The budget for next quarter is still open.'), true, 'still being read');
  own.ended('The budget for next quarter is still open.');
  time = 11_001;
  assert.equal(own.isOwn('The budget for next quarter is still open.'), false);
});

// Where the threshold (0.8) falls: what the recognizer changes on one side, what a person says
// back on the other. The score is the share of the heard text's bigrams found in what was read.
const NEAR = [
  ['The budget for next quarter is still open.', 'The budget for next quarter is open.', 0.96, true],
  ["We'll meet at ten tomorrow morning.", 'We will meet at ten tomorrow morning', 0.9, true],
  ['We will meet at ten tomorrow morning.', 'We will meet at 10 tomorrow morning', 0.89, true],
  ['The budget for next quarter is still open.', 'the budget for the next quarter is still open', 0.89, true],
  ['The budget for next quarter is still open.', 'The budge for next quart is still opened', 0.88, true],
  ['明日の会議は十時からです。', '明日の会議は十時からでした', 0.83, true],
  ['The budget for next quarter is still open.', 'Is the budget for next quarter final?', 0.83, true],
  ['今日は雨が降っています。', '今日は雨が降ってます', 0.89, true],
  ['今日は雨が降っています。', '今日は雨が振っています', 0.8, true],
  ['Let us move on to the next item on the agenda.', 'Let us move on to the next topic', 0.79, false],
  ['明日の会議は十時からです。', '明日の会議は10時からです', 0.75, false],
  ['明日の会議は十時からです。', '明日の会議は午後からです', 0.73, false],
  ['我们明天上午十点开会。', '我们明天上午10点开会', 0.7, false],
  ['Let us move on to the next item on the agenda.', 'Can we move on to the next item please', 0.69, false],
  ['明日の会議は十時からです。', '今日の会議は十時までです', 0.64, false],
  ['The budget for next quarter is still open.', 'The budget for the last quarter was closed.', 0.59, false],
  ['我们明天上午十点开会。', '我们明天下午开会吧', 0.5, false],
];

const norm = (t) =>
  t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

for (const [read, heard, score, dropped] of NEAR) {
  test(`near the threshold: "${heard}" after "${read}" is ${dropped ? 'dropped' : 'kept'} (${score})`, () => {
    assert.equal(Math.round(similarity(norm(heard), norm(read)) * 100) / 100, score);
    assert.equal(setup(read, 'und').own.isOwn(heard), dropped);
  });
}
