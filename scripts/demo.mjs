// Pictures of the demo mode (?mock=1) for the README: the animation of two-language listening at the
// top, and stills of what it does not show (three languages, a summary, questions).
//
//   node scripts/demo.mjs [out.png]          the animation; default docs/demo.png
//   node scripts/demo.mjs --stills [dir]     three-languages.png, summary.png, questions.png; default docs/
//
// No API key or microphone is needed. Needs Chrome (set PW_CHANNEL to use another installed
// browser). Animation frames are plain screenshots joined into an APNG here, so no encoder is
// required. The stills run on a fixed clock that only moves when the script moves it, so the dates
// and times they show are the same on every run.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stills = process.argv[2] === '--stills';
const out = process.argv[stills ? 3 : 2] || join(ROOT, stills ? 'docs' : 'docs/demo.png');
const WIDTH = 1100;
const HEIGHT = 660;
const FRAMES = 40;
const FRAME_MS = 500;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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
// The demo in English and the dark theme, ready to start. clock: a fixed start time for the page.
async function openDemo({ scale = 1, clock } = {}) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: scale,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: clock ? 'UTC' : undefined,
  });
  await context.addInitScript(() => localStorage.setItem('rt-settings', JSON.stringify({ uiLang: 'en' })));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  if (clock) await page.clock.install({ time: clock });
  await page.goto(`${origin}/?mock=1`);
  await page.waitForFunction(() => document.querySelector('#toggle')?.onclick);
  return page;
}

async function record() {
  const page = await openDemo();
  const frames = [];
  const snap = async () => frames.push(await page.screenshot({ type: 'png' }));
  await snap();
  await page.click('#toggle');
  await page.mouse.move(0, 0);
  for (let i = 1; i < FRAMES; i++) {
    await page.waitForTimeout(FRAME_MS);
    await snap();
  }
  const apng = toApng(frames);
  await writeFile(out, apng);
  console.log(`${out}: ${frames.length} frames, ${(apng.length / 1e6).toFixed(1)} MB`);
}

// --- Stills: one demo session with three languages, then its summary and two questions about it.
// The page's clock is stopped once it has loaded and moved on by the script in small steps, so the
// session starts at the same time on every run and every time it shows comes out the same.
const START = Date.UTC(2026, 0, 15, 9, 0, 0);
async function takeStills() {
  const page = await openDemo({ scale: 2, clock: START });
  await page.clock.pauseAt(START + 10_000);
  // Runs the page's clock until the condition holds in the page.
  const until = async (condition, arg) => {
    for (let ms = 0; !(await page.evaluate(condition, arg)); ms += 100) {
      if (ms > 120_000) throw new Error(`timed out waiting for ${condition}`);
      await page.clock.runFor(100);
    }
  };
  const shoot = async (name) => {
    await page.mouse.move(0, 0);
    await until(() => document.getElementById('toast').hidden);
    await page.screenshot({ path: join(out, name) });
    console.log(join(out, name));
  };

  // Three languages: each sentence of the demo meeting, translated into the other two.
  await page.click('#listenChoices'); // the languages are chosen in the bottom bar's popover
  await page.selectOption('#langC', 'cmn-Hans-CN');
  await page.click('#listenChoices');
  await page.click('#toggle');
  await until(() => {
    const done = [...document.querySelectorAll('.seg:not(.live)')];
    return done.length >= 5 && done.every((seg) => seg.querySelectorAll('.tgt-line:not(.pending)').length === 2);
  });
  await page.click('#toggle');
  await until(() => document.getElementById('statusText').textContent === 'Stopped');
  await shoot('three-languages.png');

  // A summary made with the quick template.
  await page.click('#tabSummary');
  await page.selectOption('#summaryTemplate', 'preset:quick');
  await page.click('#summarize');
  await until(
    () =>
      document.getElementById('summarize').getAttribute('aria-busy') === 'false' &&
      document.querySelector('#summaryContent li'),
  );
  await shoot('summary.png');

  // Two questions, each answered with the times of the lines it relies on.
  await page.click('#tabQuestions');
  for (const [n, question] of ['How is load testing going?', 'When is the report due?'].entries()) {
    await page.fill('#question', question);
    await page.click('#ask');
    await until(
      (count) =>
        document.querySelectorAll('#questionsList .turn').length === count && document.getElementById('askStop').hidden,
      n + 1,
    );
  }
  await page.locator('#question').blur();
  await shoot('questions.png');
}

// --- APNG: the first frame's header, then every frame's image data as an animation frame.
function chunks(png) {
  const list = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    list.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return list;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, tail]);
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function toApng(frames) {
  const first = chunks(frames[0]);
  const header = first.find((c) => c.type === 'IHDR').data;
  const parts = [
    frames[0].subarray(0, 8),
    chunk('IHDR', header),
    chunk('acTL', Buffer.concat([u32(frames.length), u32(0)])),
  ];
  let seq = 0;
  frames.forEach((png, i) => {
    const list = chunks(png);
    if (!list.find((c) => c.type === 'IHDR').data.equals(header)) throw new Error(`frame ${i} has another format`);
    const control = Buffer.alloc(26);
    control.writeUInt32BE(seq++, 0);
    control.writeUInt32BE(WIDTH, 4);
    control.writeUInt32BE(HEIGHT, 8);
    // The last frame is held longer before the loop restarts.
    control.writeUInt16BE(i === frames.length - 1 ? FRAME_MS * 5 : FRAME_MS, 20);
    control.writeUInt16BE(1000, 22);
    parts.push(chunk('fcTL', control));
    for (const c of list.filter((c) => c.type === 'IDAT')) {
      parts.push(i === 0 ? chunk('IDAT', c.data) : chunk('fdAT', Buffer.concat([u32(seq++), c.data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

if (stills) {
  await mkdir(out, { recursive: true });
  await takeStills();
} else await record();
await browser.close();
server.close();
