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
import { availableLocales } from '../src/i18n.js';

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
async function open({ width = 1280, height = 800, scheme = 'light', uiLang = 'en', phone = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    isMobile: phone,
    hasTouch: phone,
    locale: 'en-US',
  });
  await context.addInitScript(
    (settings) => {
      if (!sessionStorage.getItem('seeded')) localStorage.setItem('rt-settings', JSON.stringify(settings));
      sessionStorage.setItem('seeded', '1');
    },
    { uiLang },
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
async function summarize(page) {
  await page.click('#summarize');
  await page.waitForFunction(() => document.querySelector('#summaryContent h3'), null, { timeout: 10_000 });
}
async function listen(page) {
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length >= 3, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

for (const scheme of ['light', 'dark']) {
  if (wanted(`desktop-${scheme}`) || wanted(`settings-${scheme}`) || wanted(`export-${scheme}`)) {
    const { page, close } = await open({ scheme });
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
    if (wanted(`settings-${scheme}`)) await shot(page, `settings-${scheme}`);
    await page.keyboard.press('Escape');
    await page.click('#export');
    if (wanted(`export-${scheme}`)) await shot(page, `export-${scheme}`);
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
