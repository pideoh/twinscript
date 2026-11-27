// Captures the app in its main states so a visual change can be reviewed:
// desktop and phone, light and dark, and the dialogs in every display language.
//
//   node scripts/screenshots.mjs <out-dir> [filter]     e.g. node scripts/screenshots.mjs /tmp/shots settings
//
// Uses the demo mode (?mock=1), so no API key or microphone is needed. Needs Chrome
// (set PW_CHANNEL to use another installed browser).

import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { availableLocales } from '../src/ui/i18n.js';
import { addListening, addTokens, emptyUsage } from '../src/usage/usage.js';
import { addToDaily, DAILY_KEY, emptyDaily, LIVE_MODEL } from '../src/usage/usage-stats.js';

const [out, filter] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/screenshots.mjs <out-dir> [filter]');
  process.exit(1);
}
await mkdir(out, { recursive: true });

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    res
      .writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome' });

const wanted = (name) => !filter || name.includes(filter);
async function open({
  width = 1280,
  height = 800,
  scheme = 'light',
  uiLang = 'en',
  phone = false,
  langC = '',
  usage = null, // daily usage totals to start with (the demo itself is never counted in them)
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    isMobile: phone,
    hasTouch: phone,
    locale: 'en-US',
  });
  await context.addInitScript(
    ({ settings, usage, usageKey }) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('rt-settings', JSON.stringify(settings));
        if (usage) localStorage.setItem(usageKey, JSON.stringify(usage));
      }
      sessionStorage.setItem('seeded', '1');
    },
    { settings: { uiLang, langC }, usage, usageKey: DAILY_KEY },
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${origin}/?mock=1`);
  return { page, close: () => context.close() };
}
const shot = async (page, name) => {
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(name);
};
// Opens the Summary tab and makes a summary.
async function summarize(page) {
  await page.click('#tabSummary');
  await page.click('#summarize');
  await page.waitForFunction(
    () =>
      document.getElementById('summarize').getAttribute('aria-busy') === 'false' &&
      document.querySelector('#summaryContent h3, #summaryContent li'),
    null,
    { timeout: 10_000 },
  );
}
const part = async (page, selector, name) => {
  await page.locator(selector).screenshot({ path: join(out, `${name}.png`) });
  console.log(name);
};
async function listen(page) {
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length >= 3, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

for (const scheme of ['light', 'dark']) {
  if (wanted(`desktop-${scheme}`) || wanted(`settings-${scheme}`) || wanted(`export-${scheme}`)) {
    const { page, close } = await open({ scheme });
    if (wanted(`desktop-${scheme}`)) {
      await page.click('#tabSummary');
      await shot(page, `desktop-${scheme}-summary-empty`);
      await page.click('#tabTranscript');
    }
    await listen(page);
    if (wanted(`desktop-${scheme}`)) await shot(page, `desktop-${scheme}-listening`);
    await page.click('#toggle');
    await page.waitForTimeout(400);
    if (wanted(`desktop-${scheme}`)) await shot(page, `desktop-${scheme}-stopped`);
    if (wanted(`desktop-${scheme}`)) {
      await summarize(page);
      await shot(page, `desktop-${scheme}-summary`);
    }
    await page.click('#openSettings');
    if (wanted(`settings-${scheme}`)) {
      await shot(page, `settings-${scheme}`);
      await page.locator('#settings .settings-group:not([hidden])').last().scrollIntoViewIfNeeded();
      await shot(page, `settings-${scheme}-captions`);
    }
    await page.keyboard.press('Escape');
    await page.click('#export');
    if (wanted(`export-${scheme}`)) await shot(page, `export-${scheme}`);
    await close();
  }
  if (wanted(`captions-${scheme}`)) {
    const { page, close } = await open({ scheme });
    await page.evaluate(() => {
      document.getElementById('captionContent').value = 'tgt';
      document.getElementById('captionContent').dispatchEvent(new Event('change'));
    });
    await listen(page);
    await shot(page, `captions-${scheme}-translation-only`);
    await page.click('#toggle');
    await close();
  }
  if (wanted(`phone-${scheme}`)) {
    const { page, close } = await open({ scheme, width: 390, height: 844, phone: true });
    await listen(page);
    await shot(page, `phone-${scheme}-listening`);
    await page.click('#toggle');
    await summarize(page);
    await shot(page, `phone-${scheme}-summary`);
    await page.click('#menu');
    await page.waitForTimeout(300);
    await shot(page, `phone-${scheme}-drawer`);
    await close();
  }
}

// A third language (Japanese UI): the header with its third select, tagged translations.
for (const scheme of ['light', 'dark']) {
  for (const [name, size] of [
    ['', {}],
    ['-phone', { width: 390, height: 844, phone: true }],
  ]) {
    if (!wanted(`three-${scheme}${name}`)) continue;
    const { page, close } = await open({ scheme, uiLang: 'ja', langC: 'cmn-Hans-CN', ...size });
    await shot(page, `three-${scheme}${name}-idle`);
    await page.locator('header.bar').screenshot({ path: join(out, `three-${scheme}${name}-header.png`) });
    console.log(`three-${scheme}${name}-header`);
    await listen(page);
    await shot(page, `three-${scheme}${name}-listening`);
    await page.click('#toggle');
    await page.waitForTimeout(400);
    await shot(page, `three-${scheme}${name}-stopped`);
    await close();
  }
}

// Summaries (Japanese UI): the bar, a summary with a table, the history and the template editor.
for (const scheme of ['light', 'dark']) {
  if (!wanted(`summary-${scheme}`)) continue;
  const { page, close } = await open({ scheme, uiLang: 'ja' });
  await listen(page);
  await page.click('#toggle');
  await page.waitForTimeout(400);
  await page.click('#tabSummary');
  await part(page, '#summary', `summary-${scheme}-bar`);
  await summarize(page);
  await page.selectOption('#summaryTemplate', 'preset:minutes');
  await summarize(page);
  await page.locator('#summaryContent table').scrollIntoViewIfNeeded();
  await shot(page, `summary-${scheme}-table`);
  await part(page, '#summaryBody', `summary-${scheme}-panel`);
  await part(page, '#summaryHistoryBar', `summary-${scheme}-history`);
  await page.click('#openSettings');
  await page.click('#templateList li:nth-child(3) button');
  await page.waitForTimeout(300);
  await shot(page, `summary-${scheme}-editor`);
  await page.click('#templateCancel');
  await page.locator('#templateList').scrollIntoViewIfNeeded();
  await shot(page, `summary-${scheme}-templates`);
  await close();
}

// Questions (English and Japanese UI, desktop and phone): the empty tab, an answer streaming in, a
// conversation, and a failed question. The failure needs a real request, so the demo session is
// opened again without the demo, with a made-up key, and the request is answered with a rate limit.
async function askDemo(page, question) {
  await page.fill('#question', question);
  await page.click('#ask');
}
const answerDone = (page, count) =>
  page.waitForFunction(
    (n) => document.querySelectorAll('#questionsList .turn').length === n && document.getElementById('askStop').hidden,
    count,
    { timeout: 10_000 },
  );
for (const scheme of ['light', 'dark']) {
  for (const uiLang of ['en', 'ja']) {
    for (const [name, size] of [
      ['', {}],
      ['-phone', { width: 390, height: 844, phone: true }],
    ]) {
      const prefix = `questions-${scheme}-${uiLang}${name}`;
      if (!wanted(prefix)) continue;
      const { page, close } = await open({ scheme, uiLang, ...size });
      await page.click('#tabQuestions');
      await shot(page, `${prefix}-empty`);
      await page.click('#tabTranscript');
      await listen(page);
      await page.click('#toggle');
      await page.waitForTimeout(400);
      await page.click('#tabQuestions');
      await shot(page, `${prefix}-ready`);
      const [first, second] =
        uiLang === 'ja'
          ? ['負荷テストはどうなっていますか？', 'レポートはいつ出ますか？']
          : ['How is load testing going?', 'When is the report due?'];
      await askDemo(page, first);
      await page.waitForFunction(
        () => document.querySelector('#questionsList .turn .markdown')?.textContent.length > 30,
      );
      await shot(page, `${prefix}-streaming`);
      await answerDone(page, 1);
      await askDemo(page, second);
      await answerDone(page, 2);
      await page.waitForTimeout(200);
      await shot(page, `${prefix}-conversation`);
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('rt-settings') || '{}');
        localStorage.setItem('rt-settings', JSON.stringify({ ...settings, apiKey: 'screenshot' }));
      });
      await page.route(/streamGenerateContent/, (route) =>
        route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }),
      );
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => typeof document.getElementById('toggle')?.onclick === 'function');
      await page.click('#tabQuestions');
      await askDemo(page, uiLang === 'ja' ? '誰がレポートを書きますか？' : 'Who writes the report?');
      await page.waitForSelector('#questionsList .turn-error');
      await page.waitForTimeout(200);
      await shot(page, `${prefix}-error`);
      await close();
    }
  }
}

// Usage and cost (Japanese UI): the dialog after a demo session, with made-up totals of earlier days,
// and the prices in the settings.
function sampleTotals() {
  const now = new Date();
  const day = (back) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12).getTime();
  const meeting = (minutes, requests, summaries = 0) => {
    let usage = addListening(emptyUsage(), LIVE_MODEL, minutes * 60_000);
    for (let i = 0; i < requests; i++)
      usage = addTokens(usage, 'translation', 'gemini-3.5-flash-lite', {
        promptTokenCount: 420,
        candidatesTokenCount: 38,
      });
    for (let i = 0; i < summaries; i++)
      usage = addTokens(usage, 'summary', 'gemini-3.5-flash-lite', {
        promptTokenCount: 9000,
        candidatesTokenCount: 900,
      });
    return usage;
  };
  let daily = emptyDaily();
  for (const [back, minutes, requests, summaries] of [
    [0, 42, 610, 1],
    [1, 55, 790, 2],
    [6, 30, 420, 0],
    [35, 60, 880, 1],
    [70, 25, 300, 1],
  ])
    daily = addToDaily(daily, meeting(minutes, requests, summaries), day(back));
  return daily;
}
for (const scheme of ['light', 'dark']) {
  for (const [name, size] of [
    ['', {}],
    ['-phone', { width: 390, height: 844, phone: true }],
  ]) {
    if (!wanted(`usage-${scheme}${name}`)) continue;
    const { page, close } = await open({ scheme, uiLang: 'ja', usage: sampleTotals(), ...size });
    await listen(page);
    await page.click('#toggle');
    await page.waitForTimeout(400);
    await summarize(page);
    await page.click('#openUsage');
    await page.waitForTimeout(200);
    await shot(page, `usage-${scheme}${name}-dialog`);
    await page.locator('#usageDialog .dialog-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await shot(page, `usage-${scheme}${name}-dialog-end`);
    await page.keyboard.press('Escape');
    await page.click('#openSettings');
    await page.locator('#pricesGroup').scrollIntoViewIfNeeded();
    await shot(page, `usage-${scheme}${name}-prices`);
    await close();
  }
}

// Longer or wider text in another language is where layouts break first.
for (const uiLang of availableLocales().map((l) => l.id ?? l)) {
  if (uiLang === 'en' || !wanted(`lang-${uiLang}`)) continue;
  const { page, close } = await open({ uiLang });
  await shot(page, `lang-${uiLang}-main`);
  await page.click('#openSettings');
  await shot(page, `lang-${uiLang}-settings`);
  await close();
}

await browser.close();
server.close();
