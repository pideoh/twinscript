import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRecording } from '../../../../src/session/speaker-audio.js';
import { withGlobals } from '../../../support/globals.js';

// An OfflineAudioContext whose decoder returns the given channels (or fails), and remembers how it
// was created and what bytes it was asked to decode.
function fakeAudioContext({ channels, error }) {
  const seen = { args: null, bytes: null };
  class FakeOfflineAudioContext {
    constructor(...args) {
      seen.args = args;
    }
    async decodeAudioData(data) {
      seen.bytes = new Uint8Array(data);
      if (error) throw error;
      return {
        numberOfChannels: channels.length,
        length: channels[0].length,
        getChannelData: (i) => channels[i],
      };
    }
  }
  return { seen, OfflineAudioContext: FakeOfflineAudioContext };
}

const blobOf = (...parts) => new Blob(parts.map((p) => Uint8Array.from(p)));

test('a recording is decoded at 16 kHz into 16-bit samples with its length in milliseconds', async () => {
  const { seen, OfflineAudioContext } = fakeAudioContext({ channels: [new Float32Array(1600).fill(0.5)] });
  await withGlobals({ OfflineAudioContext }, async () => {
    const { samples, durationMs } = await decodeRecording(blobOf([1, 2, 3]));
    assert.deepEqual(seen.args, [1, 1, 16000], 'the decoder resamples to 16 kHz');
    assert.ok(samples instanceof Int16Array);
    assert.equal(samples.length, 1600);
    assert.ok(samples.every((s) => s === 16383));
    assert.equal(durationMs, 100);
  });
});

test('a recording kept in several chunks is decoded as one piece, in order', async () => {
  const { seen, OfflineAudioContext } = fakeAudioContext({ channels: [new Float32Array(4)] });
  await withGlobals({ OfflineAudioContext }, async () => {
    await decodeRecording(blobOf([1, 2], [3], [4, 5]));
    assert.deepEqual([...seen.bytes], [1, 2, 3, 4, 5]);
  });
});

test('stereo recordings are mixed to mono by averaging the channels', async () => {
  const { OfflineAudioContext } = fakeAudioContext({
    channels: [Float32Array.of(0.5, -1, 0), Float32Array.of(0.25, -0.5, 0)],
  });
  await withGlobals({ OfflineAudioContext }, async () => {
    const { samples } = await decodeRecording(blobOf([0]));
    assert.deepEqual([...samples], [Math.trunc(0.375 * 0x7fff), Math.trunc(-0.75 * 0x8000), 0]);
  });
});

test('samples past full scale are clipped, and negative full scale reaches the lowest 16-bit value', async () => {
  const { OfflineAudioContext } = fakeAudioContext({ channels: [Float32Array.of(2, -2, 1, -1)] });
  await withGlobals({ OfflineAudioContext }, async () => {
    const { samples } = await decodeRecording(blobOf([0]));
    assert.deepEqual([...samples], [0x7fff, -0x8000, 0x7fff, -0x8000]);
  });
});

test('another sample rate can be asked for, and the duration follows it', async () => {
  const { seen, OfflineAudioContext } = fakeAudioContext({ channels: [new Float32Array(8000)] });
  await withGlobals({ OfflineAudioContext }, async () => {
    const { durationMs } = await decodeRecording(blobOf([0]), 8000);
    assert.equal(seen.args[2], 8000);
    assert.equal(durationMs, 1000);
  });
});

test('an empty recording gives no samples and no duration', async () => {
  const { OfflineAudioContext } = fakeAudioContext({ channels: [new Float32Array(0)] });
  await withGlobals({ OfflineAudioContext }, async () => {
    const { samples, durationMs } = await decodeRecording(blobOf([0]));
    assert.equal(samples.length, 0);
    assert.equal(durationMs, 0);
  });
});

test('a recording the browser cannot decode is reported to the caller, not turned into silence', async () => {
  const failure = new Error('EncodingError');
  const { OfflineAudioContext } = fakeAudioContext({ channels: [new Float32Array(1)], error: failure });
  await withGlobals({ OfflineAudioContext }, async () => {
    await assert.rejects(decodeRecording(blobOf([9, 9])), failure);
  });
});
