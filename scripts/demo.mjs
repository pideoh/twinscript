// Records the demo mode (?mock=1) as an animated PNG for the README.
//
//   node scripts/demo.mjs [out.png]        default: docs/demo.png
//
// No API key or microphone is needed. Needs Chrome (set PW_CHANNEL to use another installed
// browser). Frames are plain screenshots joined into an APNG here, so no encoder is required.

import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] || join(ROOT, 'docs/demo.png');
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
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  locale: 'en-US',
});
await context.addInitScript(() => localStorage.setItem('rt-settings', JSON.stringify({ uiLang: 'en' })));
const page = await context.newPage();
await page.goto(`${origin}/?mock=1`);
await page.waitForFunction(() => document.querySelector('#toggle')?.onclick);

const frames = [];
const snap = async () => frames.push(await page.screenshot({ type: 'png' }));
await snap();
await page.click('#toggle');
await page.mouse.move(0, 0);
for (let i = 1; i < FRAMES; i++) {
  await page.waitForTimeout(FRAME_MS);
  await snap();
}
await browser.close();
server.close();

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
const apng = Buffer.concat(parts);
await writeFile(out, apng);
console.log(`${out}: ${frames.length} frames, ${(apng.length / 1e6).toFixed(1)} MB`);
