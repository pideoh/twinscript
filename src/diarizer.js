// Tells the speakers of a recording apart with the transcription model: uploads the audio of each
// part (Files API, resumable upload), asks for a verbatim transcript with speaker labels and word
// times (Interactions API), and deletes the upload again. DOM-free; the logic of parts, reference
// clips and labels is in speakers.js.
import { MessageError } from './message-error.js';
import {
  chooseClips,
  mergeWords,
  nextPart,
  numberSpeakers,
  OVERLAP_MS,
  PART_MAX_MS,
  partAudio,
  piecesMs,
  planParts,
  referenceLayout,
  resolvePart,
  SAMPLE_RATE,
  usageFromAnswer,
  wavBytes,
  wordsFromAnswer,
} from './speakers.js';
import { RateLimitError } from './translator.js';

export const MODEL = 'gemini-3.5-transcribe';
export const HOST = 'https://generativelanguage.googleapis.com';
export const WAV = 'audio/wav';
const POLL_MS = 2_000;
const MIN_STEP_MS = 30_000; // a part reaches at least this far past the overlap, so the parts move on
const MAX_POLLS = 150; // five minutes

// ---------- requests ----------

/** Starts a resumable upload of `size` bytes; the answer's x-goog-upload-url takes the bytes. */
export function uploadStartRequest(apiKey, { size, mime = WAV, displayName = 'twinscript-speakers' }) {
  return {
    url: `${HOST}/upload/v1beta/files`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime,
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  };
}

/** Sends all the bytes to the address the start request gave, and finishes the upload. */
export function uploadBytesRequest(uploadUrl, bytes) {
  let url;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new MessageError('error.speakersUpload', { status: 0, message: 'no upload address' });
  }
  // The recording goes nowhere but the API.
  if (url.origin !== HOST) throw new MessageError('error.speakersUpload', { status: 0, message: 'unexpected address' });
  return {
    url: url.href,
    init: {
      method: 'POST',
      headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: bytes,
    },
  };
}

const fileUrl = (name) => {
  if (!/^files\/[\w-]+$/.test(String(name)))
    throw new MessageError('error.speakersUpload', { status: 0, message: 'bad file name' });
  return `${HOST}/v1beta/${name}`;
};

/** Reads an uploaded file's state. */
export const fileRequest = (apiKey, name) => ({
  url: fileUrl(name),
  init: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
});

/** Deletes an uploaded file. */
export const deleteFileRequest = (apiKey, name) => ({
  url: fileUrl(name),
  init: { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } },
});

/** Asks for the speakers of an uploaded file, with the time of every word. */
export function interactionRequest(apiKey, { uri, mime = WAV }) {
  return {
    url: `${HOST}/v1beta/interactions`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        input: [{ type: 'audio', uri, mime_type: mime }],
        generation_config: {
          transcription_config: {
            mode: { type: 'verbatim', diarization_mode: 'speaker', timestamp_granularities: ['word'] },
          },
        },
      }),
    },
  };
}

/** An answer as the labeling uses it: { status, words, usage }; a missing status counts as completed. */
export function readAnswer(answer) {
  const status = typeof answer?.status === 'string' ? answer.status : 'completed';
  return { status, words: wordsFromAnswer(answer), usage: usageFromAnswer(answer) };
}

// ---------- the service ----------

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

async function failure(res, key) {
  const detail = await res.text().catch(() => '');
  if (res.status === 429) return new RateLimitError('error.speakersRateLimit');
  let message = detail;
  try {
    message = JSON.parse(detail).error.message;
  } catch {
    /* keep raw */
  }
  return new MessageError(key, { status: res.status, message: String(message).slice(0, 200) });
}

export class GeminiDiarizer {
  constructor({ apiKey, fetch = (...args) => globalThis.fetch(...args), pollMs = POLL_MS }) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.pollMs = pollMs;
  }

  async #send({ url, init }, signal, key) {
    const res = await this.fetch(url, { ...init, signal });
    if (!res.ok) throw await failure(res, key);
    return res;
  }

  // Uploads `bytes` and waits until the file can be used. Resolves with { name, uri, mime }.
  async upload(bytes, { mime = WAV, displayName, signal } = {}) {
    const start = await this.#send(
      uploadStartRequest(this.apiKey, { size: bytes.byteLength, mime, displayName }),
      signal,
      'error.speakersUpload',
    );
    const res = await this.#send(
      uploadBytesRequest(start.headers.get('x-goog-upload-url'), bytes),
      signal,
      'error.speakersUpload',
    );
    let file = (await res.json())?.file;
    if (!file?.name) throw new MessageError('error.speakersUpload', { status: res.status, message: 'no file' });
    // From here the file exists: anything that stops the wait deletes it.
    const { name } = file;
    try {
      for (let polls = 0; file.state === 'PROCESSING'; polls++) {
        if (polls >= MAX_POLLS)
          throw new MessageError('error.speakersUpload', { status: 0, message: 'still processing' });
        await sleep(this.pollMs, signal);
        file = await (await this.#send(fileRequest(this.apiKey, name), signal, 'error.speakersUpload')).json();
      }
      if (file.state && file.state !== 'ACTIVE') {
        throw new MessageError('error.speakersUpload', { status: 0, message: `file ${file.state}`.toLowerCase() });
      }
    } catch (err) {
      await this.remove({ name });
      throw err;
    }
    return { name, uri: file.uri, mime };
  }

  // The answer for an uploaded file, as JSON.
  async analyze(file, { signal } = {}) {
    const res = await this.#send(interactionRequest(this.apiKey, file), signal, 'error.speakersAnalyze');
    return res.json();
  }

  // Deletes an upload. Never throws, and is not cancelled with the labeling.
  async remove(file) {
    try {
      const { url, init } = deleteFileRequest(this.apiKey, file.name);
      await this.fetch(url, init);
    } catch {
      /* the service deletes uploads by itself after a while */
    }
  }
}

// ---------- the whole recording ----------

/**
 * Labels the speakers of a recording. pieces: [{ samples: Int16Array }] at `rate`, played one after
 * another (audio time). diarizer: upload / analyze / remove as GeminiDiarizer. onProgress({ step:
 * 'upload' | 'analyze', part, parts }); onUsage(usageMetadata, model) for every answer; onPart(report)
 * with what each part found (no speech text). A part whose answer is cut off ('incomplete') is tried
 * once more at half the length; a second cut-off is an error. Every upload is deleted, also when a
 * request fails or `signal` aborts.
 * Resolves with { speakers: [{ id, name }], words: [{ startMs, endMs, speaker }], uncertain }.
 */
export async function labelSpeakers({
  pieces,
  rate = SAMPLE_RATE,
  diarizer,
  signal,
  onProgress = () => {},
  onUsage = () => {},
  onPart = () => {},
  maxMs = PART_MAX_MS,
  overlapMs = OVERLAP_MS,
}) {
  const totalMs = Math.floor(piecesMs(pieces, rate));
  if (totalMs <= 0) throw new MessageError('error.speakersNoAudio');
  let words = [];
  let order = []; // speaker ids in the order they were first heard
  let uncertain = false;
  let startMs = 0;
  let partMax = maxMs;
  let index = 0;
  for (;;) {
    let part = nextPart(startMs, totalMs, { maxMs: partMax, overlapMs });
    let retried = false;
    let result;
    for (;;) {
      signal?.throwIfAborted();
      const parts = index + planParts(totalMs - part.startMs, { maxMs: partMax, overlapMs }).length;
      const clips = index ? chooseClips(words, { speakers: order }) : [];
      const layout = referenceLayout(clips);
      const bytes = wavBytes(partAudio(pieces, part, layout, rate), rate);
      onProgress({ step: 'upload', part: index + 1, parts });
      const file = await diarizer.upload(bytes, { mime: WAV, displayName: `twinscript-part-${index + 1}`, signal });
      let answer;
      try {
        onProgress({ step: 'analyze', part: index + 1, parts });
        answer = readAnswer(await diarizer.analyze(file, { signal }));
      } finally {
        await diarizer.remove(file);
      }
      try {
        onUsage(answer.usage, MODEL);
      } catch {
        /* counting must never break the labeling */
      }
      if (answer.status === 'incomplete') {
        if (retried) throw new MessageError('error.speakersIncomplete');
        // Once more with half as much (a short part is sent again as it is); later parts keep that length.
        retried = true;
        partMax = Math.max(overlapMs + MIN_STEP_MS, Math.floor((part.endMs - part.startMs) / 2));
        part = nextPart(startMs, totalMs, { maxMs: partMax, overlapMs });
        continue;
      }
      if (answer.status !== 'completed') throw new MessageError('error.speakersStatus', { status: answer.status });
      let count = order.length;
      result = resolvePart(answer.words, layout, part, {
        previous: words,
        overlapMs,
        newSpeaker: () => `p${++count}`,
      });
      order = [...order, ...result.added];
      onPart({
        part: index + 1,
        parts,
        durationMs: part.endMs - part.startMs,
        referenceMs: layout.refMs,
        words: result.words.length,
        speakers: new Set(result.words.map((w) => w.speaker).filter((s) => s != null)).size,
        unknownWords: result.words.filter((w) => w.speaker == null).length,
        clips: result.clips.map(({ speaker, words: n, share, ok, reason }) => ({
          speaker,
          words: n,
          share,
          ok,
          reason,
        })),
        overlap: result.overlap,
        uncertain: result.uncertain,
      });
      break;
    }
    uncertain ||= result.uncertain;
    words = index ? mergeWords(words, result.words, part.startMs, part.startMs + overlapMs) : result.words;
    index++;
    if (part.endMs >= totalMs) break;
    startMs = part.endMs - overlapMs;
  }
  if (!words.some((w) => w.speaker != null)) throw new MessageError('error.speakersNone');
  const numbered = numberSpeakers(words);
  return { speakers: numbered.speakers, words: numbered.words, uncertain };
}
