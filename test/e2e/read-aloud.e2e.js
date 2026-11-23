// Browser tests: reading translations aloud with the system's speech synthesis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listening, setup } from './helpers.js';

const { openApp } = setup();

// Stands in for the system's speech synthesis: what the page asks to read is kept in
// window.spoken, and calls to cancel() are counted in window.cancels. Nothing finishes on its own.
function fakeSpeech({ missing = false } = {}) {
  if (window !== top) return;
  if (missing) {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
    return;
  }
  window.spoken = [];
  window.cancels = 0;
  const synth = {
    getVoices: () => [],
    speak: (u) => window.spoken.push({ text: u.text, lang: u.lang }),
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
  await page.click('#swap');
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
  await page.selectOption('#langB', 'ja-JP');
  await page.click('#openSettings');
  assert.ok(await page.locator('#readAloud').isEnabled());
  assert.ok(await page.locator('#readAloudUnavailable').isHidden());
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
