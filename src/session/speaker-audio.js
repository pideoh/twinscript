// Decodes a session's recordings (for speaker labels, a rebuilt transcript, an imported file): each
// recording (its chunks as one blob) at 16 kHz, mixed to mono, as 16-bit samples. A recording is read
// a piece at a time where the format allows (src/session/audio-reader.js), so the memory it needs does
// not grow with its length; otherwise it is decoded whole with decodeAudioData, whose decoder does the
// resampling and holds the whole file at its own rate and channels on the way. The thin layer over
// speakers.js that needs Web Audio; everything else about the audio is there.
import { MessageError } from '../ui/message-error.js';
import { readAudio } from './audio-reader.js';
import { SAMPLE_RATE } from './speakers.js';

/** Decodes a whole file at once with decodeAudioData: { samples: Int16Array, durationMs }. */
export async function decodeWhole(blob, rate = SAMPLE_RATE) {
  const data = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buffer = await ctx.decodeAudioData(data);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const samples = new Int16Array(buffer.length);
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    const s = Math.max(-1, Math.min(1, sum / channels.length));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return { samples, durationMs: (samples.length * 1000) / rate };
}

/**
 * Resolves with { samples: Int16Array, durationMs } for one recording: read a piece at a time, or
 * decoded whole when it cannot be (or when reading it in pieces fails). read: readAudio, or a
 * stand-in.
 */
export async function decodeRecording(blob, rate = SAMPLE_RATE, { read = readAudio, signal } = {}) {
  const pieces = await read(blob, { rate, signal }).catch((err) => {
    if (err?.name === 'AbortError') throw err;
    return null;
  });
  return pieces ?? decodeWhole(blob, rate);
}

/**
 * Decodes every recording of `sess` that has audio, in order. Each is decoded on its own and kept as
 * 16 kHz mono samples (about 115 MB an hour); a recording that cannot be read is left out (its lines
 * get no speaker). getAudioChunks(sessionId, recId): its stored chunks; signal: stops between
 * recordings. Resolves with [{ elapsedStart, startedAt, samples, durationMs }]; rejects with
 * MessageError('error.speakersNoAudio') when none could be read.
 */
export async function decodeRecordings(sess, { getAudioChunks, signal, decode = decodeRecording }) {
  const decoded = [];
  for (const rec of sess.recordings) {
    const chunks = await getAudioChunks(sess.id, rec.id).catch(() => []);
    signal?.throwIfAborted();
    if (!chunks.length) continue;
    try {
      const audio = await decode(new Blob(chunks, { type: rec.mime }), SAMPLE_RATE, { signal });
      if (audio.samples.length)
        decoded.push({ elapsedStart: rec.elapsedStart ?? 0, startedAt: rec.startedAt, ...audio });
    } catch {
      /* a recording that cannot be decoded: its lines get no speaker */
    }
    signal?.throwIfAborted();
  }
  if (!decoded.length) throw new MessageError('error.speakersNoAudio');
  return decoded;
}
