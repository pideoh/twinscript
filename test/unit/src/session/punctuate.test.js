import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPunctuationRequest,
  GeminiPunctuator,
  joinWords,
  MAX_CHARS_PER_MARK,
  MAX_CHARS_PER_MARK_SPACED,
  MAX_PIECE_CHARS,
  MIN_CHARS,
  pieceRanges,
  placePunctuation,
  punctuateStretches,
  tooFewMarks,
} from '../../../../src/session/punctuate.js';
import { linesFromWords, separator } from '../../../../src/session/recording-transcript.js';

// Invented speech. Japanese as the service gives it: words without spaces and, here, without marks.
const JA_SENTENCES = [
  ['今日は', '来月の', '予算について', '話します'],
  ['まず', '先週の', '数字を', '確認して', 'それから', '残りの', '項目を', '決めます'],
  ['質問が', 'あれば', '最後に', '受け付けます'],
  ['資料は', '会議の', 'あとで', '共有します'],
];
const EN_SENTENCES = [
  'we will look at the budget for next month',
  'first we check the numbers from last week and then we decide the rest',
  'questions are welcome at the end',
  'the slides will be shared after the meeting',
].map((s) => s.split(' '));

// Words of `sentences` repeated `times`, 300 ms each, one speaker; texts without punctuation.
function wordsOf(sentences, times = 1) {
  const texts = Array.from({ length: times }, () => sentences.flat()).flat();
  return texts.map((text, i) => ({ startMs: i * 300, endMs: i * 300 + 250, speaker: 's1', text }));
}
// What a careful model answers for those words.
const jaAnswer = () => `${JA_SENTENCES.map((s) => s.join('').replace('確認して', '確認して、')).join('。')}。`;
const enAnswer = () =>
  `${EN_SENTENCES.map((s) => {
    const text = s.join(' ').replace('last week and', 'last week, and');
    return text[0].toUpperCase() + text.slice(1);
  }).join('. ')}.`;

const textOf = (words) => joinWords(words, separator);

test('text with too few marks for its length needs punctuation; punctuated text does not', () => {
  const bare = (n) => 'あ'.repeat(n);
  assert.equal(tooFewMarks(bare(MIN_CHARS)), true, 'without a mark');
  assert.equal(tooFewMarks(''), false, 'nothing');
  // At one mark per MAX_CHARS_PER_MARK characters it is enough; one character more is too few.
  const chars = MAX_CHARS_PER_MARK * 4;
  const spaced = (n) => `${'あ'.repeat(n)}。`;
  assert.equal(tooFewMarks(spaced(MAX_CHARS_PER_MARK).repeat(4)), false);
  assert.equal(tooFewMarks(`${bare(chars + 1)}。、。、`), true);
  // As measured: punctuated speech has a mark every 10 to 25 characters, the bare parts every 70 to 400.
  assert.equal(tooFewMarks(`${'あ'.repeat(24)}、`.repeat(20)), false);
  assert.equal(tooFewMarks(`${'あ'.repeat(70)}、`.repeat(6)), true);
  // English, with spaces, counts the letters.
  assert.equal(tooFewMarks(textOf(wordsOf(EN_SENTENCES))), true);
  assert.equal(tooFewMarks(enAnswer()), false);
});

// Invented, correctly punctuated speech in languages written with spaces.
const EN_PARAGRAPH =
  'Thanks for joining today. I want to start with the budget for the autumn campaign, because the numbers changed last week. Marketing asked for more money for the online advertising, and finance agreed to move part of the event budget there. We still need a decision on the trade fair in October before the end of the month. Could you send me the updated figures by Friday?';
const DE_PARAGRAPH =
  'Vielen Dank, dass ihr heute dabei seid. Die Geschäftsführung hat die Quartalsergebnisse gestern im Aufsichtsrat vorgestellt. Die Personalentwicklungsabteilung möchte das Weiterbildungsprogramm im nächsten Geschäftsjahr deutlich ausbauen, aber die Finanzierungszusage steht noch aus. Wir brauchen bis Ende des Monats eine Entscheidung über die Kundenzufriedenheitsumfrage. Könnt ihr mir die aktualisierten Zahlen bis Freitag schicken?';
const withoutMarks = (text) => text.replace(/[,.!?]/g, '');

test('correctly punctuated English and German are left alone; the same speech without marks is sent', () => {
  for (const paragraph of [EN_PARAGRAPH, DE_PARAGRAPH]) {
    assert.equal(tooFewMarks(paragraph), false, paragraph.slice(0, 20));
    assert.equal(tooFewMarks(withoutMarks(paragraph)), true, paragraph.slice(0, 20));
  }
  // German has more characters per mark than the limit for text without spaces would allow.
  const letters = withoutMarks(DE_PARAGRAPH).replace(/\s/g, '').length;
  assert.ok(letters / 7 > MAX_CHARS_PER_MARK && letters / 7 < MAX_CHARS_PER_MARK_SPACED);
});

test('the Hindi sentence mark counts as punctuation and is taken from an answer', () => {
  const sentence = 'हम अगले महीने के बजट पर बात करेंगे और फिर कार्यक्रम तय करेंगे';
  assert.equal(tooFewMarks(Array(4).fill(sentence).join(' ')), true);
  assert.equal(tooFewMarks(`${Array(4).fill(sentence).join('। ')}।`), false);
  const words = sentence.split(' ').map((text, i) => ({ startMs: i, endMs: i, text }));
  const placed = placePunctuation(words, separator, `${sentence.replace('करेंगे और', 'करेंगे, और')}।`);
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['करेंगे,', 'करेंगे।']);
});

test('Thai, written without sentence punctuation, is never sent', () => {
  const thai = 'วันนี้เราจะคุยเรื่องงบประมาณของเดือนหน้า แล้วก็ตัดสินใจเรื่องตารางงาน ';
  assert.ok(thai.repeat(3).replace(/\s/g, '').length >= MIN_CHARS);
  assert.equal(tooFewMarks(thai.repeat(3)), false);
});

test('punctuation from the answer lands on the words, and Japanese lines come out as sentences', () => {
  const words = wordsOf(JA_SENTENCES);
  const placed = placePunctuation(words, separator, jaAnswer());
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['話します。', '確認して、', '決めます。', '受け付けます。', '共有します。']);
  assert.deepEqual(
    placed.map((w) => [w.startMs, w.endMs, w.speaker]),
    words.map((w) => [w.startMs, w.endMs, w.speaker]),
    'times and speaker untouched',
  );
  assert.equal(placed.find((w) => w.text === '話します。').space, false, 'no space after 。');
  assert.deepEqual(
    linesFromWords(placed).map((l) => l.text),
    [
      '今日は来月の予算について話します。',
      'まず先週の数字を確認して、それから残りの項目を決めます。',
      '質問があれば最後に受け付けます。',
      '資料は会議のあとで共有します。',
    ],
  );
});

test('English lines come out as sentences, with spaces kept', () => {
  const placed = placePunctuation(wordsOf(EN_SENTENCES), separator, enAnswer());
  assert.deepEqual(
    linesFromWords(placed).map((l) => l.text),
    [
      'we will look at the budget for next month.',
      'first we check the numbers from last week, and then we decide the rest.',
      'questions are welcome at the end.',
      'the slides will be shared after the meeting.',
    ],
    'marks are added; the words, their case included, are kept as they came',
  );
});

// Asserts that every word of `placed` is the word of `words` with at most marks appended, at the same
// times and speaker, in the same order.
function onlyMarksAppended(words, placed) {
  assert.equal(placed.length, words.length);
  placed.forEach((p, i) => {
    const w = words[i];
    assert.deepEqual([p.startMs, p.endMs, p.speaker], [w.startMs, w.endMs, w.speaker]);
    assert.equal(p.text.slice(0, w.text.length), w.text);
    assert.match(p.text.slice(w.text.length), /^[,.!?;:…、。，．！？；：।॥]*$/u);
  });
}
// The words that got marks, with them.
const gained = (words, placed) => placed.filter((p, i) => p.text !== words[i].text).map((p) => p.text);

test('a changed character loses only the mark within six characters of it; the words stay as they came', () => {
  const words = wordsOf(JA_SENTENCES);
  const placed = placePunctuation(words, separator, jaAnswer().replace('予算について', '予算につけて'));
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['確認して、', '決めます。', '受け付けます。', '共有します。']);
});

test('a dropped filler loses only the mark next to it', () => {
  const sentences = JA_SENTENCES.map((s, i) => (i === 2 ? ['えー', ...s] : s));
  const words = wordsOf(sentences);
  const placed = placePunctuation(words, separator, jaAnswer());
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['話します。', '確認して、', '受け付けます。', '共有します。']);
  assert.ok(
    placed.some((w) => w.text === 'えー'),
    'the filler is still there',
  );
});

test('a rewritten word loses only the mark next to it; the English words keep their text and case', () => {
  const words = wordsOf(EN_SENTENCES);
  const placed = placePunctuation(words, separator, enAnswer().replace('and then', 'and than'));
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['month.', 'rest.', 'end.', 'meeting.']);
  assert.deepEqual(
    linesFromWords(placed).map((l) => l.text),
    [
      'we will look at the budget for next month.',
      'first we check the numbers from last week and then we decide the rest.',
      'questions are welcome at the end.',
      'the slides will be shared after the meeting.',
    ],
  );
});

test('in English, a mark between two short ordinary words is taken when nothing near it changed', () => {
  const words = 'it is so we go now and then we stop'.split(' ').map((text, i) => ({ startMs: i, endMs: i, text }));
  const placed = placePunctuation(words, separator, 'It is so, we go now. And then we stop.');
  onlyMarksAppended(words, placed);
  assert.deepEqual(gained(words, placed), ['so,', 'now.', 'stop.']);
  assert.deepEqual(
    linesFromWords(placed).map((l) => l.text),
    ['it is so, we go now.', 'and then we stop.'],
  );
});

test('marks at the very start and end of a piece are taken', () => {
  const words = ['yes', 'we', 'agreed'].map((text, i) => ({ startMs: i, endMs: i, text }));
  const placed = placePunctuation(words, separator, 'Yes, we agreed.');
  onlyMarksAppended(words, placed);
  assert.deepEqual(
    placed.map((w) => w.text),
    ['yes,', 'we', 'agreed.'],
  );
});

test('a mark that would fall inside a word is not taken', () => {
  const words = ['今日は', '晴れです'].map((text, i) => ({ startMs: i, endMs: i, text }));
  const placed = placePunctuation(words, separator, '今日、は晴れです。');
  assert.deepEqual(
    placed.map((w) => w.text),
    ['今日は', '晴れです。'],
  );
});

test('an answer that shares too little with the words is refused whole', () => {
  const words = wordsOf(JA_SENTENCES);
  assert.equal(placePunctuation(words, separator, 'まったく関係のない別の文章です。'), null, 'unrelated');
  assert.equal(placePunctuation(words, separator, `${jaAnswer()}${'追加の文章。'.repeat(20)}`), null, 'mostly added');
  assert.equal(placePunctuation(words, separator, undefined), null, 'no answer');
});

test('punctuation already after a word is kept, and quotes or brackets are not taken', () => {
  const words = [
    { startMs: 0, endMs: 1, text: 'yes,' },
    { startMs: 1, endMs: 2, text: 'we' },
    { startMs: 2, endMs: 3, text: 'agreed' },
    { startMs: 3, endMs: 4, text: 'today' },
  ];
  const placed = placePunctuation(words, separator, 'Yes. We "agreed" today.');
  assert.deepEqual(
    placed.map((w) => w.text),
    ['yes,', 'we', 'agreed', 'today.'],
  );
});

test('a long stretch is sent in pieces cut between words, none over the limit', () => {
  const words = wordsOf(JA_SENTENCES, 40);
  const ranges = pieceRanges(words, separator);
  assert.ok(ranges.length > 1);
  assert.deepEqual(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], words.length);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1], 'consecutive, nothing lost');
  for (const [from, to] of ranges) assert.ok(textOf(words.slice(from, to)).length <= MAX_PIECE_CHARS);
});

// A punctuator that answers from `answer(text)` and records what it was asked.
function fakePunctuator(answer) {
  const asked = [];
  return {
    asked,
    punctuate: async (text, { signal } = {}) => {
      asked.push(text);
      return answer(text, signal);
    },
  };
}
// The careful answer for a Japanese text: a mark after each sentence's last word.
const jaPunctuate = (text) =>
  text.replace(/(話します|決めます|受け付けます|共有します)/g, '$1。').replace(/確認して/g, '確認して、');

test('stretches that need it are punctuated piece by piece; the others are not sent', async () => {
  const long = wordsOf(JA_SENTENCES, 40);
  const short = wordsOf(JA_SENTENCES.slice(0, 1));
  const done = wordsOf(JA_SENTENCES).map((w) => (w.text === '話します' ? { ...w, text: '話します。' } : w));
  const punctuator = fakePunctuator(jaPunctuate);
  const progress = [];
  const out = await punctuateStretches([short, long], {
    punctuator,
    separator,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(punctuator.asked.length, pieceRanges(long, separator).length);
  assert.deepEqual(progress[0], { done: 0, total: punctuator.asked.length });
  assert.deepEqual(progress.at(-1), { done: punctuator.asked.length, total: punctuator.asked.length });
  assert.deepEqual(out[0], short, 'the short stretch is left alone');
  const lines = linesFromWords(out[1]);
  assert.equal(lines.length, 40 * 4);
  assert.ok(lines.every((l) => l.text.length < 40 && l.text.endsWith('。')));
  // Nothing to send: no progress.
  const none = [];
  await punctuateStretches([done, short], { punctuator, separator, onProgress: (p) => none.push(p) });
  assert.deepEqual(none, []);
});

test('a failed request or an unrelated answer, first and second time, keeps that piece as it came; the others still change', async () => {
  const long = wordsOf(JA_SENTENCES, 20);
  let n = 0;
  const punctuator = fakePunctuator((text) => {
    n++;
    if (n === 1) throw new TypeError('Failed to fetch');
    if (n === 2) return 'まったく関係のない別の文章です。';
    if (n === 3) throw new TypeError('Failed to fetch');
    return jaPunctuate(text);
  });
  const [out] = await punctuateStretches([long], { punctuator, separator });
  const [first] = pieceRanges(long, separator);
  assert.ok(pieceRanges(long, separator).length > 2);
  assert.deepEqual(out.slice(...first), long.slice(...first));
  assert.notDeepEqual(out.slice(first[1]), long.slice(first[1]));
});

test('pieces are cut at 300 characters', () => {
  assert.equal(MAX_PIECE_CHARS, 300);
  const words = wordsOf(JA_SENTENCES, 20);
  const lengths = pieceRanges(words, separator).map(([from, to]) => textOf(words.slice(from, to)).length);
  assert.ok(lengths.every((n) => n <= 300));
  assert.ok(
    lengths.slice(0, -1).every((n) => n > 280),
    'each piece but the last is close to the limit',
  );
});

// One piece of bare Japanese (two rounds of the sentences, over MIN_CHARS) and its words.
const onePiece = () => wordsOf(JA_SENTENCES, 2);

test('a piece answered bare is asked again as two halves, once each, and their marks land on the right words', async () => {
  const words = onePiece();
  const punctuator = fakePunctuator((text, _signal) => (punctuator.asked.length === 1 ? text : jaPunctuate(text)));
  const progress = [];
  const [out] = await punctuateStretches([words], { punctuator, separator, onProgress: (p) => progress.push(p) });
  assert.equal(punctuator.asked.length, 3);
  const [whole, a, b] = punctuator.asked;
  assert.equal(a + b, whole, 'the halves are the piece, cut between words');
  assert.ok(Math.abs(a.length - b.length) < 15, 'at about half');
  onlyMarksAppended(words, out);
  const sentenceEnds = ['話します。', '確認して、', '決めます。', '受け付けます。', '共有します。'];
  assert.deepEqual(gained(words, out), [...sentenceEnds, ...sentenceEnds]);
  assert.deepEqual(progress, [
    { done: 0, total: 1 },
    { done: 1, total: 1 },
  ]);
});

test('a piece answered bare twice stays as it came, with no third request', async () => {
  const words = onePiece();
  const punctuator = fakePunctuator((text) => text);
  const [out] = await punctuateStretches([words], { punctuator, separator });
  assert.equal(punctuator.asked.length, 3);
  assert.deepEqual(out, words);
});

test('a failed second request keeps what the first answer gave for that half', async () => {
  const words = onePiece();
  const punctuator = fakePunctuator((text) => {
    const n = punctuator.asked.length;
    if (n === 1) return text.replace('話します', '話します。'); // one mark: still too few
    if (n === 2) throw new TypeError('Failed to fetch');
    return jaPunctuate(text);
  });
  const [out] = await punctuateStretches([words], { punctuator, separator });
  assert.equal(punctuator.asked.length, 3);
  onlyMarksAppended(words, out);
  assert.deepEqual(gained(words, out), [
    '話します。', // from the first answer, kept in the first half
    '話します。',
    '確認して、',
    '決めます。',
    '受け付けます。',
    '共有します。',
  ]);
  assert.ok(punctuator.asked[2].startsWith('今日は'), 'the second half begins the second round');
});

// Words of ten characters, so that pieces of MAX_PIECE_CHARS hold exactly 30 of them: `kinds` is a
// string of 'p' (a word ending in 。) and 'b' (a bare word), one letter per block of 30 words.
function blocks(kinds) {
  return Array.from(kinds).flatMap((kind, b) =>
    Array.from({ length: 30 }, (_, i) => {
      const n = b * 30 + i;
      return {
        startMs: n * 300,
        endMs: n * 300 + 250,
        speaker: 's1',
        text: kind === 'p' ? 'あいうえおかきくけ。' : 'あいうえおかきくけこ',
      };
    }),
  );
}
// The careful answer for such words: a full stop after each bare word.
const blockPunctuate = (text) => text.replaceAll('こ', 'こ。');

test('a bare piece inside a stretch punctuated well overall is the only piece sent', async () => {
  const words = blocks('pppbppp');
  assert.equal(tooFewMarks(textOf(words)), false, 'enough marks overall');
  assert.deepEqual(
    pieceRanges(words, separator).map(([from]) => from),
    [0, 30, 60, 90, 120, 150, 180],
  );
  const punctuator = fakePunctuator(blockPunctuate);
  const progress = [];
  const [out] = await punctuateStretches([words], { punctuator, separator, onProgress: (p) => progress.push(p) });
  assert.deepEqual(punctuator.asked, [textOf(words.slice(90, 120))]);
  assert.ok(out.slice(90, 120).every((w) => w.text.endsWith('。')));
  assert.deepEqual(progress.at(-1), { done: 1, total: 1 });
});

test('a punctuated piece inside a sparse stretch is not sent', async () => {
  const words = blocks('bbbpbbb');
  assert.equal(tooFewMarks(textOf(words)), true, 'too few marks overall');
  const punctuator = fakePunctuator(blockPunctuate);
  await punctuateStretches([words], { punctuator, separator });
  assert.equal(punctuator.asked.length, 6);
  assert.ok(!punctuator.asked.includes(textOf(words.slice(90, 120))));
});

test('a first answer that punctuates only the first half asks again for the second half only', async () => {
  const words = blocks('b');
  const punctuator = fakePunctuator((text) =>
    punctuator.asked.length === 1 ? words.map((w, i) => w.text + (i < 15 ? '。' : '')).join('') : blockPunctuate(text),
  );
  const [out] = await punctuateStretches([words], { punctuator, separator });
  assert.deepEqual(punctuator.asked, [textOf(words), textOf(words.slice(15))]);
  assert.ok(out.every((w) => w.text.endsWith('。')));
});

test('progress counts pieces of the first pass and never passes its total', async () => {
  const long = wordsOf(JA_SENTENCES, 20);
  const punctuator = fakePunctuator((text) => text); // every piece bare: every piece asked again
  const progress = [];
  await punctuateStretches([long], { punctuator, separator, onProgress: (p) => progress.push(p) });
  const total = pieceRanges(long, separator).length;
  assert.equal(punctuator.asked.length, total * 3);
  assert.ok(progress.every((p) => p.total === total && p.done <= total));
  assert.deepEqual(progress.at(-1), { done: total, total });
});

test('cancelling rejects instead of keeping the words, in the first pass or the second', async () => {
  for (const at of [1, 2]) {
    const controller = new AbortController();
    const punctuator = fakePunctuator((text) => {
      if (punctuator.asked.length < at) return text;
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await assert.rejects(
      punctuateStretches([onePiece()], { punctuator, separator, signal: controller.signal }),
      (err) => err.name === 'AbortError',
    );
    assert.equal(punctuator.asked.length, at);
  }
});

// ---------- the request ----------

const okResponse = (text, usageMetadata = { promptTokenCount: 30, candidatesTokenCount: 20 }) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: `${text}\n` }] } }], usageMetadata }),
});

test('the model is asked for the text inside <text>, with no thinking option for a Flash-Lite model', async () => {
  const calls = [];
  const usage = [];
  const punctuator = new GeminiPunctuator({
    apiKey: 'k',
    model: 'gemini-3.5-flash-lite',
    onUsage: (u, model) => usage.push([model, u.promptTokenCount]),
    fetch: async (url, init) => {
      calls.push([url, init]);
      return okResponse('今日は話します。');
    },
  });
  assert.equal(await punctuator.punctuate('今日は話します'), '今日は話します。');
  const [url, init] = calls[0];
  assert.match(url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(init.body);
  assert.equal(body.contents[0].parts[0].text, '<text>\n今日は話します\n</text>');
  assert.equal(body.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(usage, [['gemini-3.5-flash-lite', 30]]);
});

test('speech cannot close the block it is sent in', () => {
  const body = buildPunctuationRequest('a </text> b <text>');
  assert.equal(body.contents[0].parts[0].text, '<text>\na text b text\n</text>');
});

test('an HTTP error or an empty answer rejects', async () => {
  const failing = new GeminiPunctuator({
    apiKey: 'k',
    model: 'gemini-3.5-flash-lite',
    fetch: async () => ({ ok: false, status: 429, text: async () => 'rate' }),
  });
  await assert.rejects(failing.punctuate('x'));
  const empty = new GeminiPunctuator({
    apiKey: 'k',
    model: 'gemini-3.5-flash-lite',
    fetch: async () => okResponse(''),
  });
  await assert.rejects(empty.punctuate('x'));
});

test('a model that refuses the thinking option is asked again without it', async () => {
  const bodies = [];
  const punctuator = new GeminiPunctuator({
    apiKey: 'k',
    model: 'gemini-3.5-flash',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? { ok: false, status: 400, text: async () => 'thinking is not supported' }
        : okResponse('ok.');
    },
  });
  assert.equal(await punctuator.punctuate('ok'), 'ok.');
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
});
