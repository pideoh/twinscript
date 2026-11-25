import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualClock } from '../../../../scripts/tuning/clock.mjs';
import {
  chunkTrigger,
  createPacer,
  DEFAULT_STRATEGY,
  growthFor,
  sameText,
  strategyNamed,
} from '../../../../src/translation/pacer.js';
import { RateLimitError } from '../../../../src/translation/translator.js';

// A pacer on a simulated clock whose translator answers after `latency` ms (or with `reply`).
// Each request keeps its context and what context.previous() said when it was sent.
// The strategy defaults to 'interval', the plain rule the other strategies are compared with.
function setup({ strategy = 'interval', latency = 300, reply, options = { interval: 1.5 } } = {}) {
  const clock = createVirtualClock(10_000);
  const sent = [];
  const shown = [];
  const limits = [];
  const pacer = createPacer({
    strategy,
    options,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    translate: (text, context) => {
      sent.push({ at: clock.now(), text, context, previous: context.previous?.() });
      return new Promise((resolve, reject) =>
        clock.setTimer(() => {
          const out = reply ? reply(text) : `[t] ${text}`;
          if (out instanceof Error) reject(out);
          else resolve(out);
        }, latency),
      );
    },
    show: (out, state) => shown.push({ at: clock.now(), out, state }),
    onRateLimit: (err) => limits.push(err),
  });
  return { clock, pacer, sent, shown, limits };
}

test('the sentence being spoken is translated at once, then at most every interval while it grows', async () => {
  const { clock, pacer, sent } = setup({ latency: 100 });
  pacer.update('こんにちは');
  await clock.advance(0);
  assert.deepEqual(
    sent.map((x) => [x.at, x.text]),
    [[10_000, 'こんにちは']],
  );
  for (let i = 1; i <= 10; i++) {
    await clock.advance(200);
    pacer.update(`こんにちは${'あ'.repeat(i)}`);
  }
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => x.at - 10_000),
    [0, 1500, 3000],
    'each request waits for the interval, and carries the text as it is then',
  );
  assert.equal(sent[1].text, 'こんにちはあああああああ');
  assert.equal(sent[2].text, 'こんにちはああああああああああ');
});

test('updates with nothing new after the last request send nothing more', async () => {
  const { clock, pacer, sent, shown } = setup();
  pacer.update('Good morning');
  await clock.runAll();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    shown.map((x) => x.out),
    ['[t] Good morning'],
  );
  assert.equal(shown[0].state.text, 'Good morning');
});

test('requests never overlap, and a change during a request brings one more', async () => {
  const { clock, pacer, sent, shown } = setup({ latency: 4000 });
  pacer.update('Hello there');
  await clock.advance(0);
  await clock.advance(2000);
  pacer.update('Hello there my');
  await clock.advance(1000);
  pacer.update('Hello there my friend');
  assert.equal(sent.length, 1, 'no second request while the first is on its way');
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => [x.at - 10_000, x.text]),
    [
      [0, 'Hello there'],
      [4000, 'Hello there my friend'],
    ],
    'the follow-up goes out as soon as the first answer is in, since the interval has passed',
  );
  assert.deepEqual(
    shown.map((x) => x.out),
    ['[t] Hello there', '[t] Hello there my friend'],
  );
});

test('the follow-up still keeps to the interval after a quick answer', async () => {
  const { clock, pacer, sent } = setup({ latency: 200 });
  pacer.update('Hello there');
  await clock.advance(100);
  pacer.update('Hello there my');
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => x.at - 10_000),
    [0, 1500],
  );
});

test('text shorter than four characters is not sent', async () => {
  const { clock, pacer, sent } = setup();
  pacer.update('えー');
  await clock.runAll();
  assert.equal(sent.length, 0);
  pacer.update('えーと、');
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => x.text),
    ['えーと、'],
  );
});

test('after a rate-limit error nothing is sent for a minute', async () => {
  let limited = true;
  const { clock, pacer, sent, limits } = setup({
    reply: (text) => (limited ? new RateLimitError('error.rateLimit') : `[t] ${text}`),
  });
  pacer.update('First sentence');
  await clock.runAll();
  assert.equal(limits.length, 1, 'the caller is told');
  limited = false;
  for (let i = 0; i < 59; i++) {
    await clock.advance(1000);
    pacer.update(`First sentence ${i}`);
  }
  await clock.runAll();
  assert.equal(sent.length, 1, 'nothing during the pause');
  await clock.advance(1000);
  pacer.update('First sentence again');
  await clock.runAll();
  assert.equal(sent.length, 2, 'requests resume once the minute is over');
});

test('other errors are swallowed and do not pause', async () => {
  const { clock, pacer, sent, shown, limits } = setup({ reply: () => new Error('network') });
  pacer.update('Some words');
  await clock.runAll();
  await clock.advance(2000);
  pacer.update('Some words more');
  await clock.runAll();
  assert.equal(sent.length, 2);
  assert.equal(shown.length, 0);
  assert.equal(limits.length, 0);
});

test('a translation that arrives after the sentence was finished or dropped is not shown', async () => {
  for (const end of ['finish', 'cancel']) {
    const { clock, pacer, sent, shown } = setup({ latency: 1000 });
    pacer.update('A sentence in progress');
    await clock.advance(500);
    assert.equal(sent[0].context.isCurrent(), true);
    pacer[end]();
    assert.equal(sent[0].context.isCurrent(), false, end);
    await clock.runAll();
    assert.equal(shown.length, 0, end);
  }
});

test('cancel stops a request that is waiting for the interval', async () => {
  const { clock, pacer, sent } = setup();
  pacer.update('First words');
  await clock.runAll();
  pacer.update('First words and more');
  pacer.cancel();
  await clock.runAll();
  assert.equal(sent.length, 1);
});

test('the interval is kept across sentences, and the next sentence waits for a request in flight', async () => {
  const { clock, pacer, sent } = setup({ latency: 3000 });
  pacer.update('First sentence');
  await clock.advance(1000);
  pacer.finish();
  pacer.update('Second one');
  await clock.advance(2500);
  assert.equal(sent.length, 1, 'the first request is still on its way');
  pacer.update('Second one grows');
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => [x.at - 10_000, x.text]),
    [
      [0, 'First sentence'],
      [3500, 'Second one grows'],
    ],
  );
});

test('interval and on/off can be read from live settings', async () => {
  const settings = { on: false, interval: 3 };
  const { clock, pacer, sent } = setup({
    latency: 10,
    options: { enabled: () => settings.on, interval: () => settings.interval },
  });
  pacer.update('Switched off');
  await clock.runAll();
  assert.equal(sent.length, 0);
  settings.on = true;
  pacer.update('Switched on now');
  await clock.advance(100);
  pacer.update('Switched on now again');
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => x.at - 10_000),
    [0, 3000],
  );
});

test('an unknown strategy is refused', () => {
  assert.throws(() => createPacer({ strategy: 'nope', translate() {}, show() {} }), /nope/);
});

// ---------- steady, carry, chunk ----------

const rel = (sent) => sent.map((x) => [x.at - 10_000, x.text]);

test('the app continues the shown translation and settles finished sentences (settle) unless told otherwise', () => {
  assert.equal(DEFAULT_STRATEGY, 'settle');
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(strategyNamed(null, warn), 'settle');
  assert.equal(strategyNamed('', warn), 'settle');
  for (const name of ['interval', 'steady', 'carry', 'chunk']) assert.equal(strategyNamed(name, warn), name);
  assert.deepEqual(warnings, []);
  assert.equal(strategyNamed('fastest', warn), 'settle');
  assert.equal(strategyNamed('toString', warn), 'settle');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /fastest/);
});

for (const strategy of ['steady', 'carry']) {
  test(`${strategy}: the sentence being spoken is translated at once, then at most every interval while it grows`, async () => {
    const { clock, pacer, sent } = setup({ strategy, latency: 100 });
    pacer.update('こんにちは');
    await clock.advance(0);
    for (let i = 1; i <= 10; i++) {
      await clock.advance(200);
      pacer.update(`こんにちは${'あ'.repeat(i)}`);
    }
    await clock.runAll();
    assert.deepEqual(
      sent.map((x) => x.at - 10_000),
      [0, 1500, 3000],
    );
  });
}

for (const strategy of ['steady', 'carry', 'chunk']) {
  test(`${strategy}: a request still on its way for a finished sentence does not hold up the next one`, async () => {
    const { clock, pacer, sent, shown } = setup({ strategy, latency: 3000 });
    pacer.update('First sentence, spoken');
    await clock.advance(1000);
    pacer.finish();
    pacer.update('Second one, now');
    await clock.advance(0);
    assert.deepEqual(rel(sent), [
      [0, 'First sentence, spoken'],
      [1000, 'Second one, now'],
    ]);
    await clock.runAll();
    assert.deepEqual(
      shown.map((x) => x.out),
      ['[t] Second one, now'],
      'the answer for the finished sentence is not shown',
    );
  });

  test(`${strategy}: a new sentence does not wait for the interval left from the one before`, async () => {
    const { clock, pacer, sent } = setup({ strategy, latency: 100 });
    pacer.update('First sentence, spoken');
    await clock.advance(500);
    pacer.finish();
    pacer.update('Second one, now');
    await clock.runAll();
    assert.deepEqual(
      sent.map((x) => x.at - 10_000),
      [0, 500],
    );
  });

  test(`${strategy}: text that was already sent for the sentence is not sent again`, async () => {
    const { clock, pacer, sent } = setup({ strategy, latency: 100 });
    pacer.update('Hello there, friend');
    await clock.advance(200);
    pacer.update('Hello there, friend of');
    await clock.advance(100);
    pacer.update('Hello there, friend');
    await clock.runAll();
    assert.deepEqual(
      sent.map((x) => x.text),
      ['Hello there, friend'],
    );
    pacer.update('Hello there, friend');
    await clock.runAll();
    assert.equal(sent.length, 1);
  });

  test(`${strategy}: the rate-limit pause, minimum length and cancel work as with interval`, async () => {
    let limited = true;
    const { clock, pacer, sent, limits } = setup({
      strategy,
      reply: (text) => (limited ? new RateLimitError('error.rateLimit') : `[t] ${text}`),
    });
    pacer.update('えー');
    await clock.runAll();
    assert.equal(sent.length, 0, 'too short');
    pacer.update('First sentence, here');
    await clock.runAll();
    assert.equal(limits.length, 1);
    limited = false;
    pacer.finish();
    await clock.advance(30_000);
    pacer.update('Another sentence, here');
    await clock.runAll();
    assert.equal(sent.length, 1, 'nothing during the pause, even for a new sentence');
    await clock.advance(30_000);
    pacer.update('Another sentence, here and');
    pacer.cancel();
    await clock.runAll();
    assert.equal(sent.length, 1, 'cancel drops the waiting request');
    pacer.update('A third sentence, now');
    await clock.runAll();
    assert.equal(sent.length, 2, 'requests resume once the minute is over');
  });
}

test('steady passes no previous translation, and its finish hands nothing over', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'steady' });
  pacer.update('Good morning');
  await clock.advance(2000);
  pacer.update('Good morning everyone');
  await clock.runAll();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].context.previous, undefined);
  assert.equal(pacer.finish(), undefined);
});

for (const strategy of ['carry', 'chunk']) {
  test(`${strategy}: each request passes what is shown for the sentence, and the final translation gets the last of it`, async () => {
    const { clock, pacer, sent } = setup({ strategy, latency: 100, options: { interval: 1.5, minGap: 1.5 } });
    pacer.update('Good morning,');
    await clock.advance(2000);
    pacer.update('Good morning, everyone,');
    await clock.advance(2000);
    pacer.update('Good morning, everyone, and welcome,');
    await clock.runAll();
    assert.deepEqual(
      sent.map((x) => x.previous),
      [undefined, '[t] Good morning,', '[t] Good morning, everyone,'],
    );
    const previous = pacer.finish();
    assert.equal(previous(), '[t] Good morning, everyone, and welcome,');

    pacer.update('Next sentence,');
    await clock.runAll();
    assert.equal(sent.at(-1).previous, undefined, 'a new sentence starts with nothing shown');
    assert.equal(previous(), '[t] Good morning, everyone, and welcome,', 'what was handed over stays');
  });

  test(`${strategy}: with one line per target, each line continues its own translation`, async () => {
    const clock = createVirtualClock(10_000);
    const sent = [];
    const pacer = createPacer({
      strategy,
      options: { interval: 1.5, minGap: 1.5 },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      // As the app does for several targets: one request per line, each line shown by the caller.
      translate: async (text, context) => {
        sent.push({ text, en: context.previous('en'), fr: context.previous('fr'), single: context.previous() });
        await new Promise((resolve) => clock.setTimer(resolve, 100));
        for (const code of ['en', 'fr']) context.keep(code, `[${code}] ${text}`);
      },
      show: () => assert.fail('nothing for the pacer to show'),
    });
    pacer.update('Hola a todos,');
    await clock.advance(2000);
    pacer.update('Hola a todos, buenos días,');
    await clock.runAll();
    assert.deepEqual(sent, [
      { text: 'Hola a todos,', en: undefined, fr: undefined, single: undefined },
      { text: 'Hola a todos, buenos días,', en: '[en] Hola a todos,', fr: '[fr] Hola a todos,', single: undefined },
    ]);
    const previous = pacer.finish();
    assert.equal(previous('en'), '[en] Hola a todos, buenos días,');
    assert.equal(previous('fr'), '[fr] Hola a todos, buenos días,');
    assert.equal(previous(), undefined);
  });

  test(`${strategy}: a single translation replaces the lines, and lines replace it`, async () => {
    const clock = createVirtualClock(10_000);
    const seen = [];
    let lines = true;
    const pacer = createPacer({
      strategy,
      options: { interval: 1.5, minGap: 1.5 },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      translate: async (text, context) => {
        seen.push({ en: context.previous('en'), single: context.previous() });
        await new Promise((resolve) => clock.setTimer(resolve, 100));
        if (!lines) return `[t] ${text}`;
        context.keep('en', `[en] ${text}`);
      },
      show() {},
    });
    pacer.update('Bonjour à tous,');
    await clock.advance(2000);
    lines = false;
    pacer.update('Bonjour à tous, merci,');
    await clock.advance(2000);
    lines = true;
    pacer.update('Bonjour à tous, merci, pour,');
    await clock.advance(2000);
    pacer.update('Bonjour à tous, merci, pour, tout,');
    await clock.runAll();
    assert.deepEqual(seen, [
      { en: undefined, single: undefined },
      { en: '[en] Bonjour à tous,', single: undefined },
      { en: undefined, single: '[t] Bonjour à tous, merci,' },
      { en: '[en] Bonjour à tous, merci, pour,', single: undefined },
    ]);
  });

  test(`${strategy}: what arrives after the sentence was finished is not kept for it`, async () => {
    const clock = createVirtualClock(10_000);
    let late = null;
    const pacer = createPacer({
      strategy,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      translate: (_text, context) => {
        late = context;
        return new Promise(() => {});
      },
      show() {},
    });
    pacer.update('Ein Satz, der');
    await clock.advance(0);
    const previous = pacer.finish();
    late.keep('de', 'too late');
    assert.equal(previous('de'), undefined);
  });
}

test('chunk: what counts as a clause boundary or enough growth', () => {
  const cases = [
    // [text of the last request, text now, expected]
    ['', 'そうですね、', 'boundary'],
    ['そうですね、', 'そうですね、フィルターは', null],
    ['そうですね、', 'そうですね、フィルターは右側にまとめて、', 'boundary'],
    ['そうですね、フィルターは', 'そうですね、フィルターは右側にまとめて結果の一覧を', 'growth'],
    ['', 'おはようございます。', null],
    ['', 'おはようございます。今日は', 'boundary'],
    ['', '今日は新しい検索画面の進め方', 'growth'],
    ['', '我们今天讨论一下，', 'boundary'],
    ['', '오늘은 새로운 검색', null],
    ['', '오늘은 새로운 검색 화면에 대해서', 'growth'],
    ['', 'Great,', 'boundary'],
    ['', 'Thanks.', null],
    ['', 'Thanks. I', 'boundary'],
    ['Thanks. I', 'Thanks. I looked at the draft', null],
    ['Thanks. I', 'Thanks. I looked at the draft yesterday and I think', 'growth'],
    ['', 'It costs 3.5 dollars and 1,000 yen at 10:30', 'growth'],
    ['', 'It costs 3.5 dollars', null],
    ['', 'Wait; really', 'boundary'],
    ['', 'Really? Yes', 'boundary'],
    ['', '本当ですか？はい', 'boundary'],
    ['', 'आज हम बात करेंगे। फिर', 'boundary'],
    ['Hello there my', 'Hello there, my', 'boundary'],
    ['Hello, there', 'Hello, there my', null],
  ];
  for (const [sent, text, expected] of cases) assert.equal(chunkTrigger(sent, text), expected, `${sent} -> ${text}`);
  assert.equal(chunkTrigger('', '今日は新しい検索画面の', { growthDense: 20 }), null, 'thresholds are options');
  assert.equal(chunkTrigger('', 'Hello there my good', { growthSpaced: 10 }), 'growth');
});

test('chunk: the growth needed depends on the writing system', () => {
  assert.equal(growthFor('おはようございます'), 12);
  assert.equal(growthFor('今日は'), 12, 'too short to classify, but Japanese');
  assert.equal(growthFor('안녕하세요 여러분'), 12);
  assert.equal(growthFor('สวัสดีครับทุกคน'), 12);
  assert.equal(growthFor('Hello everyone'), 28);
  assert.equal(growthFor('नमस्ते सभी को'), 28);
  assert.equal(growthFor('Hi'), 28);
  assert.equal(growthFor('Hello', { growthSpaced: 20 }), 20);
});

test('chunk: a request when a clause ends, none while the words between come in', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'chunk', latency: 100 });
  for (const [at, text] of [
    [0, 'そうですね'],
    [300, 'そうですね、'],
    [1300, 'そうですね、フィルターは'],
    [1600, 'そうですね、フィルターは右側に'],
    [1900, 'そうですね、フィルターは右側にまとめて、'],
  ]) {
    await clock.advance(at - (clock.now() - 10_000));
    pacer.update(text);
  }
  await clock.runAll();
  assert.deepEqual(rel(sent), [
    [300, 'そうですね、'],
    [1900, 'そうですね、フィルターは右側にまとめて、'],
  ]);
});

test('chunk: a request when the text has grown enough without a boundary', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'chunk', latency: 100 });
  const words = 'I looked at the draft yesterday and I think the filters need more space'.split(' ');
  for (let i = 1; i <= words.length; i++) {
    pacer.update(words.slice(0, i).join(' '));
    await clock.advance(250);
  }
  await clock.runAll();
  assert.deepEqual(
    sent.map((x) => x.text),
    [
      'I looked at the draft yesterday',
      'I looked at the draft yesterday and I think the filters need',
      'I looked at the draft yesterday and I think the filters need more space',
    ],
    'the last words, too few for another chunk, go out after the maximum wait',
  );
});

test('chunk: requests keep a minimum gap, and the latest text goes out when it is over', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'chunk', latency: 100 });
  pacer.update('ええと、');
  await clock.advance(300);
  pacer.update('ええと、そうです、');
  await clock.advance(200);
  pacer.update('ええと、そうです、はい、');
  await clock.runAll();
  assert.deepEqual(rel(sent), [
    [0, 'ええと、'],
    [800, 'ええと、そうです、はい、'],
  ]);
});

test('chunk: text that stands still is translated after the maximum wait', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'chunk', latency: 100 });
  pacer.update('Hello there');
  await clock.advance(2000);
  pacer.update('Hello there my');
  await clock.advance(2000);
  assert.equal(sent.length, 0, 'each change restarts the wait');
  await clock.runAll();
  assert.deepEqual(rel(sent), [[4500, 'Hello there my']]);
});

test('chunk: the thresholds are options', async () => {
  const { clock, pacer, sent } = setup({
    strategy: 'chunk',
    latency: 100,
    options: { minGap: 0.2, maxWait: 1, growthSpaced: 5 },
  });
  pacer.update('Hello there');
  await clock.advance(100);
  pacer.update('Hello there you all');
  await clock.advance(1000);
  pacer.update('Hello there you all ok');
  await clock.runAll();
  assert.deepEqual(rel(sent), [
    [0, 'Hello there'],
    [200, 'Hello there you all'],
    [2100, 'Hello there you all ok'],
  ]);
});

// ---------- settle ----------

test('settle: what counts as the same text as the finished sentence', () => {
  const cases = [
    // [text of the last in-progress request, finished text, same]
    ['おはようございます', 'おはようございます。', true],
    ['今日は新しい検索画面について', '今日は、新しい検索画面について。', true],
    ['  今日は　新しい ', '今日は 新しい', true],
    ['今日は新しい検索画面', '今日は新しい検索画面の進め方', false],
    ['今日は新しい検索画面', '今日は古い検索画面', false],
    ['明日は来ますか', '明日は来ますか？', false],
    ['Thanks I looked at the draft', 'Thanks. I looked at the draft.', true],
    ['great, let’s review it on friday', "Great, let's review it on Friday.", true],
    ['Great lets review it on Friday', 'Great, let’s review it on Friday.', false],
    ['We can review it on Friday', 'We can review it on Friday?', false],
    ['That is great', 'That is great!', false],
    ['Hello everyone and welcome', 'Hello everyone and welcome to the meeting.', false],
    ['I can see it', 'I can’t see it.', false],
    ['It costs 3 dollars', 'It costs $3.', false],
    ['It grew by 3', 'It grew by 3%.', false],
    ['Version 3.5 is out', 'Version 35 is out.', false],
    ['Version 3.5 is out', 'Version 3.5 is out.', true],
    ['About 1,000 users', 'About 1,000 users.', true],
    ['我们今天讨论一下', '我们今天讨论一下。', true],
    ['我们今天讨论一下新的设计', '我们今天讨论一下，新的设计。', true],
    ['我们今天讨论一下新的设计', '我们今天讨论一下，新的设计？', false],
    ['我们今天讨论一下', '我们明天讨论一下。', false],
    ['', '', false],
    ['。', '.', false],
  ];
  for (const [a, b, same] of cases) assert.equal(sameText(a, b), same, `${a} / ${b}`);
});

test('carry stays selectable for comparison', () => {
  assert.equal(
    strategyNamed('carry', () => assert.fail('no warning')),
    'carry',
  );
});

test('settle: an answered request for the finished text is handed over as the final translation', async () => {
  const { clock, pacer, sent } = setup({ strategy: 'settle', latency: 100 });
  pacer.update('Good morning,');
  await clock.advance(2000);
  pacer.update('Good morning, everyone');
  await clock.runAll();
  assert.equal(sent.length, 2);
  const { previous, settled, pending } = pacer.finish('Good morning, everyone.');
  assert.equal(settled(), '[t] Good morning, everyone', 'no final request is needed');
  assert.equal(pending, null);
  assert.equal(previous(), '[t] Good morning, everyone', 'what carry would hand over is there too');
});

test('settle: a request for the finished text still on its way becomes the final translation when it arrives', async () => {
  const { clock, pacer, shown } = setup({ strategy: 'settle', latency: 1000 });
  pacer.update('おはようございます');
  await clock.advance(500);
  const { previous, settled, pending } = pacer.finish('おはようございます。');
  assert.equal(settled, null);
  assert.equal(previous(), undefined, 'nothing was shown yet');
  let answer = null;
  pending.then((a) => {
    answer = a;
  });
  await clock.advance(400);
  assert.equal(answer, null, 'not before it arrives');
  await clock.runAll();
  assert.equal(answer(), '[t] おはようございます');
  assert.deepEqual(shown, [], 'it is not shown as in progress: the sentence is finished');
});

test('settle: when the request on its way fails, the caller is told to ask for the final translation', async () => {
  for (const err of [new Error('network'), new RateLimitError('error.rateLimit')]) {
    const { clock, pacer, limits } = setup({ strategy: 'settle', latency: 1000, reply: () => err });
    pacer.update('Good morning everyone');
    await clock.advance(500);
    const { settled, pending } = pacer.finish('Good morning everyone.');
    assert.equal(settled, null);
    const result = pending.then((a) => a);
    await clock.runAll();
    assert.equal(await result, null, err.message);
    assert.equal(limits.length, err instanceof RateLimitError ? 1 : 0, 'the rate limit is reported as before');
  }
});

test('settle: in every other case the final translation is asked for, continuing what is shown', async () => {
  // The finished text has more words than the last request.
  let s = setup({ strategy: 'settle', latency: 100 });
  s.pacer.update('Hello everyone and');
  await s.clock.runAll();
  let handed = s.pacer.finish('Hello everyone and welcome.');
  assert.deepEqual([handed.settled, handed.pending], [null, null]);
  assert.equal(handed.previous(), '[t] Hello everyone and');

  // The text grew after the last request, and that request is still on its way.
  s = setup({ strategy: 'settle', latency: 1000 });
  s.pacer.update('Hello everyone and');
  await s.clock.advance(200);
  s.pacer.update('Hello everyone and welcome');
  handed = s.pacer.finish('Hello everyone and welcome.');
  assert.deepEqual([handed.settled, handed.pending], [null, null]);

  // The last request for the same text failed.
  s = setup({ strategy: 'settle', latency: 100, reply: () => new Error('network') });
  s.pacer.update('Hello everyone');
  await s.clock.runAll();
  handed = s.pacer.finish('Hello everyone.');
  assert.deepEqual([handed.settled, handed.pending], [null, null]);

  // Nothing was sent for the sentence, or the finished text is not given.
  s = setup({ strategy: 'settle' });
  s.pacer.update('Hi');
  handed = s.pacer.finish('Hi.');
  assert.deepEqual([handed.settled, handed.pending, handed.previous()], [null, null, undefined]);
  s.pacer.update('Hello everyone');
  await s.clock.runAll();
  handed = s.pacer.finish();
  assert.deepEqual([handed.settled, handed.pending], [null, null]);
});

test('settle: what is handed over belongs to the finished sentence, not to the next one', async () => {
  const { clock, pacer } = setup({ strategy: 'settle', latency: 100 });
  pacer.update('First sentence here');
  await clock.runAll();
  const first = pacer.finish('First sentence here.');
  pacer.update('Second sentence');
  await clock.runAll();
  assert.equal(first.settled(), '[t] First sentence here');
  const second = pacer.finish('Second sentence here.');
  assert.equal(second.settled, null, 'a sentence finished with other text than was sent');
});

test('settle: with one line per target, the answers of the last request are handed over per line', async () => {
  const clock = createVirtualClock(10_000);
  let lines = ['en', 'fr'];
  const pacer = createPacer({
    strategy: 'settle',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    // As the app does for several targets: one request per line; each answer is reported, and kept
    // only for the sentence still being spoken.
    translate: async (text, context) => {
      await new Promise((resolve) => clock.setTimer(resolve, 100));
      for (const code of lines) {
        context.answer(code, `[${code}] ${text}`);
        if (context.isCurrent()) context.keep(code, `[${code}] ${text}`);
      }
    },
    show: () => assert.fail('nothing for the pacer to show'),
  });
  pacer.update('Hola a todos');
  await clock.runAll();
  let { settled } = pacer.finish('Hola a todos.');
  assert.equal(settled('en'), '[en] Hola a todos');
  assert.equal(settled('fr'), '[fr] Hola a todos');
  assert.equal(settled(), undefined, 'no single translation');

  // One line got no answer from the last request: the caller sees it missing.
  pacer.update('Buenos días a todos');
  await clock.advance(2000);
  lines = ['en'];
  pacer.update('Buenos días a todos, gracias');
  await clock.runAll();
  ({ settled } = pacer.finish('Buenos días a todos, gracias.'));
  assert.equal(settled('en'), '[en] Buenos días a todos, gracias');
  assert.equal(settled('fr'), undefined, 'not the answer of an earlier request');

  // The answers of a request still on its way are handed over when they arrive, per line.
  lines = ['en', 'fr'];
  pacer.update('Hasta mañana');
  await clock.advance(50);
  const { pending } = pacer.finish('Hasta mañana.');
  const result = pending.then((a) => a);
  await clock.runAll();
  const answers = await result;
  assert.equal(answers('en'), '[en] Hasta mañana');
  assert.equal(answers('fr'), '[fr] Hasta mañana');
});

test('the other strategies hand over what they did before, given the finished text', async () => {
  for (const strategy of ['interval', 'steady', 'carry', 'chunk']) {
    const { clock, pacer } = setup({ strategy, latency: 100 });
    pacer.update('Good morning everyone');
    await clock.runAll();
    const handed = pacer.finish('Good morning everyone.');
    if (strategy === 'carry' || strategy === 'chunk') assert.equal(handed(), '[t] Good morning everyone', strategy);
    else assert.equal(handed, undefined, strategy);
  }
});
