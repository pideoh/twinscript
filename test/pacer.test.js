import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualClock } from '../scripts/tuning/clock.mjs';
import { createPacer } from '../src/pacer.js';
import { RateLimitError } from '../src/translator.js';

// A pacer on a simulated clock whose translator answers after `latency` ms (or with `reply`).
function setup({ latency = 300, reply, options = { interval: 1.5 } } = {}) {
  const clock = createVirtualClock(10_000);
  const sent = [];
  const shown = [];
  const limits = [];
  const pacer = createPacer({
    options,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    translate: (text, context) => {
      sent.push({ at: clock.now(), text, context });
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
