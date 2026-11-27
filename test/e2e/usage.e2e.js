// Browser tests: what each session used of the API, the totals, and the cost estimates.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listening, mockGemini, reload, saved, setup, showTab, translated } from './helpers.js';

const { openApp } = setup();

const LITE = 'gemini-3.5-flash-lite';
// Each mocked translation uses 1,000 tokens in and 200 out (150 + 50 thinking): at $0.30 and $2.50
// per 1M tokens, $0.0008.

// The cells of each row of a table body in the usage dialog.
const cells = (page, tbody) =>
  page
    .locator(`#${tbody} tr`)
    .evaluateAll((rows) => rows.map((r) => [...r.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim())));
async function openUsage(page) {
  await page.click('#openUsage');
  await page.waitForSelector('#usageDialog[open]');
}
const closeUsage = (page) => page.click('#usageDialog .dialog-footer button');

async function talk(page, lines) {
  await mockGemini(
    page,
    lines.map((text, i) => [3 + 2 * i, 'final', text]),
  );
  await page.click('#toggle');
  await translated(page, lines.length);
  await page.click('#toggle');
  await saved(page);
}
// The dialog's close event, which stores the settings, comes in a task of its own after the click.
async function saveSettings(page) {
  await page.click('#settings button[value=ok]');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
}
const priceInput = (model, field) => `#priceFields input[data-model="${model}"][data-field="${field}"]`;

test('a session shows its requests, tokens and estimated cost, and the totals keep them after it is deleted', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await talk(page, ['One is done.', 'Two is done.']);

  await openUsage(page);
  const session = await cells(page, 'usageSession');
  assert.equal(session.length, 5);
  const [listening, translation, summary, speakers, total] = session;
  assert.equal(listening[0], 'ライブ文字起こし');
  assert.match(listening[1], /^0:00:\d\d$/);
  assert.match(listening[5], /^\$0\.\d+$/);
  assert.deepEqual(translation, ['翻訳', '', '2', '2,000', '400', '$0.0016']);
  assert.deepEqual(summary, ['要約', '', '0', '0', '0', '$0.00']);
  assert.deepEqual(speakers, ['話者の識別', '', '0', '0', '0', '$0.00']);
  assert.deepEqual(total.slice(0, 5), ['合計', listening[1], '2', '2,000', '400']);
  assert.match(total[5], /^\$0\.\d+$/);
  assert.ok(await page.isHidden('#usageSessionNote'));
  assert.ok(await page.isHidden('#usageUnpriced'));

  const totals = await cells(page, 'usageTotals');
  assert.deepEqual(
    totals.map((r) => [r[0], r[2], r[3], r[4]]),
    [
      ['今日', '2', '2,000', '400'],
      ['今月', '2', '2,000', '400'],
      ['先月', '0', '0', '0'],
      ['記録したすべて', '2', '2,000', '400'],
    ],
  );
  assert.equal(totals[0][5], total[5], "today's cost is the session's");

  const sessions = await cells(page, 'usageSessions');
  assert.equal(sessions.length, 1);
  assert.match(sessions[0][0], /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(sessions[0].slice(1), ['One is done.', listening[1], total[5]]);
  assert.match(await page.textContent('#usageNote'), /推定/);
  assert.equal(await page.getAttribute('#usageDialog a', 'href'), 'https://ai.google.dev/gemini-api/docs/pricing');
  await closeUsage(page);

  // A summary is counted as a summary request of the same session.
  await page.unroute(/streamGenerateContent/);
  await page.route(/streamGenerateContent/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: '## Overview\n\nDone.' }] } }],
        usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 800 },
      })}\n\n`,
    }),
  );
  await showTab(page, 'summary');
  await page.click('#summarize');
  await page.waitForFunction(() => document.querySelector('#summaryContent h2, #summaryContent h3'));
  await openUsage(page);
  assert.deepEqual((await cells(page, 'usageSession'))[2], ['要約', '', '1', '5,000', '800', '$0.0035']);
  assert.equal((await cells(page, 'usageTotals'))[0][2], '3');
  await closeUsage(page);

  // Deleting the session keeps what it used in the totals.
  page.once('dialog', (d) => d.accept());
  await page.locator('#sessionList .session').first().locator('.act').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 0);
  await reload(page);
  await openUsage(page);
  const after = await cells(page, 'usageTotals');
  assert.deepEqual(
    after.map((r) => [r[0], r[2], r[3], r[4]]),
    [
      ['今日', '3', '7,000', '1,200'],
      ['今月', '3', '7,000', '1,200'],
      ['先月', '0', '0', '0'],
      ['記録したすべて', '3', '7,000', '1,200'],
    ],
  );
  assert.deepEqual(await cells(page, 'usageSessions'), [['保存されたセッションはありません']]);
  assert.deepEqual(errors, []);
  await close();
});

test('with the usage dialog open while listening, listening time is counted once', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await mockGemini(page, [[20, 'final', 'One is done.']]);
  const started = Date.now();
  await page.click('#toggle');
  await listening(page);
  await openUsage(page);
  await translated(page, 1); // a request is recorded while the dialog is open
  await closeUsage(page);
  await openUsage(page);
  const seconds = (duration) => duration.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  const [session] = await cells(page, 'usageSession');
  const [today] = await cells(page, 'usageTotals');
  const elapsed = Date.now() - started;
  for (const shown of [session[1], today[1]]) {
    assert.ok(seconds(shown) * 1000 <= elapsed, `${shown} listened in ${elapsed} ms`);
  }
  assert.deepEqual(errors, []);
  await close();
});

test('a session saved before usage was counted shows "not recorded"', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await talk(page, ['An old meeting.']);
  // As an earlier version stored it: no usage record.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const tx = open.result.transaction('sessions', 'readwrite');
          const sessions = tx.objectStore('sessions');
          sessions.getAll().onsuccess = (e) => {
            for (const sess of e.target.result) {
              delete sess.usage;
              sessions.put(sess);
            }
          };
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  await openUsage(page);
  const [row] = await cells(page, 'usageSessions');
  assert.deepEqual(row.slice(1), ['An old meeting.', '記録なし']);
  assert.match(await page.textContent('#usageSessionNote'), /^記録なし/);
  assert.ok(await page.isHidden('#usageSessionWrap'), 'no zeros for a session that was not counted');
  assert.equal((await cells(page, 'usageTotals'))[0][2], '1', 'the totals were counted all the same');
  assert.deepEqual(errors, []);
  await close();
});

test('changed prices change the amounts, Reset restores them, and invalid prices are refused', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await talk(page, ['One is done.']);
  await openUsage(page);
  assert.equal((await cells(page, 'usageSession'))[1][5], '$0.0008');
  await closeUsage(page);

  await page.click('#openSettings');
  assert.equal(await page.inputValue(priceInput(LITE, 'input')), '0.3');
  assert.equal(await page.inputValue(priceInput(LITE, 'output')), '2.5');
  assert.equal(await page.inputValue(priceInput('gemini-3.5-transcribe-live', 'inputPerMinute')), '0.005');
  await page.fill(priceInput(LITE, 'input'), '3');
  assert.ok(await page.isHidden('#pricesError'));
  await saveSettings(page);
  await openUsage(page);
  assert.equal((await cells(page, 'usageSession'))[1][5], '$0.0035'); // (1,000 x 3 + 200 x 2.5) / 1M
  assert.equal((await cells(page, 'usageTotals'))[0][5], (await cells(page, 'usageSession'))[4][5]);
  assert.match(await page.textContent('#usageNote'), /設定で変更/);
  await closeUsage(page);

  // Not a price: shown at once, and the prices saved before are kept.
  await page.click('#openSettings');
  assert.equal(await page.inputValue(priceInput(LITE, 'input')), '3');
  await page.fill(priceInput(LITE, 'output'), '-1');
  await page.waitForSelector('#pricesError:not([hidden])');
  assert.equal(await page.getAttribute(priceInput(LITE, 'output'), 'aria-invalid'), 'true');
  await page.fill(priceInput(LITE, 'output'), 'abc');
  assert.ok(await page.isVisible('#pricesError'));
  await saveSettings(page);
  await openUsage(page);
  assert.equal((await cells(page, 'usageSession'))[1][5], '$0.0035');
  await closeUsage(page);

  // Reset to the listed prices.
  await page.click('#openSettings');
  await page.click('#pricesReset');
  assert.equal(await page.inputValue(priceInput(LITE, 'input')), '0.3');
  assert.equal(await page.inputValue(priceInput(LITE, 'output')), '2.5');
  assert.ok(await page.isHidden('#pricesError'));
  await saveSettings(page);
  await reload(page);
  await openUsage(page);
  assert.equal((await cells(page, 'usageSession'))[1][5], '$0.0008');
  assert.doesNotMatch(await page.textContent('#usageNote'), /設定で変更/);
  assert.deepEqual(errors, []);
  await close();
});

test('a translation model without a price shows "no price" until one is added', async () => {
  const { page, errors, close } = await openApp('', {
    apiKey: 'test-key',
    interimTranslate: false,
    translateModel: 'my-model',
  });
  await talk(page, ['One is done.']);
  await openUsage(page);
  const [listening, translation, , , total] = await cells(page, 'usageSession');
  assert.deepEqual(translation, ['翻訳', '', '1', '1,000', '200', '価格なし']);
  assert.equal(total[5], listening[5], 'the total leaves the unpriced usage out');
  assert.match(await page.textContent('#usageUnpriced'), /my-model.*金額には含めていません/);
  await closeUsage(page);

  await page.click('#openSettings');
  assert.equal(await page.inputValue(priceInput('my-model', 'input')), '');
  assert.match(await page.textContent('#priceFields'), /このモデルの価格は記載されていません/);
  await page.fill(priceInput('my-model', 'input'), '1');
  await page.fill(priceInput('my-model', 'output'), '2');
  await saveSettings(page);
  await openUsage(page);
  assert.equal((await cells(page, 'usageSession'))[1][5], '$0.0014'); // (1,000 x 1 + 200 x 2) / 1M
  assert.ok(await page.isHidden('#usageUnpriced'));
  assert.deepEqual(errors, []);
  await close();
});

test('the demo shows made-up usage for its session and never counts it in the totals', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg:not(.live)').length >= 1, null, {
    timeout: 30_000,
  });
  await page.click('#toggle');
  await saved(page);
  await openUsage(page);
  const [, translation] = await cells(page, 'usageSession');
  assert.ok(Number(translation[2]) > 0, 'the demo reports translation requests');
  assert.match(translation[5], /^\$/);
  assert.match(await page.textContent('#usageSessionNote'), /デモ/);
  for (const row of await cells(page, 'usageTotals')) assert.deepEqual(row.slice(1, 5), ['0:00:00', '0', '0', '0']);
  const [session] = await cells(page, 'usageSessions');
  assert.match(session[1], /デモ$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('rt-usage')), null);
  assert.deepEqual(errors, []);
  await close();
});
