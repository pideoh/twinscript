import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteFileRequest,
  fileRequest,
  GeminiDiarizer,
  interactionRequest,
  labelSpeakers,
  MODEL,
  readAnswer,
  uploadBytesRequest,
  uploadStartRequest,
} from '../src/diarizer.js';
import { addTokens, emptyUsage } from '../src/usage.js';
import { fakeDiarizer, RATE, synthAudio } from './speaker-service.js';

const KEY = 'placeholder-key'; // never a real key
const HOST = 'https://generativelanguage.googleapis.com';
const MIN = 60_000;
const conversation = (count, ms = 15_000) => Array.from({ length: count }, (_, i) => ({ speaker: i % 2, ms }));

test('an upload starts with a resumable request that names the size and type, the key in a header only', () => {
  const { url, init } = uploadStartRequest(KEY, { size: 1234, mime: 'audio/wav', displayName: 'part 1' });
  assert.equal(url, `${HOST}/upload/v1beta/files`);
  assert.equal(init.method, 'POST');
  assert.ok(!url.includes(KEY));
  assert.deepEqual(init.headers, {
    'Content-Type': 'application/json',
    'x-goog-api-key': KEY,
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': '1234',
    'X-Goog-Upload-Header-Content-Type': 'audio/wav',
  });
  assert.deepEqual(JSON.parse(init.body), { file: { display_name: 'part 1' } });
});

test('the bytes go to the upload address in one request that finishes the upload, and nowhere else', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const upload = `${HOST}/upload/v1beta/files?upload_id=abc&upload_protocol=resumable`;
  const { url, init } = uploadBytesRequest(upload, bytes);
  assert.equal(url, upload);
  assert.deepEqual(init.headers, { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' });
  assert.equal(init.body, bytes);
  for (const elsewhere of [null, '', 'https://example.com/upload', 'http://generativelanguage.googleapis.com/x']) {
    assert.throws(() => uploadBytesRequest(elsewhere, bytes), { key: 'error.speakersUpload' });
  }
});

test('files are read and deleted by name', () => {
  assert.deepEqual(fileRequest(KEY, 'files/abc-1'), {
    url: `${HOST}/v1beta/files/abc-1`,
    init: { method: 'GET', headers: { 'x-goog-api-key': KEY } },
  });
  assert.equal(deleteFileRequest(KEY, 'files/abc-1').init.method, 'DELETE');
  assert.throws(() => deleteFileRequest(KEY, '../models/x'), { key: 'error.speakersUpload' });
});

test('the analysis asks for a verbatim transcript with speakers and word times', () => {
  const { url, init } = interactionRequest(KEY, { uri: 'https://files/x', mime: 'audio/wav' });
  assert.equal(url, `${HOST}/v1beta/interactions`);
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'models/gemini-3.5-transcribe',
    input: [{ type: 'audio', uri: 'https://files/x', mime_type: 'audio/wav' }],
    generation_config: {
      transcription_config: {
        mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] },
      },
    },
  });
});

test('an answer gives its status, its words and what it used', () => {
  const answer = {
    status: 'incomplete',
    usage: { total_input_tokens: 4500, total_output_tokens: 900, total_tokens: 5400 },
    steps: [
      { content: [{ annotations: [{ type: 'word_info', speaker: 'spk:0', start_offset: '1s', end_offset: '1.2s' }] }] },
    ],
  };
  const read = readAnswer(answer);
  assert.equal(read.status, 'incomplete');
  assert.deepEqual(read.words, [{ startMs: 1000, endMs: 1200, label: 'spk:0' }]);
  assert.deepEqual(addTokens(emptyUsage(), 'diarization', MODEL, read.usage).diarization, {
    [MODEL]: { requests: 1, inputTokens: 4500, outputTokens: 900 },
  });
  assert.equal(readAnswer({}).status, 'completed');
});

// A fetch that answers from a table of handlers and keeps the requests.
function fakeFetch(handlers) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers, signal: init.signal });
    for (const [match, handler] of handlers) if (match(url, init)) return handler(url, init);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { fetch, seen };
}
const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers });

test('an upload is polled until the file is active', async () => {
  let polls = 0;
  const { fetch, seen } = fakeFetch([
    [
      (u) => u.endsWith('/upload/v1beta/files'),
      () => json({}, { headers: { 'x-goog-upload-url': `${HOST}/upload/x?id=1` } }),
    ],
    [
      (u) => u.startsWith(`${HOST}/upload/x`),
      () => json({ file: { name: 'files/a1', uri: 'u', state: 'PROCESSING' } }),
    ],
    [
      (u) => u.endsWith('/files/a1'),
      () => json({ name: 'files/a1', uri: 'u', state: ++polls < 2 ? 'PROCESSING' : 'ACTIVE' }),
    ],
  ]);
  const diarizer = new GeminiDiarizer({ apiKey: KEY, fetch, pollMs: 1 });
  const file = await diarizer.upload(new Uint8Array(10));
  assert.deepEqual(file, { name: 'files/a1', uri: 'u', mime: 'audio/wav' });
  assert.deepEqual(
    seen.map((r) => r.method),
    ['POST', 'POST', 'GET', 'GET'],
  );
});

test('an upload that fails while processing, or is cancelled while waiting for it, is deleted', async () => {
  for (const ending of ['FAILED', 'cancel']) {
    const controller = new AbortController();
    const { fetch, seen } = fakeFetch([
      [
        (u) => u.endsWith('/upload/v1beta/files'),
        () => json({}, { headers: { 'x-goog-upload-url': `${HOST}/upload/x` } }),
      ],
      [(u) => u.startsWith(`${HOST}/upload/x`), () => json({ file: { name: 'files/a1', state: 'PROCESSING' } })],
      [
        (u, init) => u.endsWith('/files/a1') && init.method === 'GET',
        () => {
          if (ending === 'cancel') controller.abort();
          return json({ name: 'files/a1', state: ending === 'cancel' ? 'PROCESSING' : ending });
        },
      ],
      [(u, init) => u.endsWith('/files/a1') && init.method === 'DELETE', () => json({})],
    ]);
    const diarizer = new GeminiDiarizer({ apiKey: KEY, fetch, pollMs: 1 });
    await assert.rejects(diarizer.upload(new Uint8Array(4), { signal: controller.signal }));
    assert.equal(seen.at(-1).method, 'DELETE', ending);
    assert.equal(seen.at(-1).signal, undefined, 'the deletion is not cancelled with the rest');
  }
});

test('a refused upload or analysis is reported with its status', async () => {
  const { fetch } = fakeFetch([
    [(u) => u.endsWith('/upload/v1beta/files'), () => json({ error: { message: 'too large' } }, { status: 413 })],
    [(u) => u.endsWith('/interactions'), () => json({ error: { message: 'quota' } }, { status: 429 })],
  ]);
  const diarizer = new GeminiDiarizer({ apiKey: KEY, fetch });
  await assert.rejects(diarizer.upload(new Uint8Array(1)), {
    key: 'error.speakersUpload',
    params: { status: 413, message: 'too large' },
  });
  await assert.rejects(diarizer.analyze({ uri: 'u', mime: 'audio/wav' }), { key: 'error.speakersRateLimit' });
});

test('deleting an upload never throws', async () => {
  const diarizer = new GeminiDiarizer({
    apiKey: KEY,
    fetch: async () => {
      throw new TypeError('offline');
    },
  });
  await diarizer.remove({ name: 'files/a1' });
});

test('every request is counted with the model it used', async () => {
  const { pieces } = synthAudio(conversation(8));
  const used = [];
  await labelSpeakers({ pieces, rate: RATE, diarizer: fakeDiarizer(), onUsage: (u, model) => used.push([model, u]) });
  assert.deepEqual(used, [[MODEL, { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 0 }]]);
});

test('progress is told per part and step', async () => {
  const { pieces } = synthAudio(conversation(120));
  const steps = [];
  await labelSpeakers({
    pieces,
    rate: RATE,
    diarizer: fakeDiarizer(),
    onProgress: (p) => steps.push(`${p.step} ${p.part}/${p.parts}`),
  });
  assert.deepEqual(steps, ['upload 1/2', 'analyze 1/2', 'upload 2/2', 'analyze 2/2']);
});

test('a cut-off answer is tried once more with a shorter part, and the rest follows', async () => {
  const { pieces, totalMs } = synthAudio(conversation(80));
  assert.ok(totalMs < 25 * MIN);
  const service = fakeDiarizer({ status: (request) => (request === 0 ? 'incomplete' : 'completed') });
  const result = await labelSpeakers({ pieces, rate: RATE, diarizer: service });
  const lengths = service.uploads.map((u) => (u.samples.length * 1000) / RATE);
  assert.ok(Math.abs(lengths[1] - totalMs / 2) < 1000, 'the retry covers half as much');
  assert.equal(service.uploads.length, 4, 'then the rest, in parts of that length with reference clips');
  assert.deepEqual(service.removed, service.analyzed);
  assert.equal(result.speakers.length, 2);
});

test('a second cut-off answer for the same part is an error', async () => {
  const { pieces } = synthAudio(conversation(80));
  const service = fakeDiarizer({ status: () => 'incomplete' });
  await assert.rejects(labelSpeakers({ pieces, rate: RATE, diarizer: service }), { key: 'error.speakersIncomplete' });
  assert.equal(service.uploads.length, 2);
  assert.deepEqual(service.removed, ['files/f1', 'files/f2']);
});

test('an answer with another status is an error', async () => {
  const { pieces } = synthAudio(conversation(4));
  await assert.rejects(labelSpeakers({ pieces, rate: RATE, diarizer: fakeDiarizer({ status: () => 'failed' }) }), {
    key: 'error.speakersStatus',
    params: { status: 'failed' },
  });
});

test('the upload is deleted when the analysis fails', async () => {
  const { pieces } = synthAudio(conversation(4));
  const service = fakeDiarizer({ fail: () => true });
  await assert.rejects(labelSpeakers({ pieces, rate: RATE, diarizer: service }), /analysis failed/);
  assert.deepEqual(service.removed, ['files/f1']);
});

test('cancelling stops before the next request and deletes what was uploaded', async () => {
  const { pieces } = synthAudio(conversation(120));
  const controller = new AbortController();
  const service = fakeDiarizer();
  const analyze = service.analyze;
  service.analyze = async (file, options) => {
    const answer = await analyze(file, options);
    controller.abort();
    return answer;
  };
  await assert.rejects(labelSpeakers({ pieces, rate: RATE, diarizer: service, signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(service.uploads.length, 1);
  assert.deepEqual(service.removed, ['files/f1']);
});

test('a recording without speech or without audio is an error', async () => {
  const silent = synthAudio([{ speaker: null, ms: 5000 }]);
  await assert.rejects(labelSpeakers({ pieces: silent.pieces, rate: RATE, diarizer: fakeDiarizer() }), {
    key: 'error.speakersNone',
  });
  await assert.rejects(labelSpeakers({ pieces: [], rate: RATE, diarizer: fakeDiarizer() }), {
    key: 'error.speakersNoAudio',
  });
});
