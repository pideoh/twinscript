// Browser tests: the single-use token of the live connection, its fallback and a key refused at the token request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockGemini, rows, setup, translated } from './helpers.js';

const { openApp } = setup();

test('the live connection uses a single-use token and the API key stays out of its address', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const gemini = await mockGemini(page, [[3, 'final', 'こんにちは。']]);
  await page.click('#toggle');
  await translated(page, 1);
  assert.deepEqual(await rows(page), [{ live: false, src: 'こんにちは。', tgt: '訳:こんにちは。' }]);
  assert.equal(gemini.tokenRequests.length, 1);
  const [request] = gemini.tokenRequests;
  assert.equal(request.headers['x-goog-api-key'], 'test-key');
  assert.equal(request.body, '{}');
  assert.ok(!request.url.includes('test-key'));
  assert.equal(gemini.sockets.length, 1);
  assert.match(gemini.sockets[0], /\.BidiGenerateContentConstrained\?access_token=auth_tokens%2Fe2e-\d+$/);
  assert.ok(!gemini.sockets[0].includes('test-key'));
  assert.deepEqual(errors, []);
  await page.click('#toggle');
  await close();
});

test('if single-use tokens are unavailable, the session still transcribes and a warning is logged', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const warnings = [];
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()));
  const gemini = await mockGemini(page, [[3, 'final', 'こんにちは。']], { tokens: 'unreachable' });
  await page.click('#toggle');
  await translated(page, 1);
  assert.equal(gemini.sockets.length, 1);
  assert.match(gemini.sockets[0], /\.BidiGenerateContent\?key=test-key$/);
  const tokenWarnings = warnings.filter((w) => /single-use tokens/.test(w));
  assert.equal(tokenWarnings.length, 1);
  assert.ok(!tokenWarnings[0].includes('test-key'), 'the warning does not show the key');
  assert.deepEqual(errors, []);
  await page.click('#toggle');
  await close();
});

test('an API key refused when asking for a token stops the session with a message', async () => {
  const { page, close } = await openApp('', { apiKey: 'bad-key' });
  const gemini = await mockGemini(page, [], {
    tokens: 400,
    tokenError: 'API key not valid. Please pass a valid API key.',
  });
  await page.click('#toggle');
  await page.waitForFunction(() => !document.getElementById('toast').hidden);
  assert.match(await page.textContent('#toast'), /API key not valid/);
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.deepEqual(gemini.sockets, []);
  await close();
});
