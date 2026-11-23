// A stopped session with a recording, and the mocks for speaker labels (Files and Interactions routes).

import { reload } from './app.js';

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
