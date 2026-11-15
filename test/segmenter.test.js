import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceTracker } from '../src/segmenter.js';

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
    setLive(text) { view.live = text; },
    correct(seg, text) { seg.text = text; },
  });
  const feed = (events) => {
    for (const [kind, text] of events) (kind === 'i' ? tracker.interim(text) : tracker.final(text));
  };
  return { view, tracker, feed, texts: () => view.segs.map((s) => s.text) };
}

test('a paused utterance becomes one segment', () => {
  const s = screen();
  s.feed([['i', 'Good'], ['i', 'Good morning']]);
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
  s.feed([['i', 'This is a complete sentence.'], ['i', 'This is a complete sentence.']]);
  assert.deepEqual(s.texts(), []);
});

test('periods inside numbers and model names do not split', () => {
  const s = screen();
  const text = 'GPT-6.1 Astra costs $10.50 per million tokens today';
  s.feed([['i', text], ['i', `${text} I think`]]);
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
  s.feed([['i', long], ['i', `${long}and`]]);
  assert.equal(s.texts().length, 1);
  assert.ok(s.texts()[0].length <= 180);
  assert.ok(s.texts()[0].endsWith(','));
  assert.equal(s.texts()[0] + ' ' + s.view.live, `${long}and`);
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
  s.feed([['i', 'Hello there'], ['i', 'Hello there everyone'], ['i', 'So today'], ['i', 'So today we will talk']]);
  assert.deepEqual(s.texts(), ['Hello there everyone']);
  assert.equal(s.view.live, 'So today we will talk');
  s.feed([['f', 'So today we will talk about it.']]);
  assert.deepEqual(s.texts(), ['Hello there everyone', 'So today we will talk about it.']);
});

test('a late final corrects the segment it belongs to', () => {
  const s = screen();
  s.feed([['i', 'こんにちは皆さん'], ['i', '今日は'], ['f', 'こんにちは、皆さん。']]);
  assert.deepEqual(s.texts(), ['こんにちは、皆さん。']);
  assert.equal(s.view.live, '今日は');
  s.feed([['i', '今日は天気がいい'], ['f', '今日は天気がいいですね。']]);
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
  s.feed([['i', 'Talking right now'], ['f', 'Something else entirely.']]);
  assert.deepEqual(s.texts(), ['Something else entirely.']);
  assert.equal(s.view.live, 'Talking right now');
  s.feed([['i', 'Talking right now about it'], ['f', 'Talking right now about it.']]);
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
