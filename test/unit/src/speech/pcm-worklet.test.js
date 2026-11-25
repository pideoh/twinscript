import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withGlobals } from '../../../support/globals.js';

const QUANTUM = 128; // samples per render call in an audio worklet
let loads = 0;

// Loads a fresh copy of the worklet module in an environment like the audio thread's: the base
// class, registerProcessor and sampleRate are globals there. Passes the registered classes to fn.
async function loadWorklet(sampleRate, fn) {
  const registered = {};
  class AudioWorkletProcessor {
    constructor() {
      this.posted = [];
      this.port = { postMessage: (message, transfer) => this.posted.push({ message, transfer }) };
    }
  }
  const globals = {
    AudioWorkletProcessor,
    registerProcessor: (name, cls) => {
      registered[name] = cls;
    },
    sampleRate,
  };
  await withGlobals(globals, async () => {
    await import(`../../../../src/speech/pcm-worklet.js?load=${++loads}`);
    await fn(registered);
  });
}

// `count` render quanta of constant input on `channels` channels.
const quanta = (count, value, channels = 1) =>
  Array.from({ length: count }, () => [Array.from({ length: channels }, () => new Float32Array(QUANTUM).fill(value))]);

function feed(processor, inputs) {
  for (const input of inputs) assert.equal(processor.process(input), true, 'the processor stays alive');
}

const samplesOf = (posted) => new Int16Array(posted.message.pcm);

test('both processors are registered under the names the audio graph uses', async () => {
  await loadWorklet(16000, (registered) => {
    assert.deepEqual(Object.keys(registered).sort(), ['auto-gain', 'pcm-processor']);
  });
});

test('audio at 48 kHz comes out as 16 kHz PCM in 100 ms chunks of 1600 samples', async () => {
  await loadWorklet(48000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    // 1600 output samples need 4800 input samples = 37.5 quanta: the boundary is inside a quantum.
    feed(p, quanta(37, 0.5));
    assert.equal(p.posted.length, 0, 'not yet 100 ms');
    feed(p, quanta(1, 0.5));
    assert.equal(p.posted.length, 1);
    const [{ message, transfer }] = p.posted;
    assert.equal(message.pcm.byteLength, 1600 * 2);
    assert.deepEqual(transfer, [message.pcm], 'the buffer is handed over, not copied');
    assert.ok(
      samplesOf(p.posted[0]).every((s) => s === 16383),
      '0.5 is half of the 16-bit range',
    );
    assert.ok(Math.abs(message.rms - 0.5) < 1e-6);
  });
});

test('a chunk boundary inside a render quantum loses no samples and starts the next chunk', async () => {
  await loadWorklet(16000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    // A ramp, one distinct value per sample: 1600 per chunk is 12.5 quanta at 16 kHz.
    let n = 0;
    const ramp = () => Float32Array.from({ length: QUANTUM }, () => ++n / 10000);
    feed(
      p,
      Array.from({ length: 25 }, () => [[ramp()]]),
    );
    assert.equal(p.posted.length, 2);
    const [first, second] = p.posted.map(samplesOf);
    assert.equal(first[0], Math.trunc(Math.fround(0.0001) * 0x7fff));
    assert.equal(
      second[0],
      Math.trunc(Math.fround(0.1601) * 0x7fff),
      'the second chunk continues where the first ended',
    );
    assert.ok(first[1599] < second[0] && second[0] < second[1599], 'the ramp keeps rising across the boundary');
  });
});

test('44.1 kHz input is resampled to the same chunk size', async () => {
  await loadWorklet(44100, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    feed(p, quanta(36, 0.25)); // 4608 samples: one 100 ms chunk (4410) and a bit more, not two
    assert.equal(p.posted.length, 1);
    assert.equal(p.posted[0].message.pcm.byteLength, 3200);
  });
});

test('stereo input is mixed down to mono', async () => {
  await loadWorklet(16000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    const quantum = [[new Float32Array(QUANTUM).fill(0.2), new Float32Array(QUANTUM).fill(0.6)]];
    feed(
      p,
      Array.from({ length: 13 }, () => quantum),
    );
    assert.equal(p.posted.length, 1);
    const expected = Math.trunc(((Math.fround(0.2) + Math.fround(0.6)) / 2) * 0x7fff);
    assert.ok(samplesOf(p.posted[0]).every((s) => s === expected));
  });
});

test('silence gives chunks of zeros with a level of zero', async () => {
  await loadWorklet(16000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    feed(p, quanta(13, 0));
    assert.equal(p.posted.length, 1);
    assert.ok(samplesOf(p.posted[0]).every((s) => s === 0));
    assert.equal(p.posted[0].message.rms, 0);
  });
});

test('samples beyond full scale are clipped, not wrapped around', async () => {
  await loadWorklet(16000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    feed(p, quanta(6, 3)); // 768 samples
    feed(p, quanta(7, -3)); // up to 1664: the chunk closes inside the negative part
    const s = samplesOf(p.posted[0]);
    assert.equal(s[0], 0x7fff);
    assert.equal(s[1599], -0x8000);
  });
});

test('missing input produces nothing and does not stop the processor', async () => {
  await loadWorklet(16000, ({ 'pcm-processor': Pcm }) => {
    const p = new Pcm();
    feed(p, [[], [[]], [undefined]]);
    assert.equal(p.posted.length, 0);
    feed(p, quanta(13, 0.1));
    assert.equal(p.posted.length, 1, 'a gap in the input does not disturb the chunking');
  });
});

test('the auto-gain processor outputs silence when nothing is connected', async () => {
  await loadWorklet(48000, ({ 'auto-gain': Gain }) => {
    const g = new Gain();
    const out = new Float32Array(QUANTUM).fill(0.7);
    assert.equal(g.process([[]], [[out]]), true);
    assert.ok(out.every((x) => x === 0));
  });
});

test('the auto-gain processor raises quiet audio, mixing channels to mono', async () => {
  await loadWorklet(48000, ({ 'auto-gain': Gain }) => {
    const g = new Gain();
    const left = new Float32Array(QUANTUM).fill(0.001);
    const right = new Float32Array(QUANTUM).fill(0.003);
    const out = new Float32Array(QUANTUM);
    for (let i = 0; i < 1900; i++) g.process([[left, right]], [[out]]); // about five seconds
    assert.ok(out[0] > 0.002 * 5, `mono 0.002 came out at ${out[0]}`);
    assert.ok(
      out.every((x) => x === out[0]),
      'the same value on every sample',
    );
  });
});

test('the auto-gain processor follows an output size other than 128', async () => {
  await loadWorklet(48000, ({ 'auto-gain': Gain }) => {
    const g = new Gain();
    const out = new Float32Array(64);
    g.process([[new Float32Array(64).fill(0.2)]], [[out]]);
    assert.ok(
      out.every((x) => Math.abs(x - Math.tanh(0.2)) < 1e-6),
      'loud audio passes at unity gain',
    );
  });
});
