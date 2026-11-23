// Browser tests: terms and corrections from settings reach the recognizer and fix the transcript.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rows, setup } from './helpers.js';

const { openApp } = setup();

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

  // A rule changed while stopped applies when the same session is started again.
  await page.click('#openSettings');
  await page.fill('#vocabulary', 'twin script => TWINSCRIPT');
  await page.click('#settings button[value=ok]');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelector('.seg.live .src')?.textContent === 'TWINSCRIPT');
  assert.deepEqual(
    (await rows(page)).filter((r) => !r.live).map((r) => r.src),
    ['We use Twinscript for meetings.', 'Twinscript', 'We use TWINSCRIPT for meetings.'],
    'earlier rows, including the one cut off by stopping, keep the text they had',
  );
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});
