// Making a new session from an audio file: which files are taken, the limits, the title from the
// file's name, the text of the progress, the session made from the file's transcript
// (src/session/recording-transcript.js), and its one recording: the decoded audio (16 kHz mono,
// 16-bit) as a WAV, about 115 MB an hour, stored in chunks as the app's own recordings are. The
// original file is not kept. Pure, DOM-free; the panel is src/ui/import-panel.js.
//
// Formats: what Chromium's decodeAudioData reads (the same decoder reads the app's own recordings).
// Checked with real files in Chrome 158: WAV (16-bit, mono and stereo), MP3, M4A and MP4 (AAC),
// ADTS AAC, FLAC, Ogg Vorbis, WebM (Opus, also with a video track). AIFF and CAF are not decoded,
// so they are not offered.
//
// Limits, from measurements in Chrome 158 (a fresh browser each time; peak memory above an idle page).
// A file read a piece at a time (src/session/audio-reader.js) needs memory for its 16 kHz result and the
// WAV made of it, not for the file: importing two hours of 48 kHz stereo AAC peaked about 1.3 GB above
// the idle page, one hour about 0.8 GB. So MAX_MS is two hours and MAX_BYTES only refuses what no
// recording of that length needs. A file decoded whole (what the library cannot read, and Vorbis)
// costs memory that grows with its length times its own rate and channels (7 GB for an hour of 44.1
// kHz stereo AAC, 11 GB for two hours of 48 kHz), so it keeps the tighter WHOLE_MAX_MS and
// WHOLE_MAX_BYTES. The length is checked before decoding (from the library, or the file's metadata),
// so a longer file is refused without that cost. A file shorter than MIN_MS or without a sample louder
// than SILENT_PEAK (-60 dBFS) has nothing to transcribe and is refused before anything is uploaded.

import { autoTitle } from './session-save.js';
import { SAMPLE_RATE, wavBytes } from './speakers.js';

export const MAX_MS = 2 * 60 * 60_000;
export const MAX_BYTES = 2000 * 1024 ** 2;
export const WHOLE_MAX_MS = 60 * 60_000;
export const WHOLE_MAX_BYTES = 500 * 1024 ** 2;
export const MIN_MS = 1_000;
export const SILENT_PEAK = 33; // of 32767
const TITLE_LENGTH = 100;
export const CHUNK_MS = 5 * 60_000; // of audio per stored chunk of the recording (9.6 MB)

// The numbers the messages about the limits name: for a file read in pieces, and one decoded whole.
export const LIMITS = { minutes: MAX_MS / 60_000, mb: MAX_BYTES / 1024 ** 2 };
export const WHOLE_LIMITS = { minutes: WHOLE_MAX_MS / 60_000, mb: WHOLE_MAX_BYTES / 1024 ** 2 };

// The type a file of each extension is kept as when the system gives none.
const BY_EXTENSION = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
};
const TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/x-aac',
  'audio/aacp',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'video/mp4',
  'video/webm',
]);

// The file input's `accept`: the extensions and the types above.
export const ACCEPT = [...Object.keys(BY_EXTENSION).map((ext) => `.${ext}`), ...TYPES].join(',');

const extensionOf = (name) => /\.([^./\\]+)$/.exec(name ?? '')?.[1].toLowerCase() ?? '';
const baseType = (type) => (type ?? '').split(';')[0].trim().toLowerCase();

// The type the file is kept under: the system's, when it is one of the types above, otherwise the
// one of its extension, or '' when neither is known.
export function fileType({ name, type }) {
  const own = baseType(type);
  return TYPES.has(own) ? type : (BY_EXTENSION[extensionOf(name)] ?? '');
}

/**
 * Whether a chosen file can be read: null, or { key, params } for MessageError. name, type, size: as a
 * File has them.
 */
export function checkFile({ name, type, size }) {
  if (!fileType({ name, type })) return { key: 'import.notAudio' };
  if (!size) return { key: 'import.undecodable' };
  if (size > MAX_BYTES) return { key: 'import.tooLarge', params: { mb: LIMITS.mb } };
  return null;
}

/** Whether a file that is decoded whole is small enough for it: null, or { key, params }. */
export function checkWhole({ size }) {
  if (size > WHOLE_MAX_BYTES) return { key: 'import.tooLargeWhole', params: { mb: WHOLE_LIMITS.mb } };
  return null;
}

/**
 * Whether a length in ms is within the limit: null, or { key, params }. NaN or Infinity: not known
 * yet. whole: the file is decoded whole.
 */
export function checkLength(durationMs, { whole = false } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= (whole ? WHOLE_MAX_MS : MAX_MS)) return null;
  return whole
    ? { key: 'import.tooLongWhole', params: { minutes: WHOLE_LIMITS.minutes } }
    : { key: 'import.tooLong', params: { minutes: LIMITS.minutes } };
}

/** Whether decoded audio ({ samples: Int16Array, durationMs }) has something to transcribe: null, or { key, params }. */
export function checkAudio({ samples, durationMs }, { whole = false } = {}) {
  const long = checkLength(durationMs, { whole });
  if (long) return long;
  if (durationMs < MIN_MS) return { key: 'import.tooShort' };
  let peak = 0;
  for (let i = 0; i < samples.length && peak < SILENT_PEAK; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < SILENT_PEAK) return { key: 'import.silent' };
  return null;
}

/** A session's title from a file name: the name without its extension, white space made single. */
export function titleFromFileName(name) {
  const base = String(name ?? '')
    .replace(/\.[^./\\]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, TITLE_LENGTH);
}

// The text of the progress (as the rebuild shows it): which part is sent or transcribed, then which line is translated.
export function progressKey({ step }) {
  if (step === 'read') return 'import.reading';
  if (step === 'upload') return 'speakers.uploading';
  if (step === 'analyze') return 'rebuild.transcribing';
  if (step === 'punctuate') return 'rebuild.punctuating';
  return 'rebuild.translating';
}

/**
 * The decoded audio (Int16Array at `rate`) as a WAV in chunks of CHUNK_MS, in order: the first holds the
 * header, for the whole length, and the chunks joined are the file (as a recording's chunks are joined
 * to be played, decoded or downloaded).
 */
export function wavChunks(samples, { rate = SAMPLE_RATE, chunkMs = CHUNK_MS } = {}) {
  const per = Math.max(1, Math.round((rate * chunkMs) / 1000));
  const header = wavBytes(new Int16Array(0), rate);
  const view = new DataView(header.buffer);
  view.setUint32(4, 36 + samples.length * 2, true);
  view.setUint32(40, samples.length * 2, true);
  const chunks = [header];
  for (let from = 0; from < samples.length; from += per)
    chunks.push(wavBytes(samples.subarray(from, from + per), rate).subarray(44));
  return chunks;
}

/**
 * The session made from a file. result: what transcribeRecording resolved with; id, recId: the new
 * ids of the session and its recording; now: the time (the session's date: when it was made in the
 * app, since a file's modification time says when it was last copied or converted rather than when
 * the meeting took place); langs: { langA, langB, langC? } the session is in; fileName; durationMs:
 * the decoded length; usage: what the import used so far (src/usage/usage.js). The session is marked
 * `imported`; its recording (a WAV, see wavChunks) has no `startedAt`, and the lines no `at`: when the
 * file was recorded is not known.
 */
export function importedSession(result, { id, recId, now, langs, fileName, durationMs, usage }) {
  const length = Math.round(durationMs);
  const title = titleFromFileName(fileName);
  const sess = {
    id,
    title,
    customTitle: !!title,
    createdAt: now,
    updatedAt: now,
    langA: langs.langA,
    langB: langs.langB,
    ...(langs.langC && { langC: langs.langC }),
    activeMs: length,
    imported: true,
    usage,
    ...(result.speakers.length && {
      speakerLabels: { speakers: result.speakers, madeAt: now, uncertain: !!result.uncertain, model: result.model },
    }),
    segments: result.segments,
    summaries: [],
    questions: [],
    recordings: [{ id: recId, elapsedStart: 0, durationMs: length, mime: 'audio/wav' }],
  };
  if (!title) sess.title = autoTitle(sess);
  return sess;
}
