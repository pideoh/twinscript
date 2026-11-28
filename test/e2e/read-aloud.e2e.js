// Browser tests: reading translations aloud with the system's speech synthesis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseListening, fakeDisplayMedia, listening, mockTargets, setup, swapLanguages } from './helpers.js';

const { openApp } = setup();

// Stands in for the system's speech synthesis: what the page asks to read is kept in
// window.spoken, and calls to cancel() are counted in window.cancels. Nothing finishes on its own:
// window.finishSpeaking() ends the sentence being read.
function fakeSpeech({ missing = false } = {}) {
  if (window !== top) return;
  if (missing) {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
    return;
  }
  window.spoken = [];
  window.cancels = 0;
  let last;
  window.finishSpeaking = () => last?.onend?.();
  const synth = {
    getVoices: () => [],
    speak: (u) => {
      last = u;
      window.spoken.push({ text: u.text, lang: u.lang });
    },
    cancel: () => {
      window.cancels++;
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
}

// The fake speech engine in the Windows desktop app (its user agent), with PC audio standing in too.
const inWindowsApp = { script: { content: `(${fakeSpeech})();(${fakeDisplayMedia})({ desktopApp: 'win' });` } };

// The recognizer is driven by hand; translations are real-looking text in the other language.
async function mockMeeting(page) {
  let ws;
  await page.routeWebSocket(/generativelanguage/, (socket) => {
    ws = socket;
    socket.onMessage((raw) => {
      if (JSON.parse(raw).setup) socket.send(JSON.stringify({ setupComplete: {} }));
    });
  });
  const TRANSLATIONS = [
    ['It is raining today.', '今日は雨が降っています。'],
    ['It is raining', '雨が降っています'],
    ['それでは会議を始めます。', 'Let us begin the meeting.'],
    ['See you next week.', 'また来週お会いしましょう。'],
  ];
  await page.route(/streamGenerateContent/, (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    const text = prompt.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    const out = TRANSLATIONS.find(([src]) => text === src)?.[1] ?? '…';
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return (field, text) => ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
}
const shownTranslation = (page, text) =>
  page.waitForFunction((t) => [...document.querySelectorAll('.seg .tgt')].some((el) => el.textContent === t), text);
const spoken = (page) => page.evaluate(() => window.spoken);

test('finished translations into the chosen language are read aloud once, and nothing else is', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', readAloud: 'A', interimInterval: 0.5 },
    { script: fakeSpeech },
  );
  const send = await mockMeeting(page);
  await page.click('#toggle');
  await listening(page);

  send('interimInputTranscription', 'It is raining');
  await shownTranslation(page, '雨が降っています');
  assert.deepEqual(await spoken(page), [], 'a translation of a sentence still being spoken is not read');

  send('inputTranscription', 'It is raining today.');
  await shownTranslation(page, '今日は雨が降っています。');
  send('inputTranscription', 'それでは会議を始めます。');
  await shownTranslation(page, 'Let us begin the meeting.');
  assert.deepEqual(
    await spoken(page),
    [{ text: '今日は雨が降っています。', lang: 'ja-JP' }],
    'only the translation into Japanese, in Japanese',
  );

  const cancels = await page.evaluate(() => window.cancels);
  await page.click('#toggle');
  assert.ok((await page.evaluate(() => window.cancels)) > cancels, 'stopping silences the voice');
  assert.deepEqual(errors, []);
  await close();
});

test('of the two translations of speech in neither language, the one in the chosen language is read', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', readAloud: 'A', interimTranslate: false },
    { script: fakeSpeech },
  );
  const send = await mockMeeting(page);
  await page.route(/streamGenerateContent/, (route) => {
    const system = route.request().postDataJSON().systemInstruction.parts[0].text;
    const out = /into Japanese\./.test(system)
      ? 'これは小さな同期モーターです。'
      : 'This is a small synchronous motor.';
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.click('#toggle');
  await listening(page);
  send('inputTranscription', 'और यह है छोटे सिंक्रोनस मोटर।');
  await page.waitForFunction(() => document.querySelectorAll('.seg .tgt-line:not(.pending)').length === 2);
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.deepEqual(await spoken(page), [{ text: 'これは小さな同期モーターです。', lang: 'ja-JP' }]);
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

test('turning reading aloud off silences it at once, also while listening', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', readAloud: 'both' }, { script: fakeSpeech });
  const send = await mockMeeting(page);
  await page.click('#toggle');
  await listening(page);
  send('inputTranscription', 'それでは会議を始めます。');
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.deepEqual(await spoken(page), [{ text: 'Let us begin the meeting.', lang: 'en-US' }]);

  await page.click('#openSettings');
  await page.selectOption('#readAloud', 'off');
  assert.ok((await page.evaluate(() => window.cancels)) > 0, 'the sentence being read is cut off');
  await page.click('#settings button[value=ok]');
  send('inputTranscription', 'See you next week.');
  await shownTranslation(page, 'また来週お会いしましょう。');
  assert.equal((await spoken(page)).length, 1, 'later sentences are not read');
  await page.click('#toggle');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')));
  assert.equal(stored.readAloud, 'off', 'the choice is kept');
  assert.deepEqual(errors, []);
  await close();
});

test('reading aloud keeps to the same language after the two are swapped', async () => {
  const { page, errors, close } = await openApp('', { readAloud: 'A' }, { script: fakeSpeech });
  await page.click('#openSettings');
  assert.equal(await page.locator('#readAloud option[value=A]').textContent(), '日本語への訳文');
  await page.click('#settings button[value=ok]');
  await swapLanguages(page);
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#readAloud'), 'B');
  assert.equal(await page.locator('#readAloud option[value=B]').textContent(), '日本語への訳文');
  assert.deepEqual(errors, []);
  await close();
});

test('reading aloud is unavailable for two languages written in the same alphabet', async () => {
  const { page, errors, close } = await openApp('', { langA: 'en-US', langB: 'fr-FR' }, { script: fakeSpeech });
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isDisabled());
  assert.ok(await page.locator('#readAloudUnavailable').isVisible());
  await page.click('#settings button[value=ok]');
  await chooseListening(page, '#langB', 'ja-JP');
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isEnabled());
  assert.ok(await page.locator('#readAloudUnavailable').isHidden());
  assert.deepEqual(errors, []);
  await close();
});

test('in the Windows desktop app reading aloud is not offered while PC audio is captured, and the choice is kept', async () => {
  const { page, errors, close } = await openApp('', { source: 'system', readAloud: 'A' }, inWindowsApp);
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isDisabled());
  assert.equal(await page.inputValue('#readAloud'), 'off');
  assert.equal(
    await page.locator('#readAloudHeard').textContent(),
    'Windows では、PC音声を取り込んでいる間は使えません。アプリが自分の読み上げを聞き取ってしまうためです。音声入力がマイクなら使えます。',
  );
  assert.ok(await page.locator('#readAloudHeard').isVisible());
  assert.ok(await page.locator('#readAloudUnavailable').isHidden());
  await page.click('#settings button[value=ok]');

  await chooseListening(page, '#source', 'mic');
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isEnabled());
  assert.equal(await page.inputValue('#readAloud'), 'A', 'the stored choice applies again');
  assert.ok(await page.locator('#readAloudHeard').isHidden());
  await page.click('#settings button[value=ok]');

  await chooseListening(page, '#source', 'both');
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isDisabled());
  assert.ok(await page.locator('#readAloudHeard').isVisible());
  await page.click('#settings button[value=ok]');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')).readAloud);
  assert.equal(stored, 'A');
  assert.deepEqual(errors, []);
  await close();
});

test('in the Windows desktop app nothing is read aloud while PC audio is captured', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false, readAloud: 'both' },
    inWindowsApp,
  );
  const send = await mockMeeting(page);
  await page.click('#toggle');
  await listening(page);
  send('inputTranscription', 'それでは会議を始めます。');
  await shownTranslation(page, 'Let us begin the meeting.');
  send('inputTranscription', 'See you next week.');
  await shownTranslation(page, 'また来週お会いしましょう。');
  assert.deepEqual(await spoken(page), []);
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

test('in the Windows desktop app translations are read aloud with the microphone as the source', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', readAloud: 'both' }, inWindowsApp);
  const send = await mockMeeting(page);
  await page.click('#toggle');
  await listening(page);
  send('inputTranscription', 'それでは会議を始めます。');
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.deepEqual(await spoken(page), [{ text: 'Let us begin the meeting.', lang: 'en-US' }]);
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

// Waits until `count` distinct translation lines are finished, the last sentence's included.
const linesFinished = (page, count) =>
  page.waitForFunction(
    (n) =>
      new Set(
        [...document.querySelectorAll('.seg .tgt-line:not(.pending) .tgt-text')]
          .map((t) => t.textContent)
          .filter((t) => t.startsWith('[')),
      ).size === n,
    count,
  );
const readAloudOptions = (page) =>
  page.locator('#readAloud option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));

test('with three languages each of them can be chosen for reading aloud, both directions cannot', async () => {
  const { page, errors, close } = await openApp('', { langC: 'ko-KR' }, { script: fakeSpeech });
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isEnabled());
  assert.deepEqual(await readAloudOptions(page), [
    ['off', 'オフ'],
    ['A', '日本語への訳文'],
    ['B', '英語への訳文'],
    ['C', '韓国語への訳文'],
  ]);
  assert.deepEqual(errors, []);
  await close();
});

test('with three languages only the translation into the chosen language is read, never a sentence in it', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', langC: 'ko-KR', readAloud: 'C', interimTranslate: false },
    { script: fakeSpeech },
  );
  const send = await mockMeeting(page);
  await mockTargets(page);
  await page.click('#toggle');
  await listening(page);

  send('inputTranscription', 'It is raining today.');
  await linesFinished(page, 2);
  await page.waitForFunction(() => window.spoken.length === 1);
  assert.deepEqual(
    await spoken(page),
    [{ text: '[Korean] It is raining today.', lang: 'ko-KR' }],
    'the Korean line, not the Japanese one',
  );

  await page.evaluate(() => window.finishSpeaking());
  send('inputTranscription', '오늘은 비가 옵니다.');
  send('inputTranscription', 'See you next week.');
  await linesFinished(page, 6);
  await page.waitForFunction(() => window.spoken.length === 2);
  assert.deepEqual(
    (await spoken(page)).map((x) => x.text),
    ['[Korean] It is raining today.', '[Korean] See you next week.'],
    'a sentence spoken in Korean is not read',
  );
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

test('a choice of reading aloud that does not fit the number of languages shows and acts as off', async () => {
  const { page, errors, close } = await openApp('', { readAloud: 'both' }, { script: fakeSpeech });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')).readAloud);
  await chooseListening(page, '#langC', 'ko-KR');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#readAloud'), 'off', 'both directions, with three languages');
  await page.selectOption('#readAloud', 'C');
  await page.click('#settings button[value=ok]');

  await chooseListening(page, '#langC', '');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#readAloud'), 'off', 'the third language, once it is turned off');
  assert.deepEqual(
    (await readAloudOptions(page)).map(([value]) => value),
    ['off', 'A', 'B', 'both'],
  );
  assert.equal(await stored(), 'off');
  await page.click('#settings button[value=ok]');

  await chooseListening(page, '#langC', 'ko-KR');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#readAloud'), 'off', 'turning a third language on again does not bring it back');
  await page.selectOption('#readAloud', 'C');
  await page.click('#settings button[value=ok]');
  await chooseListening(page, '#langA', 'ko-KR');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#readAloud'), 'A', 'the choice follows Korean to another place');
  assert.deepEqual(errors, []);
  await close();
});

test('the setting is not offered where the browser cannot speak', async () => {
  const { page, errors, close } = await openApp('', {}, { script: fakeSpeech, arg: { missing: true } });
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloudField').isHidden());
  assert.deepEqual(errors, []);
  await close();
});
