import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIBRARY, probeAudio, readAudio } from '../../../../src/session/audio-reader.js';

// A stand-in for Mediabunny: an input whose audio track yields `pieces` (each { rate, channels:
// [Float32Array], timestamp }) in order, and that remembers what was opened, closed and disposed.
function fakeLibrary({ pieces = [], codec = 'aac', decodable = true, track = true, seconds = 1 } = {}) {
  const seen = { formats: null, closed: 0, disposed: 0, yielded: 0, source: null };
  const FORMATS = ['MP4', 'QTFF', 'MATROSKA', 'WEBM', 'WAVE', 'OGG', 'FLAC', 'MP3', 'ADTS', 'HLS', 'MPEG_TS'];
  const lib = Object.fromEntries(FORMATS.map((f) => [f, { name: f }]));
  lib.BlobSource = class {
    constructor(blob) {
      seen.source = blob;
    }
  };
  lib.Input = class {
    constructor({ formats }) {
      seen.formats = formats.map((f) => f.name);
    }
    async getPrimaryAudioTrack() {
      return track
        ? {
            codec,
            canDecode: async () => decodable,
            computeDuration: async () => seconds,
            getFirstTimestamp: async () => pieces[0]?.timestamp ?? 0,
          }
        : null;
    }
    dispose() {
      seen.disposed++;
    }
  };
  lib.AudioSampleSink = class {
    async *samples() {
      for (const p of pieces) {
        seen.yielded++;
        yield {
          sampleRate: p.rate,
          numberOfFrames: p.channels[0].length,
          numberOfChannels: p.channels.length,
          timestamp: p.timestamp,
          copyTo(dest, { planeIndex, format }) {
            assert.equal(format, 'f32-planar');
            dest.set(p.channels[planeIndex]);
          },
          close() {
            seen.closed++;
          },
        };
      }
    }
  };
  return { seen, load: async () => lib };
}

const constant = (n, v) => new Float32Array(n).fill(v);
const blob = new Blob([new Uint8Array(4)]);

test('the library is loaded from its one bundle under node_modules, beside the app', () => {
  assert.match(LIBRARY, /\/node_modules\/mediabunny\/dist\/bundles\/mediabunny\.mjs$/);
});

test('a file is read piece by piece into 16 kHz mono 16-bit samples; every piece is released', async () => {
  const pieces = [0, 1, 2].map((k) => ({
    rate: 16000,
    channels: [constant(1600, 0.5), constant(1600, 0.25)],
    timestamp: k * 0.1,
  }));
  const { seen, load } = fakeLibrary({ pieces, seconds: 0.3 });
  const { samples, durationMs } = await readAudio(blob, { load });
  assert.equal(seen.source, blob, 'the file itself is the source, read in ranges');
  assert.deepEqual(seen.formats, ['MP4', 'QTFF', 'MATROSKA', 'WEBM', 'WAVE', 'OGG', 'FLAC', 'MP3', 'ADTS']);
  assert.equal(samples.length, 4800);
  assert.equal(durationMs, 300);
  // Mixed to the mean of the channels (0.375), away from the filter's start and end.
  assert.ok(samples.subarray(100, 4700).every((s) => Math.abs(s - Math.round(0.375 * 0x7fff)) <= 2));
  assert.equal(seen.closed, 3);
  assert.equal(seen.disposed, 1);
});

test('audio at another rate is resampled to 16 kHz across pieces as one signal', async () => {
  const pieces = [0, 1, 2, 3].map((k) => ({ rate: 48000, channels: [constant(12000, 0.5)], timestamp: k * 0.25 }));
  const { load } = fakeLibrary({ pieces });
  const { samples } = await readAudio(blob, { load });
  assert.equal(samples.length, 16000);
  assert.ok(
    samples.subarray(100, 15900).every((s) => Math.abs(s - 16384) <= 2),
    'no step where pieces meet',
  );
});

test('audio before time 0, an encoder’s priming, is left out', async () => {
  const pieces = [
    { rate: 16000, channels: [constant(1024, 0.9)], timestamp: -2112 / 16000 },
    { rate: 16000, channels: [constant(1024, 0.9).fill(0, 1088 - 1024)], timestamp: -1088 / 16000 },
    { rate: 16000, channels: [constant(1024, 0)], timestamp: -64 / 16000 },
  ];
  const { seen, load } = fakeLibrary({ pieces });
  const { samples } = await readAudio(blob, { load });
  assert.equal(samples.length, 1024 - 64);
  assert.equal(seen.closed, 3);
});

test('decoded audio is placed by its timestamps: a gap becomes silence, an overlap is dropped', async () => {
  const pieces = [
    { rate: 16000, channels: [constant(1600, 0.5)], timestamp: 0 },
    // 50 ms missing, then a piece that starts 10 ms before the end of the one before it.
    { rate: 16000, channels: [constant(1600, 0.5)], timestamp: 0.15 },
    { rate: 16000, channels: [constant(1600, 0.25)], timestamp: 0.24 },
  ];
  const { load } = fakeLibrary({ pieces });
  const { samples, source } = await readAudio(blob, { load });
  assert.equal(samples.length, 1600 + 800 + 1600 + 1600 - 160);
  assert.equal(samples[2000], 0, 'the gap is silent');
  assert.equal(samples[2400 + 800], 16384, 'the second piece where it belongs');
  assert.equal(samples[4000 + 100], 8192, 'the third piece after the overlap');
  assert.deepEqual(source, { codec: 'aac', firstTimestamp: 0, firstSample: 0, duration: 1, sampleRate: 16000 });
});

test('audio that starts after time 0 starts the recording, as decodeAudioData has it', async () => {
  const pieces = [
    { rate: 16000, channels: [constant(1600, 0.5)], timestamp: 0.08 },
    { rate: 16000, channels: [constant(1600, 0.5)], timestamp: 0.18 },
  ];
  const { load } = fakeLibrary({ pieces });
  const { samples } = await readAudio(blob, { load });
  assert.equal(samples.length, 3200);
  assert.equal(samples[10], 16384);
});

test('a file the library cannot read, without audio, with audio the platform cannot decode, or in Vorbis, is left to the whole-file decode', async () => {
  assert.equal(await readAudio(blob, { load: async () => Promise.reject(new Error('no library')) }), null);
  assert.equal(await readAudio(blob, fakeLibrary({ track: false })), null);
  const undecodable = fakeLibrary({ decodable: false });
  assert.equal(await readAudio(blob, undecodable), null);
  assert.equal(undecodable.seen.disposed, 1);
  assert.equal(await readAudio(blob, fakeLibrary({ codec: 'vorbis' })), null);
  assert.equal(await readAudio(blob, fakeLibrary({ pieces: [] })), null, 'no audio decoded');
  const broken = fakeLibrary();
  broken.load = async () => ({
    ...(await fakeLibrary().load()),
    Input: class {
      async getPrimaryAudioTrack() {
        throw new Error('unsupported format');
      }
    },
  });
  assert.equal(await readAudio(blob, broken), null);
});

test('the probe says whether a file is read in pieces and how long it is', async () => {
  assert.deepEqual(await probeAudio(blob, fakeLibrary({ seconds: 3600 })), { seconds: 3600 });
  assert.equal(await probeAudio(blob, fakeLibrary({ codec: 'vorbis' })), null);
  assert.equal(await probeAudio(blob, { load: async () => Promise.reject(new Error('no library')) }), null);
});

test('cancelling stops between pieces and releases the piece in hand', async () => {
  const controller = new AbortController();
  const pieces = [0, 1, 2].map((k) => ({ rate: 16000, channels: [constant(160, 0.1)], timestamp: k * 0.01 }));
  const { seen, load } = fakeLibrary({ pieces });
  controller.abort();
  await assert.rejects(readAudio(blob, { load, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(seen.yielded, 1);
  assert.equal(seen.closed, 1);
  assert.equal(seen.disposed, 1);
});
