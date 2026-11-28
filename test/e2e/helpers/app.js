// Shared setup for the browser tests: each *.e2e.js file calls setup() to get its own static
// server (random port) and its own Chrome, so Node's test runner can run the files in parallel.
// Also the small readers every file uses (ready, reload, rows, saved, listening, ...).
// With E2E_TARGET=desktop each page is the desktop app's window instead (see desktop.js), with the
// same routes, init scripts and readers; no server or Chrome is started then.
//
// With E2E_COVERAGE=<directory>, each page openApp opens records Chrome's JavaScript coverage (block
// level) and writes the part for the app's scripts (under /src/) to that directory as one JSON file,
// when the page or its context is closed or when the file's browser closes. scripts/e2e-coverage.mjs
// turns the files into a report. Without the variable no coverage is recorded.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, afterEach, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { standInInstaller } from './bridge.js';
import { DESKTOP, DESKTOP_ORIGIN, launchDesktop } from './desktop.js';
import { grantToken, TOKEN_ENDPOINT } from './gemini.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const COVERAGE_DIR = process.env.E2E_COVERAGE ? resolve(process.env.E2E_COVERAGE) : null;
const recording = new Map(); // page -> the origin of its server, while its coverage is recorded

async function startCoverage(page, closers, origin) {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  recording.set(page, origin);
  // Coverage can only be read from an open page, so closing it (or its context) writes it first.
  for (const target of closers) {
    const close = target.close.bind(target);
    target.close = async (...args) => {
      await writeCoverage(page);
      return close(...args);
    };
  }
}

async function writeCoverage(page) {
  const origin = recording.get(page);
  if (!origin) return;
  recording.delete(page);
  let entries;
  try {
    entries = await page.coverage.stopJSCoverage();
  } catch {
    return; // the page is gone already (it crashed or the browser closed)
  }
  const result = entries
    .filter((e) => e.url.startsWith(`${origin}/src/`))
    .map(({ scriptId, url, functions }) => ({ scriptId, url, functions }));
  await mkdir(COVERAGE_DIR, { recursive: true });
  await writeFile(join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify({ result }));
}

// Registers before/after hooks and returns { openApp } bound to this file's server and browser.
export function setup() {
  let server, browser, origin;
  // Desktop apps still open. Each is quit when its test ends, so a file does not keep one app per
  // test running (a Chrome context left open costs little; an app is a set of processes).
  const apps = new Set();

  before(async () => {
    if (DESKTOP) {
      origin = DESKTOP_ORIGIN;
      return;
    }
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
    await Promise.all([...recording.keys()].map(writeCoverage));
    await Promise.all([...apps].map((app) => app.close()));
    await browser?.close();
    server?.close();
  });
  afterEach(() => Promise.all([...apps].map((app) => app.close())));

  // The UI is Japanese unless the test says otherwise (most assertions read Japanese text).
  // Settings are seeded on the first load of the tab only, so what the app saves survives a reload.
  // An `apiKey` goes into the settings the way older versions stored it, which the app moves into
  // memory and removes from storage (in a browser the key lasts only as long as the page). So it is
  // put back on every load, as if the user entered the key again after each reload.
  // `colorScheme` ('light' or 'dark') is what the page sees as prefers-color-scheme.
  async function openApp(query = '', settings, init, { locale = 'en-US', colorScheme = 'light' } = {}) {
    let context, page, closer;
    if (DESKTOP) {
      const app = await launchDesktop({ locale, colorScheme });
      ({ context, page } = app);
      closer = { close: () => app.close().finally(() => apps.delete(closer)) };
      apps.add(closer);
    } else {
      context = await browser.newContext({ permissions: ['microphone'], locale, colorScheme });
      page = await context.newPage();
      closer = context;
    }
    if (COVERAGE_DIR) await startCoverage(page, [page, closer], origin);
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
    await context.addInitScript(standInInstaller.script, standInInstaller.arg);
    if (init) await context.addInitScript(init.script, init.arg);
    // Every live connection first asks for a single-use token; tests that mock the WebSocket
    // themselves get one here (mockGemini's own answer takes precedence).
    await context.route(TOKEN_ENDPOINT, grantToken);
    await page.goto(`${origin}/${query}`);
    await ready(page);
    return { page, errors, close: () => closer.close() };
  }

  return { openApp };
}

// The page starts asynchronously (stored key and sessions are loaded first); it is ready once its
// handlers are attached and the saved sessions are shown, which enables the controls that act on the
// current session (#export is one; src/ui/elements.js lists them).
export const ready = (page) =>
  page.waitForFunction(
    () =>
      typeof document.getElementById('toggle')?.onclick === 'function' && !document.getElementById('export').disabled,
  );
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

// Waits until what was changed before the call is written to IndexedDB, however slow the machine.
// The app writes 250 ms after the last change (src/session/session-save.js): a timer of the page set
// for longer, now, fires after the app's own timer has, since a page's timers fire in order of their
// time. The writes then queued (saves, a deleted session, recorded audio) finish before a read-write
// transaction over the same stores that is begun after them can start, so once that one completes,
// they are on disk.
export async function saved(page) {
  const done = page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          const open = indexedDB.open('twinscript');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            // The app has opened its database by the time it is ready (`ready`), so the stores exist.
            const tx = db.transaction([...db.objectStoreNames], 'readwrite');
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = tx.onabort = () => reject(tx.error);
          };
        }, 300);
      }),
  );
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('the pending saves were not written within 10 s')), 10_000).unref(),
  );
  await Promise.race([done, timeout]);
}

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
