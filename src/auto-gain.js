// Brings quiet audio up to a usable level. PC audio arrives at whatever level the playing app
// uses, which can be far too low for recognition; a microphone already has the browser's own
// gain control, so this is only applied to PC audio.

const TARGET = 0.2; // level the louder moments are brought to (the estimate follows peaks)
const MAX_GAIN = 30;
const SILENCE = 0.0005; // below this (about -66 dBFS) nothing is playing; the estimate is held
const ATTACK_S = 0.02; // how fast the level estimate rises (gain comes down quickly)
const RELEASE_S = 0.5; // how slowly it falls (gain comes up gradually, so pauses do not pump)

export class AutoGain {
  constructor(sampleRate) {
    this.up = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
    this.down = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
    this.level = TARGET; // start at unity gain
  }

  // Writes the adjusted samples of `input` into `output` (same length; may be the same array).
  process(input, output) {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const power = x * x;
      const levelSq = this.level * this.level;
      const rate = power > levelSq ? this.up : this.down;
      // Silence must not drag the estimate down, or the next sound would start far too loud.
      if (power > levelSq || power > SILENCE * SILENCE) {
        this.level = Math.sqrt(levelSq + rate * (power - levelSq));
      }
      const gain = Math.min(MAX_GAIN, Math.max(1, TARGET / this.level));
      output[i] = Math.tanh(x * gain); // soft limit instead of clipping
    }
  }
}
