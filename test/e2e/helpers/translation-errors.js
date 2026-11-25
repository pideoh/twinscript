// Setup for tests of what the page shows when translation goes wrong: a translation mock whose
// answer each test decides, speech the test says when it wants, and a clock it can move.

import { reload } from './app.js';

const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;

// Routes every translation and identify request to `answer(request)`, where request is
// { text, into, identify, count } (count: the 1-based number of requests seen for that same text and
// kind, so a handler can fail the first ones). The answer is one of:
//   a string                      the translation (streamed as one chunk)
//   { status, body }              an HTTP error with `body` (an object, sent as JSON)
//   { chunks }                    a 200 whose streamed chunks are given as they come
//   { network: true }             no answer: the request fails on the network (fetch rejects)
// Returns the requests seen, in order.
export async function mockTranslation(page, answer) {
  const seen = [];
  const counts = new Map();
  await page.route(/streamGenerateContent/, (route) => {
    const body = route.request().postDataJSON();
    const text = body.contents[0].parts[0].text.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    const identify = !!body.generationConfig.responseJsonSchema;
    const into = body.systemInstruction.parts[0].text.match(/Translate it into ([^.]+)\./)?.[1] ?? null;
    const key = `${identify ? 'identify' : 'translate'}:${into}:${text}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const request = { text, into, identify, count, body };
    seen.push(request);
    const result = answer(request);
    if (result?.network) return route.abort('failed');
    if (typeof result === 'string') {
      const chunk = { candidates: [{ content: { parts: [{ text: result }] } }] };
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(chunk) });
    }
    if (result.status) {
      return route.fulfill({
        status: result.status,
        contentType: 'application/json',
        body: JSON.stringify(result.body ?? {}),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: result.chunks.map(sse).join(''),
    });
  });
  return seen;
}

// What each finished row shows for its translation: { src, tgt, error } (error: whether the
// translation is shown as an error).
export const translationRows = (page) =>
  page.locator('.seg:not(.live)').evaluateAll((nodes) =>
    nodes.map((n) => ({
      src: n.querySelector('.src').textContent,
      tgt: n.querySelector('.tgt').textContent,
      error: !!n.querySelector('.tgt.error'),
    })),
  );

// Each finished row's translation lines: { src, lines: [{ tag, text, error }] }.
export const lineStates = (page) =>
  page.locator('.seg:not(.live)').evaluateAll((nodes) =>
    nodes.map((n) => ({
      src: n.querySelector('.src').textContent,
      lines: [...n.querySelectorAll('.tgt-line')].map((l) => ({
        tag: l.querySelector('.lang-tag').textContent,
        text: l.querySelector('.tgt-text').textContent,
        error: l.classList.contains('error'),
      })),
    })),
  );

// Mocks the live transcription socket; the test says what was heard, when it wants:
// say('final' | 'interim', text). Waits for the connection if it is not open yet.
export async function mockSpeech(page) {
  let open;
  const connected = new Promise((resolve) => {
    open = resolve;
  });
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      if (JSON.parse(raw).setup) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        open(ws);
      }
    });
  });
  return {
    async say(kind, text) {
      const ws = await connected;
      const field = kind === 'final' ? 'inputTranscription' : 'interimInputTranscription';
      ws.send(JSON.stringify({ serverContent: { [field]: { text } } }));
    },
  };
}

// Replaces the page's clock (Playwright's page.clock) and reloads, so that the timers and the time
// the app takes are the fake ones: the page's time then runs with real time until the test moves it
// with page.clock.fastForward. Every translation request records the page's time in
// window.__translationAt, which `requestTimes` reads.
export async function useClock(page) {
  if (typeof page.clock?.install !== 'function') throw new Error('this playwright-core has no page.clock');
  await page.clock.install();
  await page.addInitScript(() => {
    const fetchNow = window.fetch;
    window.__translationAt = [];
    window.fetch = (...args) => {
      if (String(args[0]).includes('streamGenerateContent')) window.__translationAt.push(Date.now());
      return fetchNow.apply(window, args);
    };
  });
  await reload(page);
}
export const requestTimes = (page) => page.evaluate(() => window.__translationAt);

// Moves the clock in steps of `step` ms until `done()` is true (a timer the page sets only after an
// answer arrives cannot be fired by a single jump made too early). Returns the time moved. Gives up
// after `limit` ms of page time, so a condition that never comes fails the test instead of hanging it.
export async function advanceUntil(page, done, step = 500, limit = 60_000) {
  let moved = 0;
  while (!(await done())) {
    if (moved >= limit) throw new Error(`still not done after moving the clock ${moved} ms`);
    await page.clock.fastForward(step);
    moved += step;
    await page.waitForTimeout(20);
  }
  return moved;
}
