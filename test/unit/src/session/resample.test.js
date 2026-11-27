import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResampler, mixToMono } from '../../../../src/session/resample.js';

const tone = (hz, rate, seconds, amplitude = 0.5) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );

// Resamples `input` pushed in pieces of `size` samples.
function resample(input, from, to, size = input.length) {
  const r = createResampler(from, to);
  const parts = [];
  for (let i = 0; i < input.length; i += size) parts.push(r.push(input.subarray(i, i + size)));
  parts.push(r.end());
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};

test('the output has as many samples as the input lasts at the new rate', () => {
  for (const [from, n] of [
    [48000, 48000],
    [44100, 44100 * 2 + 7],
    [8000, 8001],
    [16000, 1600],
  ]) {
    assert.equal(resample(new Float32Array(n), from, 16000).length, Math.ceil((n * 16000) / from), `${from}`);
  }
});

test('pushed in pieces of any size, the result is the same as in one go: no seams and no drift', () => {
  const input = tone(440, 44100, 3);
  const whole = resample(input, 44100, 16000);
  for (const size of [1, 37, 1024, 44100]) assert.deepEqual(resample(input, 44100, 16000, size), whole, `${size}`);
});

test('speech frequencies come through unchanged and in place, down from 48 or 44.1 kHz and up from 8 kHz', () => {
  for (const from of [48000, 44100, 22050, 8000]) {
    for (const hz of [200, 1000, 3000]) {
      const out = resample(tone(hz, from, 1), from, 16000);
      const want = tone(hz, 16000, 1);
      let err = 0;
      for (let i = 400; i < 15600; i++) err = Math.max(err, Math.abs(out[i] - want[i]));
      // At 8 kHz, 3 kHz is close to the input's own Nyquist frequency, where the filter starts to fall.
      assert.ok(err < (from === 8000 && hz === 3000 ? 0.02 : 0.005), `${hz} Hz from ${from}: off by ${err}`);
    }
  }
});

test('what lies above the new Nyquist frequency is filtered out instead of folding back', () => {
  // From 8 kHz up (the filter's transition band starts at 7.6 kHz), at least 60 dB down from 10 kHz.
  for (const hz of [10000, 12000, 20000]) {
    const out = resample(tone(hz, 48000, 1), 48000, 16000);
    const level = 20 * Math.log10(rms(out, 400, 15600) / rms(tone(hz, 48000, 1)));
    assert.ok(level < -60, `${hz} Hz at ${level.toFixed(1)} dB`);
  }
});

test('channels are mixed to mono by their mean; one channel is kept as it is', () => {
  const left = Float32Array.from([1, 0.5, -1]);
  const right = Float32Array.from([0, 0.5, 1]);
  assert.deepEqual([...mixToMono([left, right])], [0.5, 0.5, 0]);
  assert.equal(mixToMono([left]), left);
});

test('audio already at 16 kHz passes unchanged', () => {
  const input = tone(1000, 16000, 0.5);
  assert.deepEqual(resample(input, 16000, 16000, 100), input);
});

test('rates must be positive', () => {
  assert.throws(() => createResampler(0, 16000), RangeError);
});
