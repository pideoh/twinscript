// Browser tests: audio capture (microphone, PC audio, native helper, auto gain).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeNativeSystemAudio, mockGemini, rows, setup } from './helpers.js';

const { openApp } = setup();

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
      if (msg.setup) {
        seen.setup = msg.setup;
        ws.send(JSON.stringify({ setupComplete: {} }));
      }
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
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.seg:not(.live) .tgt')].every((n) => n.textContent.startsWith('訳:')),
  );
  assert.deepEqual(
    (await rows(page)).filter((r) => !r.live),
    [
      { live: false, src: 'Hello everyone, thanks for joining.', tgt: '訳:Hello everyone, thanks for joining.' },
      { live: false, src: 'Today we will review the plan.', tgt: '訳:Today we will review the plan.' },
    ],
  );

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

test('terms and corrections from settings reach the recognizer and fix the transcript', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  let setupMsg = null;
  const script = [
    [3, 'interimInputTranscription', 'We use twin script'],
    [6, 'inputTranscription', 'We use twin script for meetings.'],
    [9, 'interimInputTranscription', 'Twin Script'],
  ];
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    let chunks = 0;
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) {
        setupMsg = msg.setup;
        ws.send(JSON.stringify({ setupComplete: {} }));
      }
      if (!msg.realtimeInput?.audio) return;
      chunks++;
      for (const [at, field, text] of script) {
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

  await page.click('#openSettings');
  await page.fill('#vocabulary', 'Kubernetes\ntwin script => Twinscript\n');
  await page.click('#settings button[value=ok]');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent === 'Twinscript');
  assert.deepEqual(
    (await rows(page)).filter((r) => !r.live).map((r) => r.src),
    ['We use Twinscript for meetings.'],
  );
  assert.deepEqual(setupMsg.inputAudioTranscription.customVocabulary, ['Kubernetes', 'Twinscript']);
  await page.click('#toggle');
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

test('the desktop app on macOS takes PC audio from the native helper instead of a screen share', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: {} },
  );
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
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: { endWith: 'permission' } },
  );
  await mockGemini(page, []);
  await page.click('#toggle');
  await page.waitForFunction(() =>
    document.getElementById('toast').textContent.includes('画面収録とシステムオーディオ録音'),
  );
  assert.match(await page.textContent('#toast'), /Twinscript を許可し、アプリを開き直してください/);
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.equal(await page.textContent('#statusText'), '停止中');
  const calls = await page.evaluate(() => window.nativeCalls);
  assert.deepEqual(calls, { start: 1, stop: 1, displayMedia: 0 });
  assert.deepEqual(errors, []);
  await close();
});

test('very quiet PC audio is brought up to a usable level before it is transcribed', async () => {
  const { page, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeNativeSystemAudio, arg: { amplitude: 0.005 } },
  ); // about -46 dBFS
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
