import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { UtteranceTracker } from '../../../../src/speech/segmenter.js';

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

// A talk: one speaker, few pauses, so one utterance grows for minutes. The recognizer sends the whole
// utterance so far a few characters at a time, and now and then revises words it sent long before.
function growing(text, from = 0, step = 6) {
  const events = [];
  for (let n = from + step; n < text.length; n += step) events.push(['i', text.slice(0, n)]);
  events.push(['i', text]);
  return events;
}

// Two sentences, then a run of clauses longer than a segment may grow, split at its last comma.
const TALK_JA = {
  head: [
    '本日はお集まりいただきありがとうございます。',
    '今日は事業の再編についてお話しします。',
    'まず前提として申し上げておきたいのは、この再編は数字の上では合理的に見えても、現場から見ると何が変わるのかがひじょうに分かりにくく、特に取引先にとっても説明を聞くまでは判断のしようがないという意味で、それに加えて社内の調整にもかなりの時間がかかりますし、その間に市場の状況が大きく変わってしまう可能性もあるので、効果も時期も曖昧かつリスクも高いところで、',
  ],
  next: '経営的な、その、人員の再配置だったりとか、ま、そういったような戦略的な判断になります。',
  more: 'では具体的に見ていきます。',
};
const TALK_EN = {
  head: [
    'Thank you all for coming today. ',
    'I want to talk about how we reorganize the business. ',
    'First of all, the plan looks reasonable on paper, but from the floor it is hard to see what changes, and our partners cannot judge it until it is explained, so the risk is high, ',
  ],
  next: 'the management call, you know, moving people around and that kind of strategic decision. ',
  more: 'So let us look at the details.',
};

// Speaks the head of a talk until it has been split off, revises it with `revise`, then goes on to
// the end. Returns the screen and the text of the utterance after the revision.
function talk({ head, next, more }, revise) {
  const s = screen();
  const said = head.join('');
  s.feed(growing(`${said}${next.slice(0, 8)}`));
  assert.deepEqual(
    s.texts(),
    head.map((x) => x.trim()),
    'the head is split off before the revision',
  );
  const revised = revise(said);
  assert.notEqual(revised, said);
  s.feed([['i', `${revised}${next.slice(0, 12)}`]]);
  s.feed(growing(`${revised}${next}${more}`, revised.length + 12));
  s.feed([['f', `${revised}${next}${more}`]]);
  return s;
}

const revisions = {
  'two characters shorter': [TALK_JA, (t) => t.replace('いただき', '頂き')],
  'two characters longer': [TALK_JA, (t) => t.replace('事業の再編', '事業部門の再編')],
  'a comma added': [TALK_JA, (t) => t.replace('まず前提として', 'まず、前提として')],
  'kana rewritten as kanji': [TALK_JA, (t) => t.replace('ひじょうに', '非常に')],
  'a word just before the split corrected': [TALK_JA, (t) => t.replace('曖昧かつ', 'あいまいかつ')],
  'English, two characters shorter': [TALK_EN, (t) => t.replace('want to', 'wanna')],
  'English, a word just before the split added': [TALK_EN, (t) => t.replace('explained,', 'explained to them,')],
};

for (const [name, [script, revise]] of Object.entries(revisions)) {
  test(`a talk keeps every word where it was split when earlier words are revised: ${name}`, () => {
    const s = talk(script, revise);
    assert.deepEqual(
      s.texts(),
      [...script.head, script.next, script.more].map((x) => x.trim()),
    );
    assert.equal(s.view.live, '');
  });
}

test('a talk whose split-off part is revised does not show the sentence in progress without its first words', () => {
  const s = screen();
  const said = TALK_JA.head.join('');
  s.feed(growing(`${said}経営的な、その`));
  s.feed([['i', `${said.replace('いただき', '頂き')}経営的な、その、人員の`]]);
  assert.equal(s.view.live, '経営的な、その、人員の');
});

test('when the end of the split-off part is rewritten beyond recognition, words are repeated rather than dropped', () => {
  const s = screen();
  const said = TALK_JA.head.join('');
  s.feed(growing(`${said}経営的な、その`));
  const rewritten = said.replace(
    '効果も時期も曖昧かつリスクも高いところで、',
    '効き目や時間がはっきりせず危険が大きいので、',
  );
  s.feed([['i', `${rewritten}経営的な、その、人員の`]]);
  assert.ok(s.view.live.endsWith('ので、経営的な、その、人員の'), s.view.live);
  assert.ok(s.view.live.length <= '経営的な、その、人員の'.length + 20, s.view.live); // a few words, not a sentence
});

test('a final that revises words split off long before does not repeat or drop words at the split', () => {
  const s = screen();
  const said = TALK_JA.head.join('');
  s.feed(growing(`${said}経営的な、その`));
  s.feed([['f', `${said.replace('ひじょうに', '非常に').replace('今日は', '本日は、')}${TALK_JA.next}`]]);
  assert.deepEqual(s.texts(), [...TALK_JA.head, TALK_JA.next]);
});

test('a late final that revises the start of a closed utterance corrects only its unfinished tail', () => {
  const s = screen();
  const said = TALK_JA.head.join('');
  s.feed([
    ...growing(`${said}経営的な、その`),
    ['i', '次の話題です'],
    ['f', `${said.replace('いただき', '頂き')}${TALK_JA.next}`],
  ]);
  assert.deepEqual(s.texts(), [...TALK_JA.head, TALK_JA.next]);
  assert.equal(s.view.live, '次の話題です');
});

test('a split forced in the middle of a word keeps the word when the text before it is revised', () => {
  const s = screen();
  // No sentence end, comma or space for 180 characters: the split falls inside a word.
  const run = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'.repeat(4);
  s.feed(growing(`${run}続き`));
  const [first] = s.texts();
  assert.equal(first, run.slice(0, 180));
  s.feed([
    ['i', `${run.replace('かきくけこ', '書き')}続きです`],
    ['f', `${run.replace('かきくけこ', '書き')}続きです。`],
  ]);
  assert.deepEqual(s.texts(), [run.slice(0, 180), `${run.slice(180)}続きです。`]);
});

test('a heavily revised text that is taken for a new utterance repeats rather than drops words', () => {
  const s = screen();
  s.feed([
    ...growing('今日はお集まりいただきありがとうございます。それでは始めます'),
    ['i', 'まず最初に、今日の議題を確認します'],
  ]);
  const shown = [...s.texts(), s.view.live].join('');
  assert.ok(shown.includes('それでは始めます'));
  assert.ok(shown.includes('まず最初に、今日の議題を確認します'));
});

// The recorded trace used by the tuning tools (docs/tuning.md): every utterance reaches the screen
// whole, whatever was split off while it was spoken.
test('a recorded trace loses no characters between its segments', () => {
  const trace = JSON.parse(readFileSync(new URL('../../../fixtures/replay-trace.json', import.meta.url), 'utf8'));
  const s = screen();
  const squeeze = (t) => t.replace(/\s+/g, '');
  let from = 0;
  for (const { kind, text } of trace.events) {
    s.feed([[kind === 'interim' ? 'i' : 'f', text]]);
    if (kind !== 'final') continue;
    assert.equal(squeeze(s.texts().slice(from).join('')), squeeze(text));
    from = s.texts().length;
  }
  assert.ok(from > 0);
});
