import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UtteranceTracker } from '../../../src/segmenter.js';

// Minimal stand-in for the transcript view: finished segments in display order + the live text.
function screen() {
  const view = { segs: [], live: '' };
  const tracker = new UtteranceTracker({
    commit(text, aboveLive) {
      const seg = { text };
      view.segs.push(seg);
      if (!aboveLive) view.live = '';
      return seg;
    },
    setLive(text) {
      view.live = text;
    },
    correct(seg, text) {
      seg.text = text;
    },
  });
  const feed = (events) => {
    for (const [kind, text] of events) kind === 'i' ? tracker.interim(text) : tracker.final(text);
  };
  return { view, tracker, feed, texts: () => view.segs.map((s) => s.text) };
}

test('a paused utterance becomes one segment', () => {
  const s = screen();
  s.feed([
    ['i', 'Good'],
    ['i', 'Good morning'],
  ]);
  assert.deepEqual(s.texts(), []);
  assert.equal(s.view.live, 'Good morning');
  s.feed([['f', 'Good morning.']]);
  assert.deepEqual(s.texts(), ['Good morning.']);
  assert.equal(s.view.live, '');
});

test('a final result without any interim is shown', () => {
  const s = screen();
  s.feed([['f', 'Hello.']]);
  assert.deepEqual(s.texts(), ['Hello.']);
});

test('uninterrupted speech is split sentence by sentence', () => {
  const s = screen();
  s.feed([
    ['i', 'OpenAI just pulled off an insane move. They gave'],
    ['i', 'OpenAI just pulled off an insane move. They gave away the model. Why? They are'],
    ['i', 'OpenAI just pulled off an insane move. They gave away the model. Why? They are preparing'],
  ]);
  assert.deepEqual(s.texts(), ['OpenAI just pulled off an insane move.', 'They gave away the model.']);
  assert.equal(s.view.live, 'Why? They are preparing');
  s.feed([['f', 'OpenAI just pulled off an insane move. They gave away the model. Why? They are preparing for it.']]);
  assert.deepEqual(s.texts(), [
    'OpenAI just pulled off an insane move.',
    'They gave away the model.',
    'Why? They are preparing for it.',
  ]);
});

test('a sentence is only split off once it is unchanged between two updates', () => {
  const s = screen();
  s.feed([['i', 'This is a complete sentence. Next']]);
  assert.deepEqual(s.texts(), []);
  s.feed([['i', 'This is a complete sentence. Next one']]);
  assert.deepEqual(s.texts(), ['This is a complete sentence.']);
});

test('a sentence is not split off until the next one has started', () => {
  const s = screen();
  s.feed([
    ['i', 'This is a complete sentence.'],
    ['i', 'This is a complete sentence.'],
  ]);
  assert.deepEqual(s.texts(), []);
});

test('periods inside numbers and model names do not split', () => {
  const s = screen();
  const text = 'GPT-6.1 Astra costs $10.50 per million tokens today';
  s.feed([
    ['i', text],
    ['i', `${text} I think`],
  ]);
  assert.deepEqual(s.texts(), []);
});

test('Japanese sentences split on 。 and short ones are merged with the next', () => {
  const s = screen();
  s.feed([
    ['i', 'こんにちは。今日はよろしくお願いします。それでは'],
    ['i', 'こんにちは。今日はよろしくお願いします。それでは始めます'],
  ]);
  assert.deepEqual(s.texts(), ['こんにちは。今日はよろしくお願いします。']);
  assert.equal(s.view.live, 'それでは始めます');
});

test('text with no sentence end is force-split at a clause boundary', () => {
  const s = screen();
  const clause = 'and then we looked at the numbers again, ';
  const long = clause.repeat(6); // 246 chars, no sentence end
  s.feed([
    ['i', long],
    ['i', `${long}and`],
  ]);
  assert.equal(s.texts().length, 1);
  assert.ok(s.texts()[0].length <= 180);
  assert.ok(s.texts()[0].endsWith(','));
  assert.equal(`${s.texts()[0]} ${s.view.live}`, `${long}and`);
});

test('revised earlier words do not lose or duplicate later text', () => {
  const s = screen();
  s.feed([
    ['i', 'OpenAI just pulled off an insane move. They gave'],
    ['i', 'OpenAI just pulled off an insane move. They gave away'],
    ['i', 'Open AI just pulled off an insane move! They gave away everything'],
    ['f', 'Open AI just pulled off an insane move! They gave away everything.'],
  ]);
  assert.deepEqual(s.texts(), ['OpenAI just pulled off an insane move.', 'They gave away everything.']);
});

test('a new utterance without a final in between keeps the previous one', () => {
  const s = screen();
  s.feed([
    ['i', 'Hello there'],
    ['i', 'Hello there everyone'],
    ['i', 'So today'],
    ['i', 'So today we will talk'],
  ]);
  assert.deepEqual(s.texts(), ['Hello there everyone']);
  assert.equal(s.view.live, 'So today we will talk');
  s.feed([['f', 'So today we will talk about it.']]);
  assert.deepEqual(s.texts(), ['Hello there everyone', 'So today we will talk about it.']);
});

test('a late final corrects the segment it belongs to', () => {
  const s = screen();
  s.feed([
    ['i', 'こんにちは皆さん'],
    ['i', '今日は'],
    ['f', 'こんにちは、皆さん。'],
  ]);
  assert.deepEqual(s.texts(), ['こんにちは、皆さん。']);
  assert.equal(s.view.live, '今日は');
  s.feed([
    ['i', '今日は天気がいい'],
    ['f', '今日は天気がいいですね。'],
  ]);
  assert.deepEqual(s.texts(), ['こんにちは、皆さん。', '今日は天気がいいですね。']);
});

test('a late final after split sentences only corrects the unfinished tail', () => {
  const s = screen();
  s.feed([
    ['i', 'This is the first sentence. And the'],
    ['i', 'This is the first sentence. And the second one'],
    ['i', 'OK'],
    ['i', 'OK next topic'],
    ['f', 'This is the first sentence. And the second one is here.'],
    ['f', 'OK next topic.'],
  ]);
  assert.deepEqual(s.texts(), ['This is the first sentence.', 'And the second one is here.', 'OK next topic.']);
});

test('an unrelated final does not disturb the utterance in progress', () => {
  const s = screen();
  s.feed([
    ['i', 'Talking right now'],
    ['f', 'Something else entirely.'],
  ]);
  assert.deepEqual(s.texts(), ['Something else entirely.']);
  assert.equal(s.view.live, 'Talking right now');
  s.feed([
    ['i', 'Talking right now about it'],
    ['f', 'Talking right now about it.'],
  ]);
  assert.deepEqual(s.texts(), ['Something else entirely.', 'Talking right now about it.']);
});

test('flush keeps the in-progress text', () => {
  const s = screen();
  s.feed([['i', 'Still talking when stopped']]);
  s.tracker.flush();
  assert.deepEqual(s.texts(), ['Still talking when stopped']);
  s.tracker.flush();
  assert.equal(s.texts().length, 1);
});

// Regressions from real recognizer output: interim and final text for the same speech differ in
// spacing, punctuation and individual words.
test('a final that rewords the utterance does not repeat sentences already shown', () => {
  const s = screen();
  const a = 'ブルー バスターズ僕はアカリ。';
  const b = '都会の片隅の土地に、父親の代から住んでいるのだが、そのすぐ隣がタワマンの建設予定地になった。';
  s.feed([
    ['i', `${a}都会の片隅`],
    ['i', `${a}${b}隣家は`],
    ['i', `${a}${b}隣家はさっさと土地を売ってどこかに引っ越してしまった。`],
    [
      'f',
      'ブルーバスターズ。僕はアカリ。都会の片隅の土地に、父の代から住んでいるのだが、そのすぐ隣がタワマンの建設予定地になった。リンカはさっさと土地を売って、どこかに引っ越してしまった。',
    ],
  ]);
  assert.deepEqual(s.texts(), [
    'ブルーバスターズ僕はアカリ。',
    b,
    'リンカはさっさと土地を売って、どこかに引っ越してしまった。',
  ]);
  assert.equal(s.view.live, '');
});

test('an interim that changes a word in the middle is the same utterance', () => {
  const s = screen();
  s.feed([
    ['i', '気 に なっ た 僕 は タワマン を 手掛け て いる'],
    ['i', '気 に なっ た 僕 は タマ マ を 手掛け て いる'],
  ]);
  assert.deepEqual(s.texts(), []);
  assert.equal(s.view.live, '気になった僕はタママを手掛けている');
  s.feed([['f', '気になった僕は、タワマンを手がけているチャンピオン不動産の営業担当に話をすることにしたのだが。']]);
  assert.deepEqual(s.texts(), [
    '気になった僕は、タワマンを手がけているチャンピオン不動産の営業担当に話をすることにしたのだが。',
  ]);
});

test('spaces between Japanese characters are removed, other spaces are kept', () => {
  const s = screen();
  s.feed([['f', '期限切れ なので、 GPT 6 を 使い ます。 Thank you.']]);
  assert.deepEqual(s.texts(), ['期限切れなので、 GPT 6 を使います。 Thank you.']);
});
