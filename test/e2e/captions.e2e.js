// Browser tests: caption zone, caption window, settings that affect them, language pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mockGemini } from './helpers.js';

const { openApp } = setup();

test('the two languages can never be the same', async () => {
  const { page, close } = await openApp();
  await page.selectOption('#langA', 'en-US');
  assert.equal(await page.inputValue('#langB'), 'ja-JP');
  await page.click('#swap');
  assert.equal(await page.inputValue('#langA'), 'ja-JP');
  assert.equal(await page.inputValue('#langB'), 'en-US');
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

