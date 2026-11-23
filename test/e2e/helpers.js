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

const TOKEN_ENDPOINT = /generativelanguage\.googleapis\.com\/v1beta\/auth_tokens/;
let tokensIssued = 0;
const grantToken = (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ name: `auth_tokens/e2e-${++tokensIssued}` }),
  });

// What every mocked translation reports as used, in the last (here the only) chunk of its answer.
export const MOCK_USAGE = { promptTokenCount: 1000, candidatesTokenCount: 150, thoughtsTokenCount: 50 };

// Mocks the Gemini endpoints: the live transcription (WebSocket), its token request and translation.
// `script` is a list of [audioChunkNumber, 'interim' | 'final', text]. `tokens` is how the token
// request is answered: 'grant', 'unreachable' (a network failure) or an HTTP status with
// `tokenError` as the error message. Returns the token requests and the WebSocket addresses seen.
// Each translation answers with MOCK_USAGE as its usageMetadata.
export async function mockGemini(page, script, { tokens = 'grant', tokenError = '' } = {}) {
  let chunks = 0;
  const tokenRequests = [];
  const sockets = [];
  await page.route(TOKEN_ENDPOINT, (route) => {
    const request = route.request();
    tokenRequests.push({ url: request.url(), headers: request.headers(), body: request.postData() });
    if (tokens === 'grant') return grantToken(route);
    if (tokens === 'unreachable') return route.abort('failed');
    return route.fulfill({
      status: tokens,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: tokens, message: tokenError } }),
    });
  });
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    sockets.push(ws.url());
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
    const chunk = { candidates: [{ content: { parts: [{ text: `訳:${text}` }] } }], usageMetadata: MOCK_USAGE };
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\n\n` });
  });
  return {
    restart: () => {
      chunks = 0;
    },
    tokenRequests,
    sockets,
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
// Used with a third language, or with two and a sentence in neither of them.
// Translation requests that name their target answer "[Target] text"; a request that asks which
// language a sentence is in answers with `identified`. Returns the identify requests seen.
export async function mockTargets(page, identified = 'Japanese') {
  const identify = [];
  await page.route(/streamGenerateContent/, (route) => {
    const request = route.request().postDataJSON();
    const text = request.contents[0].parts[0].text.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    let answer;
    if (request.generationConfig.responseJsonSchema) {
      identify.push({ text, request });
      answer = JSON.stringify({ language: identified });
    } else {
      const into = request.systemInstruction.parts[0].text.match(/Translate it into ([^.]+)\./)?.[1] ?? '?';
      answer = `[${into}] ${text}`;
    }
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] })}\n\n`;
    route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return identify;
}

// Each finished row: its source and its translation lines as [tag, text].
export const tagged = (page) =>
  page.locator('.seg:not(.live)').evaluateAll((nodes) =>
    nodes.map((n) => ({
      src: n.querySelector('.src').textContent,
      lines: [...n.querySelectorAll('.tgt-line')].map((l) => [
        l.querySelector('.lang-tag').textContent,
        l.querySelector('.tgt-text').textContent,
      ]),
    })),
  );
// Waits until `count` rows have `lines` translation lines each (a list, one count per row).
export const linesDone = (page, counts) =>
  page.waitForFunction((want) => {
    const segs = [...document.querySelectorAll('.seg:not(.live)')];
    return (
      segs.length === want.length &&
      segs.every(
        (s, i) =>
          [...s.querySelectorAll('.tgt-line:not(.pending) .tgt-text')].filter((t) => t.textContent.startsWith('['))
            .length === want[i],
      )
    );
  }, counts);

export const saved = (page) => page.waitForTimeout(500); // saves are debounced by 250 ms

// The saved sessions as read from IndexedDB, each with its segments (kept in their own store,
// one record per segment) put back in order.
export const storedSessions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const tx = open.result.transaction(['sessions', 'segments']);
          const sessions = tx.objectStore('sessions').getAll();
          const segments = tx.objectStore('segments').getAll();
          tx.oncomplete = () => {
            open.result.close();
            resolve(
              sessions.result.map((s) => ({
                ...s,
                segments: segments.result
                  .filter((x) => x.sessionId === s.id)
                  .map(({ sessionId, pos, ...segment }) => segment),
              })),
            );
          };
        };
      }),
  );

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

// The lines of the recorded session that seedRecordedSession writes: one every five seconds of a
// 20-second recording, two people taking turns.
export const RECORDED_LINES = [
  { elapsed: 1000, src: 'Shall we start with the budget?', tgt: '予算から始めましょうか。' },
  { elapsed: 6000, src: 'Yes, I will send the report on Friday.', tgt: 'はい、金曜日に報告書を送ります。' },
  { elapsed: 11000, src: 'Good, then the schedule.', tgt: 'では、次はスケジュールです。' },
  { elapsed: 16000, src: 'It is on track.', tgt: '予定どおりです。' },
];

// Writes a stopped session with RECORDED_LINES and a 20-second recording (a quiet tone as a WAV file,
// which the browser decodes like the app's own recordings) to IndexedDB the way the app stores it,
// then reloads the page to show it. Returns the session's id.
export async function seedRecordedSession(page, { lines = RECORDED_LINES, recordingMs = 20_000 } = {}) {
  const id = await page.evaluate(
    ({ lines, recordingMs }) => {
      const rate = 8000;
      const n = (rate * recordingMs) / 1000;
      const bytes = new DataView(new ArrayBuffer(44 + n * 2));
      const text = (at, s) => {
        for (let i = 0; i < s.length; i++) bytes.setUint8(at + i, s.charCodeAt(i));
      };
      text(0, 'RIFF');
      bytes.setUint32(4, 36 + n * 2, true);
      text(8, 'WAVEfmt ');
      bytes.setUint32(16, 16, true);
      bytes.setUint16(20, 1, true);
      bytes.setUint16(22, 1, true);
      bytes.setUint32(24, rate, true);
      bytes.setUint32(28, rate * 2, true);
      bytes.setUint16(32, 2, true);
      bytes.setUint16(34, 16, true);
      text(36, 'data');
      bytes.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++)
        bytes.setInt16(44 + i * 2, Math.round(3000 * Math.sin((i / rate) * 2 * Math.PI * 220)), true);
      const blob = new Blob([bytes.buffer], { type: 'audio/wav' });
      const now = Date.now();
      const sessionId = `seeded-${now}`;
      const session = {
        id: sessionId,
        title: 'Weekly sync',
        customTitle: true,
        createdAt: now,
        updatedAt: now,
        langA: 'en-US',
        langB: 'ja-JP',
        activeMs: recordingMs,
        usage: { version: 1, transcription: {}, translation: {}, summary: {} },
        recordings: [{ id: 'rec-1', startedAt: now, elapsedStart: 0, durationMs: recordingMs, mime: 'audio/wav' }],
        segmentCount: lines.length,
      };
      return new Promise((resolve, reject) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const tx = open.result.transaction(['sessions', 'segments', 'audio'], 'readwrite');
          tx.objectStore('sessions').put(session);
          for (const [pos, line] of lines.entries()) {
            tx.objectStore('segments').put({ sessionId, pos, id: `l${pos}`, at: now + line.elapsed, ...line });
          }
          tx.objectStore('audio').add({ sessionId, recId: 'rec-1', blob });
          tx.oncomplete = () => {
            open.result.close();
            localStorage.setItem('rt-current', sessionId);
            resolve(sessionId);
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { lines, recordingMs },
  );
  await reload(page);
  await page.waitForFunction((n) => document.querySelectorAll('#log .seg').length === n, lines.length);
  return id;
}

// Who speaks when in the seeded recording, as the service labels it: "spk:0" for the first five
// seconds and from 10 to 15.5 s, "spk:1" from 5.5 to 10 s and from 15.5 s; words of half a second.
export function seededAnswer({ status = 'completed' } = {}) {
  const words = [];
  for (let ms = 0; ms < 20_000; ms += 500) {
    const first = (ms >= 0 && ms < 5500) || (ms >= 10_000 && ms < 15_500);
    words.push({
      type: 'word_info',
      text: 'word',
      speaker: first ? 'spk:0' : 'spk:1',
      start_offset: `${(ms / 1000).toFixed(3)}s`,
      end_offset: `${((ms + 500) / 1000).toFixed(3)}s`,
      start_index: 0,
      end_index: 0,
    });
  }
  return {
    status,
    usage: { total_input_tokens: 500, total_output_tokens: 1200 },
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '…', annotations: words }] }],
  };
}

const SPEAKER_CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'x-goog-upload-url',
};
// Mocks the upload (start, finalize, one poll while processing), the analysis and the deletion of
// files for speaker labels. `analyze(request)` answers the analysis: { status, body } (default: 200
// with seededAnswer()); it may wait. Returns what was asked: uploads (start requests), analyses
// (their JSON bodies) and deleted file names.
export async function mockSpeakers(page, { analyze = () => ({ body: seededAnswer() }) } = {}) {
  const seen = { uploads: [], analyses: [], deleted: [], files: 0 };
  await page.route(/generativelanguage\.googleapis\.com\/upload\/v1beta\/files/, (route) => {
    const request = route.request();
    const command = request.headers()['x-goog-upload-command'];
    if (command === 'start') {
      seen.uploads.push({ headers: request.headers(), body: request.postDataJSON() });
      return route.fulfill({
        status: 200,
        headers: {
          ...SPEAKER_CORS,
          'x-goog-upload-url': `https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u${seen.uploads.length}`,
        },
        contentType: 'application/json',
        body: '{}',
      });
    }
    const name = `files/f${++seen.files}`;
    return route.fulfill({
      status: 200,
      headers: SPEAKER_CORS,
      contentType: 'application/json',
      body: JSON.stringify({
        file: { name, uri: `https://generativelanguage.googleapis.com/v1beta/${name}`, state: 'PROCESSING' },
      }),
    });
  });
  await page.route(/generativelanguage\.googleapis\.com\/v1beta\/files\//, (route) => {
    const request = route.request();
    const name = new URL(request.url()).pathname.replace('/v1beta/', '');
    if (request.method() === 'DELETE') seen.deleted.push(name);
    const body = request.method() === 'DELETE' ? {} : { name, uri: `https://x/${name}`, state: 'ACTIVE' };
    return route.fulfill({
      status: 200,
      headers: SPEAKER_CORS,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.route(/generativelanguage\.googleapis\.com\/v1beta\/interactions/, async (route) => {
    const request = route.request().postDataJSON();
    seen.analyses.push(request);
    const { status = 200, body } = await analyze(request);
    return route
      .fulfill({ status, headers: SPEAKER_CORS, contentType: 'application/json', body: JSON.stringify(body) })
      .catch(() => {}); // the request was cancelled meanwhile
  });
  return seen;
}

// The speaker shown on each line of the transcript.
export const lineSpeakers = (page) =>
  page.locator('#log .seg .speaker').evaluateAll((nodes) => nodes.map((n) => n.textContent));
