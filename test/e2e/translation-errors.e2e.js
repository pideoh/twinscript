// Browser tests: what the page shows when translation goes wrong (a server error or a network failure
// that may pass, a rate limit, an API key the service rejects, an empty answer, and a language that
// could not be identified).
// The retry delays and the one-minute pause are driven with Playwright's page clock, not waited for.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceUntil,
  lineStates,
  listening,
  mockSpeech,
  mockTranslation,
  requestTimes,
  setup,
  translationRows,
  useClock,
} from './helpers.js';

const { openApp } = setup();

const SERVER_ERROR = { status: 500, body: { error: { code: 500, message: 'The model is overloaded.' } } };
const RATE_LIMITED = { status: 429, body: { error: { code: 429, message: 'Resource exhausted.' } } };
const KEY_BLOCKED = { status: 403, body: { error: { code: 403, message: 'Requests from this API key are blocked.' } } };
const NETWORK_DOWN = { network: true };
const OK = (text) => `訳:${text}`;
// Waits until `count` rows are finished and each has text (a translation or an error) in it.
const settled = (page, count) =>
  page.waitForFunction((n) => {
    const rows = [...document.querySelectorAll('.seg:not(.live)')];
    return rows.length === n && rows.every((r) => r.querySelector('.tgt').textContent !== '');
  }, count);
const requestsMade = (seen, n) => () => seen.length >= n;
const flat = (row) => row.lines.map((l) => [l.tag, l.text, l.error]);

for (const [what, failure] of [
  ['a server error (HTTP 500)', SERVER_ERROR],
  ['a network failure', NETWORK_DOWN],
]) {
  test(`a sentence whose request fails once with ${what} is tried again after 1.5 seconds and translated, with no error left on the line`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
    await useClock(page);
    const { say } = await mockSpeech(page);
    const seen = await mockTranslation(page, ({ text, count }) => (count === 1 ? failure : OK(text)));
    await page.click('#toggle');
    await listening(page);

    await say('final', 'The model is busy for a moment.');
    await advanceUntil(page, requestsMade(seen, 2));
    await settled(page, 1);
    assert.deepEqual(await translationRows(page), [
      { src: 'The model is busy for a moment.', tgt: '訳:The model is busy for a moment.', error: false },
    ]);
    const [first, second] = await requestTimes(page);
    assert.ok(second - first >= 1500, `retried after ${second - first} ms`);
    assert.ok(await page.locator('#toast').isHidden(), 'a final sentence being retried raises no notice');
    assert.deepEqual(errors, []);
    await close();
  });
}

test('a sentence that keeps failing with a server error is tried again after 1.5, 3 and 6 seconds, then the line shows the error and the next sentence is translated', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (text.includes('first') ? SERVER_ERROR : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('final', 'The first sentence fails.');
  for (const n of [2, 3, 4]) {
    await advanceUntil(page, requestsMade(seen, n));
    assert.equal(seen.length, n, 'one retry per delay');
  }
  await settled(page, 1);
  assert.deepEqual(await translationRows(page), [
    { src: 'The first sentence fails.', tgt: '翻訳エラー (500): The model is overloaded.', error: true },
  ]);
  const times = await requestTimes(page);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const delays = [1500, 3000, 6000];
  assert.deepEqual(
    gaps.map((gap, i) => gap >= delays[i] && gap < delays[i] + 2000),
    [true, true, true],
    `delays between the requests: ${gaps}`,
  );
  // Past the last delay the request is not made a fifth time, and the next sentence is translated.
  await page.clock.fastForward(30_000);
  await say('final', 'The second one works.');
  await settled(page, 2);
  assert.deepEqual(await translationRows(page), [
    { src: 'The first sentence fails.', tgt: '翻訳エラー (500): The model is overloaded.', error: true },
    { src: 'The second one works.', tgt: '訳:The second one works.', error: false },
  ]);
  assert.deepEqual(
    seen.map((r) => [r.text, r.count]),
    [
      ['The first sentence fails.', 1],
      ['The first sentence fails.', 2],
      ['The first sentence fails.', 3],
      ['The first sentence fails.', 4],
      ['The second one works.', 1],
    ],
  );
  assert.ok(await page.locator('#toast').isHidden(), 'a server error raises no notice');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');
  assert.deepEqual(errors, []);
  await close();
});

test('a server error on the sentence in progress raises no notice and does not pause its translation', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (seen.length === 1 ? SERVER_ERROR : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('interim', 'Hello there everyone');
  await page.waitForFunction(() => window.__translationAt.length === 1);
  // The next update, a few seconds later rather than a minute, is translated.
  await page.clock.fastForward(3_000);
  await say('interim', 'Hello there everyone and welcome');
  await advanceUntil(page, async () =>
    page.evaluate(() => document.querySelector('.seg.live .tgt')?.textContent.startsWith('訳:')),
  );
  assert.equal(seen.length, 2, 'the failed in-progress request is not tried again; the next update is asked');
  assert.equal(seen[1].text, 'Hello there everyone and welcome');
  assert.ok(await page.locator('#toast').isHidden(), 'no rate-limit notice');
  assert.deepEqual(errors, []);
  await close();
});

test('a rate-limited sentence is tried again after 1.5 seconds and then translated, with no error left on the line', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text, count }) => (count === 1 ? RATE_LIMITED : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('final', 'Please try again later.');
  await advanceUntil(page, requestsMade(seen, 2));
  await settled(page, 1);
  assert.deepEqual(await translationRows(page), [
    { src: 'Please try again later.', tgt: '訳:Please try again later.', error: false },
  ]);
  const [first, second] = await requestTimes(page);
  assert.ok(second - first >= 1500, `retried after ${second - first} ms`);
  assert.ok(await page.locator('#toast').isHidden(), 'a final sentence being retried raises no notice');
  assert.deepEqual(errors, []);
  await close();
});

test('a sentence that stays rate-limited is tried again after 1.5, 3 and 6 seconds, then the line shows the error and listening goes on', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (text.includes('limited') ? RATE_LIMITED : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('final', 'This one stays limited.');
  for (const n of [2, 3, 4]) {
    await advanceUntil(page, requestsMade(seen, n));
    assert.equal(seen.length, n, 'one retry per delay');
  }
  await settled(page, 1);
  assert.deepEqual(await translationRows(page), [
    { src: 'This one stays limited.', tgt: '翻訳APIのレート制限に達しました', error: true },
  ]);
  const times = await requestTimes(page);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const delays = [1500, 3000, 6000];
  assert.deepEqual(
    gaps.map((gap, i) => gap >= delays[i] && gap < delays[i] + 2000),
    [true, true, true],
    `delays between the requests: ${gaps}`,
  );
  // Past the last delay the request is not made a fifth time, and the next sentence is translated.
  await page.clock.fastForward(30_000);
  assert.equal(await page.textContent('#statusText'), '聞き取り中');
  await say('final', 'The next sentence works.');
  await settled(page, 2);
  assert.deepEqual((await translationRows(page)).at(-1), {
    src: 'The next sentence works.',
    tgt: '訳:The next sentence works.',
    error: false,
  });
  assert.equal(seen.length, 5, 'four requests for the limited sentence, one for the next');
  assert.deepEqual(errors, []);
  await close();
});

test('a rate limit on the sentence in progress shows a notice and pauses its translation for a minute, then it resumes', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (seen.length === 1 ? RATE_LIMITED : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('interim', 'Hello there everyone');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('レート制限'));
  assert.equal(
    await page.textContent('#toast'),
    'レート制限のため、途中経過の翻訳を1分間停止します（確定文の翻訳は継続）',
  );
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'warning');

  // The text keeps growing, and nothing is requested during the pause.
  await say('interim', 'Hello there everyone and welcome');
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent.endsWith('welcome'));
  await page.clock.fastForward(30_000);
  await say('interim', 'Hello there everyone and welcome to the meeting');
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent.endsWith('meeting'));
  assert.equal(seen.length, 1, 'no request 30 s into the pause');
  assert.equal(await page.locator('.seg.live .tgt').textContent(), '');

  // A minute after the refusal the next update is translated.
  await page.clock.fastForward(31_000);
  await say('interim', 'Hello there everyone and welcome to the meeting today');
  await page.waitForFunction(() => document.querySelector('.seg.live .tgt')?.textContent.startsWith('訳:'));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].text, 'Hello there everyone and welcome to the meeting today');
  assert.deepEqual(errors, []);
  await close();
});

for (const [status, message] of [
  [400, 'API key not valid. Please pass a valid API key.'],
  [403, 'Requests from this API key are blocked.'],
]) {
  test(`an API key the service rejects (HTTP ${status}) shows the service's message on the line at once and is not retried`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
    await useClock(page);
    const { say } = await mockSpeech(page);
    const seen = await mockTranslation(page, () => ({ status, body: { error: { code: status, message } } }));
    await page.click('#toggle');
    await listening(page);

    await say('final', 'Is this working?');
    await settled(page, 1);
    assert.deepEqual(await translationRows(page), [
      { src: 'Is this working?', tgt: `翻訳エラー (${status}): ${message}`, error: true },
    ]);
    // Past the retry delays: no second request for it. The next sentence is asked
    // once and fails the same way, so the requests are one per sentence, not an endless loop.
    await page.clock.fastForward(20_000);
    await say('final', 'And this one?');
    await settled(page, 2);
    assert.deepEqual(
      seen.map((r) => [r.text, r.count]),
      [
        ['Is this working?', 1],
        ['And this one?', 1],
      ],
    );
    assert.equal((await translationRows(page))[1].tgt, `翻訳エラー (${status}): ${message}`);
    assert.equal(await page.textContent('#statusText'), '聞き取り中');
    assert.deepEqual(errors, []);
    await close();
  });
}

const STOPPED = { chunks: [{ candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 10 } }] };

test('an answer with no text says on the line that no translation came back, is not asked again, and the next sentence is translated', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (text.includes('silent') ? STOPPED : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('final', 'The model stays silent.');
  await settled(page, 1);
  await say('final', 'The model answers.');
  await settled(page, 2);
  assert.deepEqual(await translationRows(page), [
    { src: 'The model stays silent.', tgt: '翻訳が返ってきませんでした', error: true },
    { src: 'The model answers.', tgt: '訳:The model answers.', error: false },
  ]);
  assert.equal(seen.length, 2, 'an empty answer is not asked again');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');
  assert.deepEqual(errors, []);
  await close();
});

test('an empty answer for the sentence in progress shows nothing, and the next one is shown', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await useClock(page);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, ({ text }) => (seen.length === 1 ? STOPPED : OK(text)));
  await page.click('#toggle');
  await listening(page);

  await say('interim', 'Hello there everyone');
  await page.waitForFunction(() => window.__translationAt.length === 1);
  // Well past the time its answer takes, the line in progress still shows nothing.
  await page.clock.fastForward(3_000);
  assert.equal(seen[0].text, 'Hello there everyone');
  assert.equal(await page.locator('.seg.live .tgt').textContent(), '');
  assert.equal(await page.locator('.seg.live .tgt.error').count(), 0, 'no error on the line in progress');
  await say('interim', 'Hello there everyone and welcome');
  await advanceUntil(page, async () =>
    page.evaluate(() => document.querySelector('.seg.live .tgt')?.textContent.startsWith('訳:')),
  );
  assert.ok(await page.locator('#toast').isHidden(), 'no notice');
  assert.deepEqual(errors, []);
  await close();
});

const THREE = { apiKey: 'test-key', interimTranslate: false, langA: 'en-US', langB: 'fr-FR', langC: 'ja-JP' };
const identified = (language) => JSON.stringify({ language });
const tagged = ({ text, into }) => `[${into}] ${text}`;
const linesDone = (page, rows, lines) =>
  page.waitForFunction(
    ([r, l]) =>
      document.querySelectorAll('.seg:not(.live)').length === r &&
      document.querySelectorAll('.seg:not(.live) .tgt-line').length === l &&
      document.querySelectorAll('.seg:not(.live) .tgt-line.pending').length === 0,
    [rows, lines],
  );

test('with English, French and Japanese, a Latin-script sentence is asked about, then goes into the other two; Japanese is not asked about', async () => {
  const { page, errors, close } = await openApp('', THREE);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, (request) => {
    if (!request.identify) return tagged(request);
    return identified(request.text.startsWith('Bonjour') ? 'French' : 'English');
  });
  await page.click('#toggle');
  await listening(page);

  await say('final', 'Bonjour à tous, bienvenue.');
  await say('final', 'Welcome to the meeting.');
  await say('final', 'それでは会議を始めます。');
  await linesDone(page, 3, 6);
  assert.deepEqual(
    (await lineStates(page)).map((r) => [r.src, flat(r)]),
    [
      [
        'Bonjour à tous, bienvenue.',
        [
          ['EN', '[English] Bonjour à tous, bienvenue.', false],
          ['JA', '[Japanese] Bonjour à tous, bienvenue.', false],
        ],
      ],
      [
        'Welcome to the meeting.',
        [
          ['FR', '[French] Welcome to the meeting.', false],
          ['JA', '[Japanese] Welcome to the meeting.', false],
        ],
      ],
      [
        'それでは会議を始めます。',
        [
          ['EN', '[English] それでは会議を始めます。', false],
          ['FR', '[French] それでは会議を始めます。', false],
        ],
      ],
    ],
  );
  const asked = seen.filter((r) => r.identify);
  assert.deepEqual(
    asked.map((r) => r.text),
    ['Bonjour à tous, bienvenue.', 'Welcome to the meeting.'],
    'the Japanese sentence is told by its writing system',
  );
  assert.match(
    asked[0].body.systemInstruction.parts[0].text,
    /one of "English", "French", "Japanese", "other"/,
    'the model chooses among the selected languages',
  );
  assert.deepEqual(errors, []);
  await close();
});

test('with three languages only the line whose answer had no text says that no translation came back', async () => {
  const { page, errors, close } = await openApp('', THREE);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, (request) => {
    if (request.identify) return identified('English');
    return request.into === 'French' ? STOPPED : tagged(request);
  });
  await page.click('#toggle');
  await listening(page);

  await say('final', 'Welcome to the meeting.');
  await linesDone(page, 1, 2);
  await page.waitForFunction(() => document.querySelector('.seg:not(.live) .tgt-line.error'));
  assert.deepEqual(flat((await lineStates(page))[0]), [
    ['FR', '翻訳が返ってきませんでした', true],
    ['JA', '[Japanese] Welcome to the meeting.', false],
  ]);
  assert.equal(seen.filter((r) => r.into === 'French').length, 1, 'the empty line is not asked again');
  assert.deepEqual(errors, []);
  await close();
});

test('when the language cannot be identified (the request fails, or the answer is not one of the languages), the sentence goes into all three', async () => {
  const { page, errors, close } = await openApp('', THREE);
  const { say } = await mockSpeech(page);
  const seen = await mockTranslation(page, (request) => {
    if (!request.identify) return tagged(request);
    return request.text.includes('broken') ? SERVER_ERROR : identified('German');
  });
  await page.click('#toggle');
  await listening(page);

  await say('final', 'The identify request is broken.');
  await say('final', 'Guten Morgen miteinander.');
  await linesDone(page, 2, 6);
  for (const row of await lineStates(page)) {
    assert.deepEqual(
      flat(row),
      [
        ['EN', `[English] ${row.src}`, false],
        ['FR', `[French] ${row.src}`, false],
        ['JA', `[Japanese] ${row.src}`, false],
      ],
      row.src,
    );
  }
  assert.equal(seen.filter((r) => r.identify).length, 2, 'each sentence is asked about once, not retried');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');
  assert.deepEqual(errors, []);
  await close();
});

test('with three languages a line whose translation fails shows the error while the other line is translated', async () => {
  const { page, errors, close } = await openApp('', THREE);
  const { say } = await mockSpeech(page);
  await mockTranslation(page, (request) => {
    if (request.identify) return identified('English');
    return request.into === 'French' ? KEY_BLOCKED : tagged(request);
  });
  await page.click('#toggle');
  await listening(page);

  await say('final', 'Welcome to the meeting.');
  await linesDone(page, 1, 2);
  assert.deepEqual(flat((await lineStates(page))[0]), [
    ['FR', '翻訳エラー (403): Requests from this API key are blocked.', true],
    ['JA', '[Japanese] Welcome to the meeting.', false],
  ]);
  assert.deepEqual(errors, []);
  await close();
});
