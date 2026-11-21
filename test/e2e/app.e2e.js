// End-to-end tests in a real browser with a fake microphone. The Gemini endpoints are mocked,
// so no API key is needed. Uses the installed Chrome (set PW_CHANNEL=msedge etc. to change).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let server, browser, origin;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});
after(async () => { await browser?.close(); server?.close(); });

// The UI is Japanese unless the test says otherwise (most assertions read Japanese text).
// Settings are seeded on the first load of the tab only, so what the app saves survives a reload.
async function openApp(query = '', settings, init, { locale = 'en-US' } = {}) {
  const context = await browser.newContext({ permissions: ['microphone'], locale });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A blocked script, style or request shows up as a console error; treat it like a page error.
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  const stored = { uiLang: 'ja', ...settings };
  await context.addInitScript((s) => {
    try {
      if (window !== top || sessionStorage.getItem('e2e-seeded')) return;
      sessionStorage.setItem('e2e-seeded', '1');
      localStorage.setItem('rt-settings', JSON.stringify(s));
    } catch { /* a frame without storage */ }
  }, stored);
  if (init) await context.addInitScript(init.script, init.arg);
  await page.goto(`${origin}/${query}`);
  return { page, errors, close: () => context.close() };
}
const rows = (page) => page.locator('.seg').evaluateAll((nodes) => nodes.map((n) => ({
  live: n.classList.contains('live'), src: n.querySelector('.src').textContent, tgt: n.querySelector('.tgt').textContent,
})));
const sessionNames = (page) => page.locator('#sessionList .name').allTextContents();

// Mocks both Gemini endpoints. `script` is a list of [audioChunkNumber, 'interim' | 'final', text].
async function mockGemini(page, script) {
  let chunks = 0;
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      chunks++;
      for (const [at, kind, text] of script) {
        const field = kind === 'final' ? 'inputTranscription' : 'interimInputTranscription';
        if (at === chunks) ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
      }
    });
  });
  await page.route(/streamGenerateContent/, (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    const text = prompt.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `訳:${text}` }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return { restart: () => { chunks = 0; } };
}
const translated = (page, count) => page.waitForFunction(
  (n) => document.querySelectorAll('.seg:not(.live)').length === n
    && [...document.querySelectorAll('.seg:not(.live) .tgt')].every((el) => el.textContent.startsWith('訳:')), count);
const saved = (page) => page.waitForTimeout(500); // saves are debounced by 250 ms

test('asks for the API key before starting', async () => {
  const { page, errors, close } = await openApp();
  await page.click('#toggle');
  assert.ok(await page.locator('dialog#settings').evaluate((d) => d.open));
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.deepEqual(errors, []);
  await close();
});

test('the two languages can never be the same', async () => {
  const { page, close } = await openApp();
  await page.selectOption('#langA', 'en-US');
  assert.equal(await page.inputValue('#langB'), 'ja-JP');
  await page.click('#swap');
  assert.equal(await page.inputValue('#langA'), 'ja-JP');
  assert.equal(await page.inputValue('#langB'), 'en-US');
  await close();
});

test('demo mode shows one long utterance as separate translated sentences', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live)').length >= 3);
  const done = (await rows(page)).filter((r) => !r.live);
  assert.equal(done[0].src, 'それでは本日の定例会議を始めます。');
  assert.equal(done[1].src, 'まず先週の進捗について共有をお願いします。');
  await page.waitForFunction(() => document.querySelector('.seg .tgt').textContent === "Let's begin today's regular meeting.");
  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
  await close();
});

test('microphone audio is streamed and results are transcribed, split and translated', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const seen = { setup: null, chunks: 0, bytes: 0, mime: '', ended: 0 };
  const script = [
    [3, 'interimInputTranscription', 'Hello everyone, thanks for joining. Today'],
    [6, 'interimInputTranscription', 'Hello everyone, thanks for joining. Today we will'],
    [9, 'inputTranscription', 'Hello everyone, thanks for joining. Today we will review the plan.'],
    [12, 'interimInputTranscription', 'ありがとう'],
  ];
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) { seen.setup = msg.setup; ws.send(JSON.stringify({ setupComplete: {} })); }
      if (msg.realtimeInput?.audioStreamEnd) seen.ended++;
      if (!msg.realtimeInput?.audio) return;
      seen.chunks++;
      seen.mime = msg.realtimeInput.audio.mimeType;
      seen.bytes = Buffer.from(msg.realtimeInput.audio.data, 'base64').length;
      for (const [at, field, text] of script) {
        if (at === seen.chunks) ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
      }
    });
  });
  await page.route(/streamGenerateContent/, (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    const text = prompt.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `訳:${text}` }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent === 'ありがとう');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');
  await page.waitForFunction(() => [...document.querySelectorAll('.seg:not(.live) .tgt')].every((n) => n.textContent.startsWith('訳:')));
  assert.deepEqual((await rows(page)).filter((r) => !r.live), [
    { live: false, src: 'Hello everyone, thanks for joining.', tgt: '訳:Hello everyone, thanks for joining.' },
    { live: false, src: 'Today we will review the plan.', tgt: '訳:Today we will review the plan.' },
  ]);

  await page.click('#toggle'); // stopping keeps the sentence in progress
  await page.waitForFunction(() => !document.querySelector('.seg.live'));
  assert.equal((await rows(page)).at(-1).src, 'ありがとう');
  assert.equal(seen.setup.model, 'models/gemini-3.5-transcribe-live');
  assert.deepEqual(seen.setup.inputAudioTranscription.languageCodes, ['ja-JP', 'en-US']);
  assert.equal(seen.mime, 'audio/pcm;rate=16000');
  assert.equal(seen.bytes, 3200, '100 ms of 16 kHz 16-bit mono');
  assert.equal(seen.ended, 1);
  assert.deepEqual(errors, []);
  await close();
});

test('a rejected API key stops the session with a message', async () => {
  const { page, close } = await openApp('', { apiKey: 'bad-key' });
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage(() => ws.close({ code: 1007, reason: 'API key not valid. Please pass a valid API key.' }));
  });
  await page.click('#toggle');
  await page.waitForFunction(() => !document.getElementById('toast').hidden);
  assert.match(await page.textContent('#toast'), /API key not valid/);
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  await close();
});

test('sessions survive a reload, can be switched, renamed and deleted', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const gemini = await mockGemini(page, [[3, 'final', 'First meeting notes.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.']);

  await page.reload();
  assert.deepEqual(await rows(page), [{ live: false, src: 'First meeting notes.', tgt: '訳:First meeting notes.' }]);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.']);
  assert.match(await page.textContent('.seg .time'), /^\d\d:\d\d:\d\d$/);

  await page.click('#newSession');
  assert.deepEqual(await rows(page), []);
  assert.deepEqual(await sessionNames(page), ['First meeting notes.'], 'an untouched session is not saved');
  gemini.restart();
  await page.unroute(/streamGenerateContent/);
  await mockGemini(page, [[3, 'final', 'Second meeting.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  assert.deepEqual(await sessionNames(page), ['Second meeting.', 'First meeting notes.']);

  await page.locator('#sessionList .open').nth(1).click();
  assert.equal((await rows(page))[0].src, 'First meeting notes.');
  assert.ok(await page.locator('#sessionList .session').nth(1).evaluate((n) => n.classList.contains('current')));

  page.once('dialog', (d) => d.accept('週次定例'));
  await page.locator('#sessionList .session').nth(1).locator('.act').first().click();
  await saved(page);
  page.once('dialog', (d) => d.accept());
  await page.locator('#sessionList .session').first().locator('.act').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 1);
  await page.reload();
  assert.deepEqual(await sessionNames(page), ['週次定例']);
  assert.equal((await rows(page))[0].src, 'First meeting notes.');
  assert.deepEqual(errors, []);
  await close();
});

test('the transcript downloads with a timeline in the chosen format', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key' });
  await mockGemini(page, [[3, 'final', 'こんにちは、皆さん。']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await page.click('#export');

  const grab = async () => {
    const [file] = await Promise.all([page.waitForEvent('download'), page.click('#exportTranscript')]);
    const stream = await file.createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk;
    return { name: file.suggestedFilename(), text };
  };
  const txt = await grab();
  assert.equal(txt.name, 'こんにちは、皆さん。.txt');
  assert.match(txt.text, /言語: 日本語 ⇄ 英語/);
  assert.match(txt.text, /\[00:00:0\d\] こんにちは、皆さん。\n {11}→ 訳:こんにちは、皆さん。/);

  await page.selectOption('#exportFormat', 'csv');
  await page.selectOption('#exportContent', 'tgt');
  const csv = await grab();
  assert.ok(csv.name.endsWith('.csv'));
  assert.match(csv.text, /time,translation\r\n00:00:0\d,"訳:こんにちは、皆さん。"/);
  await close();
});

test('the audio is recorded, kept across a reload and can be downloaded', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockGemini(page, [[3, 'final', 'Recorded sentence.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.waitForTimeout(1200);
  await page.click('#toggle');
  await saved(page);
  await page.reload();

  await page.click('#export');
  assert.match(await page.textContent('#recordings .rec span'), /^録音 1 ・ .* ・ 00:00:0\d$/);
  const [file] = await Promise.all([page.waitForEvent('download'), page.click('#recordings .rec button')]);
  assert.match(file.suggestedFilename(), /^Recorded sentence\.-1\.(webm|m4a)$/);
  let bytes = 0;
  for await (const chunk of await file.createReadStream()) bytes += chunk.length;
  assert.ok(bytes > 1000, `recording should contain audio, got ${bytes} bytes`);
  assert.deepEqual(errors, []);
  await close();
});

test('recording can be turned off', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', record: false });
  await mockGemini(page, [[3, 'final', 'Not recorded.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await page.click('#export');
  assert.equal(await page.locator('#recordings .rec').count(), 0);
  await close();
});

test('finished sentences stay in the caption zone while the next ones are spoken', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await mockGemini(page, [
    [3, 'interim', 'One is'], [5, 'final', 'One is done.'], [7, 'final', 'Two is done.'],
    [9, 'final', 'Three is done.'], [11, 'interim', 'Four'],
  ]);
  const zone = () => page.locator('#nowList .seg .src').allTextContents();
  const history = () => page.locator('#log .seg .src').allTextContents();
  assert.ok(await page.locator('#now').isHidden(), 'hidden while stopped');

  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('#nowList .seg.live .src')?.textContent === 'One is');
  assert.deepEqual(await history(), [], 'nothing moves into the transcript while it is being spoken');

  await page.waitForFunction(() => document.querySelector('#nowList .seg.live .src')?.textContent === 'Four');
  assert.deepEqual(await zone(), ['Two is done.', 'Three is done.', 'Four'], 'the two latest finished sentences stay');
  assert.deepEqual(await history(), ['One is done.'], 'older ones move up into the transcript');
  assert.equal(await page.locator('#nowList .seg .tgt').first().textContent(), '訳:Two is done.');

  await page.click('#toggle');
  assert.ok(await page.locator('#now').isHidden());
  assert.deepEqual(await history(), ['One is done.', 'Two is done.', 'Three is done.', 'Four']);
  assert.deepEqual(errors, []);
  await close();
});

test('the translation on screen is swapped once, not restarted, when the sentence is finished', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key' });
  let ws;
  await page.routeWebSocket(/generativelanguage/, (socket) => {
    ws = socket;
    socket.onMessage((raw) => { if (JSON.parse(raw).setup) socket.send(JSON.stringify({ setupComplete: {} })); });
  });
  const send = (field, text) => ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
  const sse = (t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`;
  let release;
  await page.route(/streamGenerateContent/, async (route) => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text;
    if (prompt.includes('It is raining today.')) await new Promise((r) => { release = r; }); // hold the final translation
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(prompt.includes('today.') ? '今日は雨です。' : '雨が') });
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  send('interimInputTranscription', 'It is raining');
  await page.waitForFunction(() => document.querySelector('.seg .tgt')?.textContent === '雨が');
  send('inputTranscription', 'It is raining today.');
  await page.waitForFunction(() => !document.querySelector('.seg.live'));
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('.seg .tgt'), '雨が', 'the earlier translation stays while the final one is in flight');
  release();
  await page.waitForFunction(() => document.querySelector('.seg .tgt')?.textContent === '今日は雨です。');
  await page.click('#toggle');
  await close();
});

test('scrolling up to re-read offers a button back to the latest sentence', async () => {
  const { page, close } = await openApp('?mock=1');
  await page.setViewportSize({ width: 900, height: 420 });
  await page.click('#toggle');
  await page.waitForFunction(() => {
    const log = document.getElementById('log');
    return log.scrollHeight > log.clientHeight + 200;
  }, null, { timeout: 30_000 });
  assert.ok(await page.locator('#jump').isHidden(), 'follows the latest sentence by default');
  await page.evaluate(() => { document.getElementById('log').scrollTop = 0; });
  await page.waitForSelector('#jump:not([hidden])');
  await page.click('#jump');
  await page.waitForSelector('#jump', { state: 'hidden' });
  await page.click('#toggle');
  await close();
});

test('the number of sentences kept in the caption zone can be changed while listening', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await mockGemini(page, [[3, 'final', 'One.'], [5, 'final', 'Two.'], [7, 'final', 'Three.'], [9, 'interim', 'Four']]);
  const zone = () => page.locator('#nowList .seg .src').allTextContents();
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('#nowList .seg.live .src')?.textContent === 'Four');
  assert.deepEqual(await zone(), ['Two.', 'Three.', 'Four']);

  await page.click('#openSettings');
  assert.ok(await page.locator('#settingsRunning').isVisible());
  await page.locator('#captionItems').fill('1');
  assert.equal(await page.textContent('#captionItemsOut'), '1 文');
  assert.deepEqual(await zone(), ['Four'], 'applies immediately');
  await page.locator('#interimInterval').fill('3');
  assert.equal(await page.textContent('#interimIntervalOut'), '3.0 秒');
  await page.click('#settings button[value=ok]');
  await page.click('#toggle');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')));
  assert.equal(stored.captionItems, 1);
  assert.equal(stored.interimInterval, 3);
  await close();
});

test('the caption zone can be moved into an always-on-top window and comes back when it closes', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  // Headless browsers cannot open a real picture-in-picture window; stand in with an iframe.
  await page.evaluate(() => {
    // The real property is read-only, so it has to be redefined rather than assigned.
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: {
        requestWindow: async () => {
          const frame = document.createElement('iframe');
          frame.id = 'fakePip';
          document.body.append(frame);
          return frame.contentWindow;
        },
      },
    });
    document.getElementById('pip').hidden = false;
  });
  await mockGemini(page, [[3, 'final', 'Shown in the window.'], [6, 'interim', 'Still talking']]);
  await page.click('#pip');
  const inWindow = page.frameLocator('#fakePip');
  await inWindow.locator('#now').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#now').count(), 0, 'the zone left the main page');
  const fill = await page.evaluate(() => {
    const frame = document.getElementById('fakePip');
    const box = frame.contentDocument.getElementById('now').getBoundingClientRect();
    return [Math.round(box.width) === frame.clientWidth, Math.round(box.height) === frame.clientHeight];
  });
  assert.deepEqual(fill, [true, true], 'the zone fills the whole window');
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'true');

  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('fakePip').contentDocument
    .querySelector('.seg.live .src')?.textContent === 'Still talking');
  assert.deepEqual(await inWindow.locator('.seg .src').allTextContents(), ['Shown in the window.', 'Still talking']);
  assert.equal(await inWindow.locator('.seg .tgt').first().textContent(), '訳:Shown in the window.');

  await page.evaluate(() => document.getElementById('fakePip').contentWindow.dispatchEvent(new Event('pagehide')));
  assert.deepEqual(await page.locator('#now .seg .src').allTextContents(), ['Shown in the window.', 'Still talking']);
  assert.ok(await page.locator('#now').evaluate((n) => n.previousElementSibling.classList.contains('log-wrap')), 'back in its place under the transcript');
  assert.equal(await page.getAttribute('#pip', 'aria-pressed'), 'false');
  assert.equal(await page.getAttribute('#now', 'style'), '', 'window-only layout is removed');
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});

test('PC audio that delivers nothing is reported instead of failing silently', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false });
  await mockGemini(page, []);
  // Stand in for a screen share whose audio track exists but never carries a sample.
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  assert.ok(await page.locator('#toast').isHidden(), 'no warning right away');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('PC音声が届いていません'), null, { timeout: 15_000 });
  await page.click('#toggle');
  await close();
});

test('PC audio that is playing raises no warning', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false });
  await mockGemini(page, []);
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  await page.waitForTimeout(10_000);
  assert.ok(await page.locator('#toast').isHidden());
  await page.click('#toggle');
  await close();
});

// Stands in for the macOS desktop app's preload (app/preload.js): a 440 Hz tone at 48 kHz, sent
// in 20 ms chunks once started, or the helper ending with `endWith` shortly after it starts.
function fakeNativeSystemAudio({ endWith, amplitude = 0.5 }) {
  const calls = { start: 0, stop: 0, displayMedia: 0 };
  window.nativeCalls = calls;
  navigator.mediaDevices.getDisplayMedia = async () => { calls.displayMedia++; throw new Error('not expected'); };
  let onData = null;
  let onEnd = null;
  let timer = null;
  let phase = 0;
  window.nativeSystemAudio = {
    start: async () => {
      calls.start++;
      if (endWith) { setTimeout(() => onEnd?.(endWith), 200); return; }
      timer = setInterval(() => {
        const samples = new Float32Array(960);
        for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin(2 * Math.PI * 440 * (phase++) / 48000);
        onData?.(samples.buffer); // the real preload hands over an ArrayBuffer
      }, 20);
    },
    stop: async () => { calls.stop++; clearInterval(timer); },
    onData: (cb) => { onData = cb; },
    onEnd: (cb) => { onEnd = cb; },
  };
}

test('the desktop app on macOS takes PC audio from the native helper instead of a screen share', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: {} });
  const seen = { chunks: 0, peak: 0, bytes: 0 };
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      const pcm = Buffer.from(msg.realtimeInput.audio.data, 'base64');
      seen.chunks++;
      seen.bytes = pcm.length;
      for (let i = 0; i < pcm.length; i += 2) seen.peak = Math.max(seen.peak, Math.abs(pcm.readInt16LE(i)));
    });
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  await page.waitForTimeout(1500);
  assert.ok(seen.chunks >= 5, `audio chunks should be streamed, got ${seen.chunks}`);
  assert.equal(seen.bytes, 3200, '100 ms of 16 kHz 16-bit mono');
  assert.ok(seen.peak > 0x7fff * 0.3, `the tone should come through, peak ${seen.peak}`);
  await page.click('#toggle');
  const calls = await page.evaluate(() => window.nativeCalls);
  assert.deepEqual(calls, { start: 1, stop: 1, displayMedia: 0 });
  assert.ok(await page.locator('#toast').isHidden(), 'no silent-audio warning');
  assert.deepEqual(errors, []);
  await close();
});

test('the desktop app on macOS explains a missing Screen Recording permission and stops', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: { endWith: 'permission' } });
  await mockGemini(page, []);
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('画面収録とシステムオーディオ録音'));
  assert.match(await page.textContent('#toast'), /Twinscript を許可し、アプリを開き直してください/);
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.equal(await page.textContent('#statusText'), '停止中');
  const calls = await page.evaluate(() => window.nativeCalls);
  assert.deepEqual(calls, { start: 1, stop: 1, displayMedia: 0 });
  assert.deepEqual(errors, []);
  await close();
});

test('very quiet PC audio is brought up to a usable level before it is transcribed', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: { amplitude: 0.005 } }); // about -46 dBFS
  const peaks = [];
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      const pcm = Buffer.from(msg.realtimeInput.audio.data, 'base64');
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      peaks.push(peak / 0x7fff);
    });
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  await page.waitForTimeout(5000);
  const settled = peaks.at(-1);
  assert.ok(settled > 0.1 && settled < 0.3, `0.005 in should come out near 0.15–0.2, got ${settled}`);
  await page.click('#toggle');
  await close();
});

// ---------- UI language ----------
test('icons are decorative Octicons and messages are inline banners with a variant', async () => {
  const { page, errors, close } = await openApp('?mock=1', { uiLang: 'en' });
  // Every icon-only button shows an SVG hidden from assistive tech and is named by its label.
  const iconButtons = await page.locator('button.icon-btn').evaluateAll((bs) => bs.map((b) => ({
    label: b.getAttribute('aria-label'), text: b.textContent.trim(), svg: b.querySelector('svg')?.getAttribute('aria-hidden'),
  })));
  assert.ok(iconButtons.length >= 6);
  for (const b of iconButtons) assert.deepEqual([!!b.label, b.text, b.svg], [true, '', 'true'], JSON.stringify(b));
  assert.equal(await page.textContent('#newSession'), 'New session');
  assert.equal(await page.textContent('#jump'), 'Latest');
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'info', 'the demo notice is informational');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 1);
  const actions = await page.locator('#sessionList .act').evaluateAll((bs) => bs.map((b) => [b.title, b.textContent, !!b.querySelector('svg')]));
  assert.deepEqual(actions, [['Rename', '', true], ['Delete', '', true]]);
  await page.locator('#sessionList .open').click({ force: true });
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'warning');
  assert.equal(await page.textContent('#toast'), 'Stop translating before switching sessions');
  assert.deepEqual(errors, []);
  await close();
});

const optionText = (page, select, value) =>page.locator(`${select} option[value="${value}"]`).textContent();

test('the UI follows the browser language: English by default', async () => {
  const { page, errors, close } = await openApp('', { uiLang: 'auto' });
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#toggle'), 'Start translating');
  assert.equal(await page.textContent('#statusText'), 'Stopped');
  assert.equal(await page.textContent('#empty p'), 'Choose two languages and press "Start translating".');
  assert.equal(await page.getAttribute('#openSettings', 'title'), 'Settings');
  assert.equal(await optionText(page, '#langA', 'ja-JP'), 'Japanese');
  assert.equal(await optionText(page, '#langA', 'cmn-Hans-CN'), 'Simplified Chinese');
  assert.equal(await optionText(page, '#source', 'mic'), 'Microphone');
  await page.click('#toggle'); // no API key yet
  assert.equal(await page.textContent('#toast'), 'Set your Gemini API key first');
  assert.equal(await page.inputValue('#uiLang'), 'auto');
  assert.deepEqual(await page.locator('#uiLang option').allTextContents(), ['Auto', 'English', '日本語', '简体中文']);
  assert.deepEqual(errors, []);
  await close();
});

test('the UI follows the browser language: Simplified Chinese for zh-CN', async () => {
  const { page, errors, close } = await openApp('', { uiLang: 'auto' }, undefined, { locale: 'zh-CN' });
  assert.equal(await page.getAttribute('html', 'lang'), 'zh-Hans');
  assert.equal(await page.textContent('#toggle'), '开始翻译');
  assert.equal(await page.textContent('#statusText'), '已停止');
  assert.equal(await page.getAttribute('#export', 'aria-label'), '下载');
  assert.equal(await page.getAttribute('#glossary', 'placeholder'), '例如：专有名词、产品名称、会议主题等');
  assert.equal(await optionText(page, '#langA', 'en-US'), '英语');
  assert.equal(await optionText(page, '#langA', 'cmn-Hans-CN'), '简体中文');
  assert.equal(await optionText(page, '#langA', 'cmn-Hant-TW'), '繁体中文');
  assert.deepEqual(errors, []);
  await close();
});

test('changing the display language in settings updates the screen at once and is kept', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live)').length >= 1);
  assert.equal(await page.textContent('#toggle'), '停止');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');

  await page.click('#openSettings');
  assert.equal(await page.inputValue('#uiLang'), 'ja');
  await page.locator('#captionItems').fill('1');
  assert.equal(await page.textContent('#captionItemsOut'), '1 文');
  await page.selectOption('#uiLang', 'en');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#settings h2'), 'Settings');
  assert.equal(await page.textContent('#captionItemsOut'), '1 sentence');
  assert.equal(await optionText(page, '#otherInto', 'A'), 'Japanese (left language)');
  assert.equal(await optionText(page, '#uiLang', 'auto'), 'Auto');
  assert.equal(await page.textContent('#toggle'), 'Stop', 'the button keeps its running state');
  assert.equal(await page.textContent('#statusText'), 'Listening');
  assert.equal(await optionText(page, '#langB', 'en-US'), 'English');
  await page.click('#settings button[value=ok]');
  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), 'Stopped');
  await saved(page);
  assert.equal(await page.getAttribute('#sessionList .act >> nth=0', 'title'), 'Rename');

  await page.click('#openSettings');
  await page.selectOption('#uiLang', 'zh-Hans');
  assert.equal(await page.getAttribute('#sessionList .act >> nth=1', 'aria-label'), '删除', 'the session list is redrawn');
  await page.click('#settings button[value=ok]');

  await page.reload();
  assert.equal(await page.textContent('#toggle'), '开始翻译');
  assert.equal(await page.textContent('#settings h2'), '设置');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')));
  assert.equal(stored.uiLang, 'zh-Hans');
  assert.deepEqual(errors, []);
  await close();
});

test('the content security policy blocks requests to anywhere but the Gemini API', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  const outcome = await page.evaluate(async () => {
    const tryFetch = (url) => fetch(url).then(() => 'allowed', () => 'blocked');
    const tryScript = () => new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = 'https://example.com/x.js';
      el.onload = () => resolve('allowed');
      el.onerror = () => resolve('blocked');
      document.head.append(el);
    });
    const inline = document.createElement('script');
    inline.textContent = 'window.inlineRan = true';
    document.head.append(inline);
    return { elsewhere: await tryFetch('https://example.com/collect'), script: await tryScript(), inline: !!window.inlineRan };
  });
  assert.deepEqual(outcome, { elsewhere: 'blocked', script: 'blocked', inline: false });
  assert.ok(errors.filter((e) => /Content Security Policy/i.test(e)).length >= 3, 'each attempt is reported');
  await close();
});
