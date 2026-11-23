// Shared setup for the browser tests: each *.e2e.js file calls setup() to get its own static
// server (random port) and its own Chrome, so Node's test runner can run the files in parallel.
// Also the small readers every file uses (ready, reload, rows, saved, listening, ...).

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { grantToken, TOKEN_ENDPOINT } from './gemini.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Registers before/after hooks and returns { openApp } bound to this file's server and browser.
export function setup() {
  let server, browser, origin;

  before(async () => {
    server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      try {
        const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      channel: process.env.PW_CHANNEL || 'chrome',
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    });
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  // The UI is Japanese unless the test says otherwise (most assertions read Japanese text).
  // Settings are seeded on the first load of the tab only, so what the app saves survives a reload.
  // An `apiKey` goes into the settings the way older versions stored it, which the app moves into
  // memory and removes from storage (in a browser the key lasts only as long as the page). So it is
  // put back on every load, as if the user entered the key again after each reload.
  // `colorScheme` ('light' or 'dark') is what the page sees as prefers-color-scheme.
  async function openApp(query = '', settings, init, { locale = 'en-US', colorScheme = 'light' } = {}) {
    const context = await browser.newContext({ permissions: ['microphone'], locale, colorScheme });
    const page = await context.newPage();
    const errors = [];
    const messages = [];
    diagnostics.set(page, { messages, keys: [...MASKED_KEYS, settings?.apiKey].filter(Boolean) });
    page.on('pageerror', (e) => {
      errors.push(e.message);
      messages.push(`pageerror: ${e.message}`);
    });
    // A blocked script, style or request shows up as a console error; treat it like a page error.
    page.on('console', (m) => {
      messages.push(`${m.type()}: ${m.text()}`);
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text());
    });
    const stored = { uiLang: 'ja', ...settings };
    await context.addInitScript((s) => {
      try {
        if (window !== top) return;
        if (!sessionStorage.getItem('e2e-seeded')) {
          sessionStorage.setItem('e2e-seeded', '1');
          localStorage.setItem('rt-settings', JSON.stringify(s));
        } else if (s.apiKey !== undefined) {
          const saved = JSON.parse(localStorage.getItem('rt-settings') || '{}');
          localStorage.setItem('rt-settings', JSON.stringify({ ...saved, apiKey: s.apiKey }));
        }
      } catch {
        /* a frame without storage */
      }
    }, stored);
    if (init) await context.addInitScript(init.script, init.arg);
    // Every live connection first asks for a single-use token; tests that mock the WebSocket
    // themselves get one here (mockGemini's own answer takes precedence).
    await context.route(TOKEN_ENDPOINT, grantToken);
    await page.goto(`${origin}/${query}`);
    await ready(page);
    return { page, errors, close: () => context.close() };
  }

  return { openApp };
}

// The page starts asynchronously (stored key and sessions are loaded first); its buttons work
// once the handlers are attached.
export const ready = (page) =>
  page.waitForFunction(() => typeof document.getElementById('toggle')?.onclick === 'function');
export async function reload(page) {
  await page.reload();
  await ready(page);
}

export const rows = (page) =>
  page.locator('.seg').evaluateAll((nodes) =>
    nodes.map((n) => ({
      live: n.classList.contains('live'),
      src: n.querySelector('.src').textContent,
      tgt: n.querySelector('.tgt').textContent,
    })),
  );
export const sessionNames = (page) => page.locator('#sessionList .name').allTextContents();

export const saved = (page) => page.waitForTimeout(500); // saves are debounced by 250 ms

// What each page has logged (console messages and page errors), kept for the error of `listening`.
const diagnostics = new WeakMap();
const MASKED_KEYS = ['test-key'];
const LAST_MESSAGES = 15;

// Waits for the status to read 聞き取り中. When that times out, the error says what the page showed
// instead (status, toast, main button, settings dialog, last console messages), with API keys masked.
export async function listening(page) {
  try {
    await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  } catch (error) {
    const { messages = [], keys = MASKED_KEYS } = diagnostics.get(page) ?? {};
    const mask = (text) => keys.reduce((out, key) => out.split(key).join('***'), String(text));
    const shown = await page
      .evaluate(() => {
        const toast = document.getElementById('toast');
        return {
          status: document.getElementById('statusText')?.textContent,
          toast: toast && !toast.hidden ? toast.textContent : '',
          button: document.getElementById('toggle')?.textContent,
          settingsOpen: !!document.getElementById('settings')?.open,
        };
      })
      .catch((e) => ({ unavailable: e.message }));
    const lines = [
      'Timed out waiting for the status 聞き取り中. The page showed:',
      ...Object.entries(shown).map(([name, value]) => `  ${name}: ${JSON.stringify(value)}`),
      `  last ${Math.min(messages.length, LAST_MESSAGES)} console messages and page errors:`,
      ...messages.slice(-LAST_MESSAGES).map((m) => `    ${m}`),
    ];
    throw new Error(mask(lines.join('\n')), { cause: error });
  }
}
