// The demo's stand-ins: with Chinese selected one line is spoken in Chinese and translated like the
// others; questions are answered from the demo transcript, citing its times, and can be cancelled
// like the real request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAsker, MockTranscriber, MockTranslator } from '../../../../src/debug/mock.js';
import { citedTimes } from '../../../../src/session/ask.js';

// The whole speech of the demo recognizer, which it sends as one long utterance.
const demoSpeech = (languages) => new MockTranscriber({ languages }).speech().join(' ');

test('with Chinese among the languages, the demo meeting has a line spoken in each of the three', () => {
  const speech = demoSpeech(['Japanese', 'English', 'Simplified Chinese']);
  assert.match(speech, /^それでは本日の定例会議を始めます。/);
  assert.match(speech, /Sure\. We finished the API integration/);
  assert.match(speech, / 负载测试的结果大概什么时候能出来？ /);
  assert.doesNotMatch(speech, /負荷テストの結果/);
});

test('with two languages, the demo meeting is in Japanese and English only', () => {
  const speech = demoSpeech(['Japanese', 'English']);
  assert.match(speech, /負荷テストの結果はいつ頃出そうですか？/);
  assert.doesNotMatch(speech, /\p{Script=Han}{2}的/u);
});

test('the demo translates a line spoken in Chinese into each language asked for', async () => {
  const translator = new MockTranslator();
  const zh = '负载测试的结果大概什么时候能出来？';
  assert.equal(await translator.translate(zh, { into: 'Japanese' }), '負荷テストの結果はいつ頃出そうですか？');
  assert.equal(await translator.translate(zh, { into: 'English' }), 'When do you expect the load test results?');
  assert.equal(
    await translator.translate('We should have the full report by Wednesday.', { into: 'Simplified Chinese' }),
    '我们应该能在周三之前拿出完整的报告。',
  );
  assert.equal(
    await translator.translate('それでは本日の定例会議を始めます。'),
    "Let's begin today's regular meeting.",
    'with two languages, as before',
  );
});

const demoLines = [
  { elapsed: 2000, src: 'それでは本日の定例会議を始めます。', tgt: "Let's begin today's regular meeting." },
  { elapsed: 9000, src: 'We finished the API integration and started load testing on Friday.', tgt: '負荷テスト' },
  { elapsed: 15000, src: 'We should have the full report by Wednesday.', tgt: '水曜日までに' },
];

test('the demo answers from the transcript and cites the times of the lines it relies on', async () => {
  const usage = [];
  const asker = new MockAsker({ model: 'gemini-x', onUsage: (_usage, model) => usage.push(model) });
  const deltas = [];
  const result = await asker.ask({
    segments: demoLines,
    question: '  How is load testing going? ',
    onDelta: (t) => deltas.push(t),
  });
  assert.deepEqual(
    citedTimes(result.answer).map((x) => x.text),
    ['00:00:09', '00:00:15'],
  );
  assert.equal(result.question, 'How is load testing going?');
  assert.equal(result.truncated, false);
  assert.equal(deltas.at(-1), result.answer, 'streamed in pieces up to the whole answer');
  assert.ok(deltas.length > 1);
  assert.deepEqual(usage, ['gemini-x'], 'usage is told once, through onUsage');
  assert.equal(result.usage, null);
});

test('a question about the report gets the line about the report only', async () => {
  const { answer } = await new MockAsker().ask({ segments: demoLines, question: 'When is the report due?' });
  assert.deepEqual(
    citedTimes(answer).map((x) => x.text),
    ['00:00:15'],
  );
  assert.match(answer, /Wednesday/);
  assert.doesNotMatch(answer, /Friday/);
});

test('a question in Japanese gets a Japanese answer', async () => {
  const { answer } = await new MockAsker().ask({ segments: demoLines, question: '負荷テストはどうなっていますか？' });
  assert.match(answer, /負荷テスト/);
});

test('a transcript without those lines gets "the meeting does not say", with no time', async () => {
  const { answer } = await new MockAsker().ask({ segments: [{ elapsed: 0, src: 'Hello.' }], question: 'Anything?' });
  assert.equal(citedTimes(answer).length, 0);
  assert.match(answer, /does not say/);
});

test('a cancelled demo answer stops', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new MockAsker().ask({ segments: demoLines, question: 'Status?', signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});
