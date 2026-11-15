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

async function openApp(query = '', settings) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (settings) await context.addInitScript((s) => localStorage.setItem('rt-settings', JSON.stringify(s)), settings);
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
