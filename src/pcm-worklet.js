// Downmixes to mono, resamples to 16 kHz and emits 100 ms chunks of 16-bit PCM.
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
    if (!ch || !ch.length) return true;
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
