// Rebuilding a transcript from its recording: the recorded session with speaker names, an earlier
// summary and answer, the transcription answer with the words of the seeded recording, and the
// translation mock.

import { reload } from './app.js';
import { MOCK_USAGE } from './gemini.js';
import { RECORDED_LINES, seedRecordedSession } from './speakers.js';

// The lines of the seeded recording as the transcription model hears them after the fact, with who
// says them ("spk:0" first). Each line's words are half a second apart from its start.
export const REBUILT_LINES = [
  { at: 500, speaker: 'spk:0', text: 'Shall we begin with the budget?' },
  { at: 5500, speaker: 'spk:1', text: 'Yes, the report goes out on Friday.' },
  { at: 10_500, speaker: 'spk:0', text: 'Good, then the schedule.' },
  { at: 15_500, speaker: 'spk:1', text: 'It is on track.' },
];

// The answer of the transcription model for the seeded recording: REBUILT_LINES as words.
export function rebuildAnswer({ lines = REBUILT_LINES, status = 'completed' } = {}) {
  const words = lines.flatMap((line) =>
    line.text.split(' ').map((text, i) => ({
      type: 'word_info',
      text,
      speaker: line.speaker,
      start_offset: `${((line.at + i * 500) / 1000).toFixed(3)}s`,
      end_offset: `${((line.at + i * 500 + 400) / 1000).toFixed(3)}s`,
    })),
  );
  return {
    status,
    usage: { total_input_tokens: 500, total_output_tokens: 1200 },
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '…', annotations: words }] }],
  };
}

// The seeded session as it looks after speakers were labelled and the first one named "Aiko", with a
// summary and an answer made from it a minute before. Returns the session's id.
export async function seedNamedSession(page) {
  const now = Date.now();
  const id = await seedRecordedSession(page, {
    lines: RECORDED_LINES.map((line, i) => ({ ...line, speaker: i % 2 ? 's2' : 's1' })),
    extra: {
      speakerLabels: {
        speakers: [
          { id: 's1', name: 'Aiko' },
          { id: 's2', name: '' },
        ],
        madeAt: now - 120_000,
        uncertain: false,
        model: 'gemini-3.5-transcribe',
      },
    },
  });
  await page.evaluate(
    ({ id, now }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const tx = open.result.transaction(['summaries', 'questions'], 'readwrite');
          tx.objectStore('summaries').put({
            sessionId: id,
            id: 'sum-1',
            templateId: 'preset:quick',
            templateName: 'Quick summary',
            length: 'standard',
            language: 'ja-JP',
            createdAt: now - 60_000,
            markdown: '## 概要\n\n予算を確認した。',
            model: 'm',
            truncated: false,
            segmentCount: 4,
          });
          tx.objectStore('questions').put({
            sessionId: id,
            id: 'q-1',
            question: '報告書はいつ？',
            answer: '金曜日です [00:00:06]。',
            model: 'm',
            createdAt: now - 60_000,
            truncated: false,
          });
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { id, now },
  );
  await reload(page);
  await page.waitForFunction((n) => document.querySelectorAll('#log .seg').length === n, RECORDED_LINES.length);
  return id;
}

// Mocks translation: every request answers "訳:<text>". `respond(text)` may answer instead with
// { status, body } (an HTTP error), or wait first. Returns the texts asked for, in order.
export async function mockLineTranslation(page, respond = () => null) {
  const asked = [];
  await page.route(/streamGenerateContent/, async (route) => {
    const text = route
      .request()
      .postDataJSON()
      .contents[0].parts[0].text.match(/<text>\n([\s\S]*)\n<\/text>/)[1];
    asked.push(text);
    const answer = await respond(text);
    const reply = answer
      ? { status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) }
      : {
          status: 200,
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `訳:${text}` }] } }], usageMetadata: MOCK_USAGE })}\n\n`,
        };
    await route.fulfill(reply).catch(() => {}); // cancelled meanwhile
  });
  return asked;
}

// The transcript kept besides the session's own, read straight from IndexedDB (or null).
export const keptTranscript = (page, sessionId) =>
  page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const request = open.result.transaction('transcripts').objectStore('transcripts').get(id);
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result ?? null);
          };
        };
      }),
    sessionId,
  );

// Waits until no rebuild is running.
export const rebuildIdle = (page) =>
  page.waitForFunction(() => document.getElementById('rebuild').getAttribute('aria-busy') === 'false');
