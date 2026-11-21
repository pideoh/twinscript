import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoGain } from '../src/auto-gain.js';

const RATE = 48000;
const tone = (amplitude, seconds) => Float32Array.from({ length: RATE * seconds }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * i / RATE));
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
function run(gain, input) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 128) gain.process(input.subarray(i, i + 128), out.subarray(i, i + 128));
  return out;
}
const tail = (a, seconds = 1) => a.subarray(a.length - RATE * seconds);

test('quiet audio is raised to a usable level', () => {
  const out = run(new AutoGain(RATE), tone(0.01, 8));
  const level = rms(tail(out));
  assert.ok(level > 0.1 && level < 0.17, `settled at ${level}`);
});

test('audio that is already loud enough is left alone', () => {
  const input = tone(0.3, 2);
  const out = run(new AutoGain(RATE), input);
  assert.ok(Math.abs(rms(tail(out)) - rms(tail(input))) < 0.02);
});

test('the output never clips', () => {
  const gain = new AutoGain(RATE);
  run(gain, tone(0.005, 8));           // gain is now high
  const out = run(gain, tone(0.9, 1)); // a sudden loud sound
  assert.ok(out.every((v) => Math.abs(v) <= 1));
  assert.ok(rms(tail(out, 0.5)) < 0.75, 'and the gain comes back down');
});

test('silence stays silent and does not make the next sound start too loud', () => {
  const gain = new AutoGain(RATE);
  run(gain, tone(0.1, 1));
  const quiet = run(gain, new Float32Array(RATE * 10));
  assert.equal(rms(quiet), 0);
  const next = run(gain, tone(0.1, 0.2));
  assert.ok(Math.max(...next.map(Math.abs)) < 0.3, 'no burst after a long pause');
});

test('very quiet audio gets the maximum gain', () => {
  const out = run(new AutoGain(RATE), tone(0.002, 8));
  const peak = Math.max(...tail(out).map(Math.abs));
  assert.ok(peak > 0.055 && peak < 0.065, `0.002 x 30 should be about 0.06, got ${peak}`);
});
