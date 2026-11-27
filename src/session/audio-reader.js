// Reads an audio file a piece at a time into 16 kHz mono samples, so that the memory it needs does
// not grow with the file's length (issue #175): the file is read in ranges and demuxed by Mediabunny
// (the project's one runtime dependency, MPL-2.0, see THIRD-PARTY-NOTICES.md), each packet is decoded
// by the platform's decoder (WebCodecs) and released at once, and the audio is mixed to mono and
// resampled as one continuous signal (src/session/resample.js). This is the only module that imports
// the library; it loads it when a file is first read, so the page does not load it at startup.
//
// Decoded audio is placed by its timestamps, as the library reports them for each decoded piece, so
// that sample n of the result is time n / rate of the recording whichever decoder the platform has:
// what lies before time 0 (an encoder's priming, which the container marks: an MP4 edit list, the
// LAME tag of an MP3, Opus pre-skip and codec delay) is left out, a gap is filled with silence and an
// overlap is dropped. A recording whose first audio comes after time 0 starts with it, as it does
// when decodeAudioData decodes the whole file. The end is not cut to the track's length: the library
// reports one packet less than there is for WebM as MediaRecorder writes it.
//
// What this does not match: an M4A whose priming only iTunes' iTunSMPB tag marks (afconvert and other
// Apple encoders write it so) keeps its priming, because Mediabunny 1.66.2 does not read that tag
// (1.66.5 does): its audio comes 2112 samples at the file's rate later than with decodeAudioData (48 ms
// at 44.1 kHz), the same on every platform, and an AAC encoder's padding at the end is kept (a few tens
// of milliseconds). Vorbis is left to the whole-file decode: placed by its timestamps it still does not
// line up with decodeAudioData. readAudio resolves with null when the library cannot read the file or
// the platform cannot decode its audio: the caller then decodes it whole. DOM-free: the library is
// loaded through `load`, so tests pass a stand-in.

import { createResampler, mixToMono } from './resample.js';
import { SAMPLE_RATE, toInt16 } from './speakers.js';

export const LIBRARY = new URL('../../node_modules/mediabunny/dist/bundles/mediabunny.mjs', import.meta.url).href;
const loadLibrary = () => import(LIBRARY);
const GAP_FRAMES = 2; // a timestamp this far from where the audio has got to is a gap or an overlap

// The containers read: no playlists (HLS would fetch other files) and no transport streams.
const FORMATS = ['MP4', 'QTFF', 'MATROSKA', 'WEBM', 'WAVE', 'OGG', 'FLAC', 'MP3', 'ADTS'];

// Opens `blob` and finds its audio: { input, track, seconds (its length, NaN when not known) } or
// null when there is none the platform can decode.
async function open(blob, lib) {
  const input = new lib.Input({ source: new lib.BlobSource(blob), formats: FORMATS.map((f) => lib[f]) });
  try {
    const track = await input.getPrimaryAudioTrack();
    // Vorbis is decoded whole: placed by its timestamps it still does not line up with decodeAudioData.
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
 * Decodes `blob` into { samples: Int16Array at `rate`, mono, durationMs, source }, a piece at a time,
 * or resolves with null when it must be decoded whole. source: what the library reported ({ codec,
 * firstTimestamp, firstSample, duration, sampleRate }), for telling why two decodes differ. signal: stops between pieces. Rejects when the
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
  const firstTimestamp = await track.getFirstTimestamp().catch(() => Number.NaN);
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
  let sourceRate = 0;
  let shift = null; // added to every timestamp: a recording whose first audio comes after 0 starts there
  let placed = 0; // source frames placed so far, from time 0
  let firstSample = null;
  try {
    for await (const sample of new lib.AudioSampleSink(track).samples()) {
      try {
        signal?.throwIfAborted();
        if (!resampler) {
          sourceRate = sample.sampleRate;
          resampler = createResampler(sourceRate, rate);
          firstSample = sample.timestamp;
        }
        const frames = sample.numberOfFrames;
        let at = Math.round(sample.timestamp * sourceRate); // where this piece belongs, in source frames
        shift ??= Math.min(0, -at);
        at += shift;
        if (Math.abs(at - placed) <= GAP_FRAMES) at = placed; // rounding, not a gap
        if (at > placed) {
          // A gap in the recording: silence, so that what follows stays at its time.
          append(resampler.push(new Float32Array(at - placed)));
          placed = at;
        }
        // What lies before time 0 (priming) or before what is placed already is left out.
        const from = Math.max(0, placed - at);
        if (from < frames) {
          const channels = [];
          for (let c = 0; c < sample.numberOfChannels; c++) {
            const plane = new Float32Array(frames);
            sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            channels.push(plane);
          }
          append(resampler.push(mixToMono(channels).subarray(from)));
          placed = at + frames;
        }
      } finally {
        sample.close();
      }
    }
    if (resampler) append(resampler.end());
  } finally {
    input.dispose?.();
  }
  const diagnostics = { codec: track.codec, firstTimestamp, firstSample, duration: seconds, sampleRate: sourceRate };
  if (!length) return null;
  const samples = out.length === length ? out : out.slice(0, length);
  return { samples, durationMs: (length * 1000) / rate, source: diagnostics };
}
