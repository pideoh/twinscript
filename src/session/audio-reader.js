// Reads an audio file a piece at a time into 16 kHz mono samples, so that the memory it needs does
// not grow with the file's length (issue #175): the file is read in ranges and demuxed by Mediabunny
// (the project's one runtime dependency, MPL-2.0, see THIRD-PARTY-NOTICES.md), each packet is decoded
// by the platform's decoder (WebCodecs) and released at once, and the audio is mixed to mono and
// resampled as one continuous signal (src/session/resample.js). This is the only module that imports
// the library; it loads it when a file is first read, so the page does not load it at startup.
//
// What is kept matches decoding the whole file with decodeAudioData (src/session/speaker-audio.js):
// decoded audio placed one piece after another; audio before time 0 (an encoder's priming, which the
// container marks as such) is left out. The encoder's padding at the end of AAC in MP4, which
// decodeAudioData drops, is kept (a few tens of milliseconds). Vorbis is left to the whole-file decode:
// its first samples are placed differently. readAudio resolves with null when the library cannot read the
// file or the platform cannot decode its audio: the caller then decodes it whole. DOM-free: the
// library is loaded through `load`, so tests pass a stand-in.

import { createResampler, mixToMono } from './resample.js';
import { SAMPLE_RATE, toInt16 } from './speakers.js';

export const LIBRARY = new URL('../../node_modules/mediabunny/dist/bundles/mediabunny.mjs', import.meta.url).href;
const loadLibrary = () => import(LIBRARY);

// The containers read: no playlists (HLS would fetch other files) and no transport streams.
const FORMATS = ['MP4', 'QTFF', 'MATROSKA', 'WEBM', 'WAVE', 'OGG', 'FLAC', 'MP3', 'ADTS'];

// Opens `blob` and finds its audio: { input, track, seconds (its length, NaN when not known) } or
// null when there is none the platform can decode.
async function open(blob, lib) {
  const input = new lib.Input({ source: new lib.BlobSource(blob), formats: FORMATS.map((f) => lib[f]) });
  try {
    const track = await input.getPrimaryAudioTrack();
    // Vorbis is decoded whole: its first samples are placed differently than decodeAudioData does.
    if (!track || track.codec === 'vorbis' || !(await track.canDecode())) {
      input.dispose?.();
      return null;
    }
    const seconds = await track.computeDuration().catch(() => Number.NaN);
    return { input, track, seconds };
  } catch {
    input.dispose?.();
    return null;
  }
}

/**
 * Whether `blob` can be read a piece at a time, and its length: { seconds } (NaN when it does not
 * say), or null when it must be decoded whole.
 */
export async function probeAudio(blob, { load = loadLibrary } = {}) {
  let lib;
  try {
    lib = await load();
  } catch {
    return null;
  }
  const opened = await open(blob, lib);
  if (!opened) return null;
  opened.input.dispose?.();
  return { seconds: opened.seconds };
}

/**
 * Decodes `blob` into { samples: Int16Array at `rate`, mono, durationMs }, a piece at a time, or
 * resolves with null when it must be decoded whole. signal: stops between pieces. Rejects when the
 * file turns out to be damaged after part of it was decoded.
 */
export async function readAudio(blob, { rate = SAMPLE_RATE, signal, load = loadLibrary } = {}) {
  let lib;
  try {
    lib = await load();
  } catch {
    return null;
  }
  const opened = await open(blob, lib);
  if (!opened) return null;
  const { input, track, seconds } = opened;
  let out = new Int16Array(Number.isFinite(seconds) ? Math.ceil(seconds * rate) + rate : rate * 60);
  let length = 0;
  const append = (floats) => {
    if (length + floats.length > out.length) {
      const grown = new Int16Array(Math.max(out.length * 2, length + floats.length));
      grown.set(out.subarray(0, length));
      out = grown;
    }
    out.set(toInt16(floats), length);
    length += floats.length;
  };
  let resampler = null;
  try {
    for await (const sample of new lib.AudioSampleSink(track).samples()) {
      try {
        signal?.throwIfAborted();
        resampler ??= createResampler(sample.sampleRate, rate);
        const frames = sample.numberOfFrames;
        const channels = [];
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const plane = new Float32Array(frames);
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          channels.push(plane);
        }
        // Audio before time 0 (priming) is not part of the recording.
        const skip = sample.timestamp < 0 ? Math.round(-sample.timestamp * sample.sampleRate) : 0;
        if (skip < frames) append(resampler.push(mixToMono(channels).subarray(skip)));
      } finally {
        sample.close();
      }
    }
    if (resampler) append(resampler.end());
  } finally {
    input.dispose?.();
  }
  if (!length) return null;
  const samples = out.length === length ? out : out.slice(0, length);
  return { samples, durationMs: (length * 1000) / rate };
}
