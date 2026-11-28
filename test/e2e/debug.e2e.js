// Browser tests: the tuning tools of ?debug=1 (recognizer trace, an audio file as the input).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseListening, mockGemini, reload, rows, saved, setup, translated } from './helpers.js';

const { openApp } = setup();

// A mono 16-bit WAV of a sine tone.
function sineWav(seconds = 1, rate = 16000, hz = 440) {
  const n = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.5 * 0x7fff), 44 + i * 2);
  return wav;
}

const sourceOptions = (page) => page.locator('#source option').evaluateAll((os) => os.map((o) => o.value));

test('in debug mode a run records the raw recognizer results, which can be downloaded', async () => {
  const { page, errors, close } = await openApp('?debug=1', { apiKey: 'test-key', vocabulary: 'gemini => Gemini' });
  const script = [
    [2, 'interim', 'Hello'],
    [4, 'interim', 'Hello gemini'],
    [6, 'final', 'Hello gemini users.'],
    [8, 'interim', 'Next'],
  ];
  await mockGemini(page, script);
  await page.click('#toggle');
  await translated(page, 1);
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent === 'Next');
  await page.click('#toggle');

  // The transcript has the correction; the trace keeps what the recognizer said.
  assert.equal((await rows(page))[0].src, 'Hello Gemini users.');
  const trace = await page.evaluate(() => window.__twinscriptTrace());
  assert.equal(trace.version, 1);
  assert.equal(trace.source, 'mic');
  assert.deepEqual(trace.langs, ['ja-JP', 'en-US']);
  assert.ok(!Number.isNaN(Date.parse(trace.startedAt)));
  assert.deepEqual(
    trace.events.map((e) => [e.kind, e.text]),
    script.map(([, kind, text]) => [kind, text]),
  );
  for (const [i, e] of trace.events.entries()) {
    assert.ok(Number.isInteger(e.t) && e.t >= 0);
    if (i) assert.ok(e.t >= trace.events[i - 1].t, 'times never go back');
  }
  assert.ok(trace.durationMs >= trace.events.at(-1).t);

  await page.click('#export');
  assert.equal(await page.textContent('#saveTrace'), '認識トレースをダウンロード（デバッグ）');
  const [file] = await Promise.all([page.waitForEvent('download'), page.click('#saveTrace')]);
  assert.match(file.suggestedFilename(), /^twinscript-trace-\d{8}-\d{6}\.json$/);
  let text = '';
  for await (const chunk of await file.createReadStream()) text += chunk;
  assert.deepEqual(JSON.parse(text), trace);
  assert.deepEqual(errors, []);
  await close();
});

test('without debug mode there is no file input, no trace and no trace download', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', source: 'file' });
  assert.ok(!(await sourceOptions(page)).includes('file'));
  assert.equal(await page.inputValue('#source'), 'mic'); // a file input saved in debug mode falls back
  await mockGemini(page, [[3, 'final', 'こんにちは。']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  assert.equal(await page.evaluate(() => typeof window.__twinscriptTrace), 'undefined');
  await page.click('#export');
  assert.equal(await page.locator('#saveTrace').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('in debug mode an audio file plays into the recognizer and the run stops when it ends', async () => {
  const { page, errors, close } = await openApp('?debug=1', { apiKey: 'test-key' });
  assert.equal(await page.textContent('#source option[value=file]'), '音声ファイル（デバッグ）');
  await chooseListening(page, '#source', 'file');
  let chunks = 0;
  let loud = 0;
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      const data = msg.realtimeInput?.audio?.data;
      if (!data) return;
      chunks++;
      const pcm = Buffer.from(data, 'base64');
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      if (peak > 0x1000) loud++;
      if (chunks === 3) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'From a file.' } } }));
    });
  });
  await page.route(/streamGenerateContent/, (route) => {
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '訳' }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#toggle')]);
  assert.match(await chooser.element().getAttribute('accept'), /audio\/\*/);
  await chooser.setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: sineWav() });
  await page.waitForFunction(() => document.body.classList.contains('running'));
  await page.waitForFunction(() => !document.body.classList.contains('running'), null, { timeout: 15000 });

  assert.ok(loud >= 8, `the tone should reach the recognizer, got ${loud} loud chunks of ${chunks}`);
  assert.ok(chunks >= 25, `silence keeps flowing during the tail, got ${chunks} chunks`);
  assert.equal((await rows(page))[0].src, 'From a file.');
  const trace = await page.evaluate(() => window.__twinscriptTrace());
  assert.equal(trace.source, 'file');
  assert.deepEqual(
    trace.events.map((e) => e.text),
    ['From a file.'],
  );
  await page.click('#export');
  assert.equal(await page.locator('#recordings .rec').count(), 0, 'a file is not recorded');
  assert.deepEqual(errors, []);
  await close();
});

test('an audio file that cannot be decoded is reported', async () => {
  const { page, errors, close } = await openApp('?debug=1', { apiKey: 'test-key', source: 'file' });
  await mockGemini(page, []);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#toggle')]);
  await chooser.setFiles({ name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not audio at all') });
  await page.waitForFunction(() => !document.getElementById('toast').hidden);
  assert.match(await page.textContent('#toast'), /broken\.mp3/);
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'critical');
  await page.waitForFunction(() => !document.body.classList.contains('running'));
  assert.deepEqual(errors, []);
  await close();
});

// The system instructions of the translation requests the page sends.
async function recordInstructions(page) {
  const seen = [];
  await page.route(/streamGenerateContent/, (route) => {
    seen.push(route.request().postDataJSON().systemInstruction.parts[0].text);
    return route.fallback();
  });
  return seen;
}
const PACER_SCRIPT = [
  [2, 'interim', 'Hello'],
  [6, 'interim', 'Hello every'],
  [10, 'interim', 'Hello everyone and'],
  [25, 'interim', 'Hello everyone and welcome to'],
  [30, 'final', 'Hello everyone and welcome to the meeting.'],
];

test('in debug mode ?pacer= picks how the sentence being spoken is translated', async () => {
  const { page, errors, close } = await openApp('?debug=1&pacer=carry', { apiKey: 'test-key' });
  await mockGemini(page, PACER_SCRIPT);
  const seen = await recordInstructions(page);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  // carry passes the translation on screen to the next request, and to the final one.
  const carried = seen.filter((s) => s.includes('already on screen'));
  assert.ok(carried.length >= 2, `requests continuing the shown translation: ${carried.length} of ${seen.length}`);
  for (const s of carried) assert.match(s, /already on screen: "訳:Hello/);
  assert.equal((await rows(page))[0].tgt, '訳:Hello everyone and welcome to the meeting.');
  assert.deepEqual(errors, []);
  await close();
});

test('without debug mode ?pacer= is ignored and the shown translation is continued', async () => {
  const { page, errors, close } = await openApp('?pacer=interval', { apiKey: 'test-key' });
  await mockGemini(page, PACER_SCRIPT);
  const seen = await recordInstructions(page);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  assert.ok(seen.length >= 2);
  assert.ok(
    seen.some((s) => s.includes('already on screen')),
    'the default strategy passes the translation on screen to the next request',
  );
  assert.deepEqual(errors, []);
  await close();
});

// Keeps what the page asks the system's speech synthesis to read in window.spoken; each reading
// ends at once.
function fakeSpeech() {
  if (window !== top) return;
  window.spoken = [];
  const synth = {
    getVoices: () => [],
    speak: (u) => {
      window.spoken.push({ text: u.text, lang: u.lang });
      setTimeout(() => u.onend?.(), 0);
    },
    cancel() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
}

test('in debug mode ?pacer=settle keeps the shown translation when it was made from the finished text', async () => {
  const { page, errors, close } = await openApp(
    '?debug=1&pacer=settle',
    { apiKey: 'test-key', readAloud: 'A' },
    { script: fakeSpeech },
  );
  await mockGemini(page, [
    [2, 'interim', 'Welcome everyone'],
    [20, 'interim', 'Welcome to the meeting'],
    [30, 'final', 'Welcome to the meeting.'],
    [35, 'interim', 'See you'],
    [50, 'final', 'See you next week.'],
  ]);
  const TRANSLATIONS = {
    'Welcome everyone': 'みなさんようこそ',
    'Welcome to the meeting': '会議へようこそ',
    'See you': 'またね',
    'See you next week.': 'また来週。',
  };
  const asked = [];
  await page.route(/streamGenerateContent/, (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    const text = prompt.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    asked.push(text);
    const out = TRANSLATIONS[text] ?? '…';
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.click('#toggle');
  const finals = () =>
    page
      .locator('.seg:not(.live) .tgt')
      .evaluateAll((nodes) => nodes.map((n) => ({ text: n.textContent, pending: n.classList.contains('pending') })));
  await page.waitForFunction(() => {
    const done = [...document.querySelectorAll('.seg:not(.live) .tgt')];
    return done.length === 2 && done.every((n) => !n.classList.contains('pending') && n.textContent !== 'またね');
  });

  assert.ok(asked.includes('Welcome to the meeting'), asked.join(' | '));
  assert.ok(!asked.includes('Welcome to the meeting.'), 'no final request: the shown translation is final');
  assert.ok(asked.includes('See you next week.'), 'other words than were shown: the final one is asked for');
  // (The settled translation lacks the closing full stop that the request's text did not have.)
  assert.deepEqual(await finals(), [
    { text: '会議へようこそ', pending: false },
    { text: 'また来週。', pending: false },
  ]);
  assert.deepEqual(
    await page.evaluate(() => window.spoken),
    [
      { text: '会議へようこそ', lang: 'ja-JP' },
      { text: 'また来週。', lang: 'ja-JP' },
    ],
    'each is read aloud once',
  );

  await page.click('#toggle');
  await saved(page);
  await reload(page);
  assert.deepEqual(
    (await rows(page)).map(({ src, tgt }) => [src, tgt]),
    [
      ['Welcome to the meeting.', '会議へようこそ'],
      ['See you next week.', 'また来週。'],
    ],
    'both are stored as final translations',
  );
  assert.deepEqual(errors, []);
  await close();
});

test('in debug mode ?pacer=interval translates each time from scratch, as before', async () => {
  const { page, errors, close } = await openApp('?debug=1&pacer=interval', { apiKey: 'test-key' });
  await mockGemini(page, PACER_SCRIPT);
  const seen = await recordInstructions(page);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((s) => !s.includes('already on screen')));
  assert.deepEqual(errors, []);
  await close();
});
