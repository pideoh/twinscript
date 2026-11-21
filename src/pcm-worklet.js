// pcm-processor: downmixes to mono, resamples to 16 kHz and emits 100 ms chunks of 16-bit PCM.
// pcm-feeder: plays mono Float32 chunks posted to its port (the desktop app's native PC audio).
// auto-gain: raises quiet PC audio to a usable level.
import { AutoGain } from './auto-gain.js';

const TARGET_RATE = 16000;
const CHUNK = 1600;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
    this.sq = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    if (!ch?.length) return true;
    const len = ch[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch.length; c++) s += ch[c][i];
      this.acc += s / ch.length;
      this.cnt++;
      this.pos++;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
      this.acc = 0;
      this.cnt = 0;
      this.sq += v * v;
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === CHUNK) {
        const pcm = this.buf.buffer;
        this.port.postMessage({ pcm, rms: Math.sqrt(this.sq / CHUNK) }, [pcm]);
        this.buf = new Int16Array(CHUNK);
        this.n = 0;
        this.sq = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);

// Holds at most ~1 s of audio, dropping the oldest when more arrives so the delay cannot grow.
// After running dry it waits for a little audio to collect again, instead of playing every
// late chunk as soon as it lands and leaving a gap between each.
const FEED_CAPACITY = 1 << 16; // ~1.4 s at 48 kHz; the cap below is what counts
const FEED_MAX_S = 1;
const FEED_RESUME_S = 0.05;

class PcmFeeder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(FEED_CAPACITY);
    this.read = 0;
    this.size = 0;
    this.max = Math.min(FEED_CAPACITY, Math.round(sampleRate * FEED_MAX_S));
    this.resume = Math.round(sampleRate * FEED_RESUME_S);
    this.waiting = true;
    this.port.onmessage = (e) => this.push(e.data);
  }

  push(samples) {
    let src = samples;
    if (src.length > this.max) src = src.subarray(src.length - this.max);
    const over = this.size + src.length - this.max;
    if (over > 0) {
      this.read = (this.read + over) % FEED_CAPACITY;
      this.size -= over;
    }
    let write = (this.read + this.size) % FEED_CAPACITY;
    for (let i = 0; i < src.length; i++) {
      this.ring[write] = src[i];
      write = (write + 1) % FEED_CAPACITY;
    }
    this.size += src.length;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.waiting && this.size >= this.resume) this.waiting = false;
    let i = 0;
    if (!this.waiting) {
      for (; i < out.length && this.size > 0; i++) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % FEED_CAPACITY;
        this.size--;
      }
      if (i < out.length) this.waiting = true; // ran dry
    }
    out.fill(0, i);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('pcm-feeder', PcmFeeder);

class AutoGainProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = new AutoGain(sampleRate);
    this.mono = new Float32Array(128);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0][0];
    if (!input.length) {
      out.fill(0);
      return true;
    }
    if (this.mono.length !== out.length) this.mono = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let c = 0; c < input.length; c++) sum += input[c][i];
      this.mono[i] = sum / input.length;
    }
    this.gain.process(this.mono, out);
    return true;
  }
}

registerProcessor('auto-gain', AutoGainProcessor);
