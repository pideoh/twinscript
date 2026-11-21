// Shared setup for the browser tests. Each *.e2e.js file calls setup() to get its own static
// server (random port) and its own Chrome, so Node's test runner can run the files in parallel.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
    page.on('pageerror', (e) => errors.push(e.message));
    // A blocked script, style or request shows up as a console error; treat it like a page error.
    page.on('console', (m) => {
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

// Mocks both Gemini endpoints. `script` is a list of [audioChunkNumber, 'interim' | 'final', text].
export async function mockGemini(page, script) {
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
  return {
    restart: () => {
      chunks = 0;
    },
  };
}
// Mocks the summary request (the one whose prompt holds a <transcript>), leaving translation
// requests to mockGemini. `respond(request)` returns { status, body } where body is the model's
// JSON text for a 200, or the raw error body otherwise. Returns the requests seen.
export async function mockSummary(page, respond) {
  const requests = [];
  await page.route(/streamGenerateContent/, async (route) => {
    const request = route.request().postDataJSON();
    if (!request.contents[0].parts[0].text.startsWith('<transcript>')) return route.fallback();
    requests.push(request);
    const { status = 200, body } = await respond(request);
    if (status !== 200) return route.fulfill({ status, contentType: 'application/json', body });
    const sse = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  return requests;
}
export const translated = (page, count) =>
  page.waitForFunction(
    (n) =>
      document.querySelectorAll('.seg:not(.live)').length === n &&
      [...document.querySelectorAll('.seg:not(.live) .tgt')].every((el) => el.textContent.startsWith('訳:')),
    count,
  );
export const saved = (page) => page.waitForTimeout(500); // saves are debounced by 250 ms

// Stands in for sharing PC audio: getDisplayMedia gives a 440 Hz tone at `amplitude`, and the
// constraints the page asked for are kept in window.displayMediaCalls. `desktopApp` ('mac' or
// 'win') makes the page see the desktop app's user agent. `endAfterMs` ends the audio track on its
// own after that long, which is what the macOS app sees without the "System Audio Recording" permission.
export function fakeDisplayMedia({ amplitude = 0.5, endAfterMs, desktopApp } = {}) {
  if (window !== top) return;
  const AGENTS = {
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) twinscript/1.0.0 Chrome/140.0.0.0 Electron/45.4.1 Safari/537.36',
    win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) twinscript/1.0.0 Chrome/140.0.0.0 Electron/45.4.1 Safari/537.36',
  };
  if (desktopApp) Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => AGENTS[desktopApp] });
  window.displayMediaCalls = [];
  navigator.mediaDevices.getDisplayMedia = async (constraints) => {
    window.displayMediaCalls.push(constraints);
    const ctx = new AudioContext();
    const out = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    level.gain.value = amplitude;
    tone.connect(level).connect(out);
    tone.start();
    const [track] = out.stream.getAudioTracks();
    if (endAfterMs !== undefined) {
      setTimeout(() => {
        track.stop(); // stopping it here does not fire 'ended', so that is done by hand
        track.dispatchEvent(new Event('ended'));
      }, endAfterMs);
    }
    return new MediaStream([track]);
  };
}
