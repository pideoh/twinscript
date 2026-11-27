// Changes the sample rate of audio that arrives in pieces (a recording decoded a piece at a time,
// src/session/audio-reader.js), as one continuous signal: what is pushed in is resampled as if it were
// one buffer, so there is no seam where two pieces meet and no drift over hours. Also mixing channels
// to mono. Pure, DOM-free.
//
// The filter is a windowed sinc (Blackman window) with ZEROS zero crossings on each side at the lower
// of the two rates, cut off at CUTOFF of the lower Nyquist frequency: for 48 kHz to 16 kHz, 25 input
// samples on each side. Speech (below 7 kHz) comes through unchanged; from 10 kHz up, what would fold
// back is at least 60 dB down. Audio already at the new rate passes unchanged. The kernel is
// tabulated at TABLE points per input sample and read with linear interpolation. Output sample n sits
// at input position n * from / to: the filter is symmetric, so nothing is delayed.

export const ZEROS = 8;
export const CUTOFF = 0.95;
const TABLE = 512;

function kernelTable(scale, half) {
  // h(x) for x in input samples, from 0 to half, scale = cutoff as a fraction of the input's Nyquist.
  const n = Math.ceil(half * TABLE) + 2;
  const table = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / TABLE;
    if (x > half) break;
    const t = Math.PI * scale * x;
    const sinc = x === 0 ? 1 : Math.sin(t) / t;
    const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half);
    table[i] = scale * sinc * w;
  }
  return table;
}

/**
 * A resampler from `from` Hz to `to` Hz. push(Float32Array) returns the output that is complete so
 * far; end() returns the rest, ceil(inputLength * to / from) samples in all.
 */
export function createResampler(from, to) {
  if (!(from > 0 && to > 0)) throw new RangeError('sample rates must be positive');
  // At the same rate, nothing is filtered: the audio is passed on as it is.
  if (from === to) return { push: (samples) => Float32Array.from(samples), end: () => new Float32Array(0) };
  const step = from / to; // input samples per output sample
  const scale = Math.min(1, to / from) * CUTOFF;
  const half = ZEROS / scale; // the kernel's reach, in input samples
  const table = kernelTable(scale, half);
  let buf = new Float32Array(0);
  let base = 0; // input index of buf[0]
  let total = 0; // input samples pushed
  let n = 0; // next output sample

  function produce(limit) {
    // Output samples whose kernel lies within the input known so far; at the end (limit: the input's
    // length), every one that falls inside the input, its kernel cut off where the input ends.
    const known = base + buf.length;
    const last = limit === null ? Math.ceil((known - half) / step) : Math.ceil(limit / step);
    const count = Math.max(0, last - n);
    const out = new Float32Array(count);
    const top = table.length - 1;
    for (let o = 0; o < count; o++, n++) {
      const p = n * step;
      const lo = Math.max(base, Math.ceil(p - half));
      const hi = Math.min(known - 1, Math.floor(p + half));
      let sum = 0;
      for (let k = lo; k <= hi; k++) {
        const x = Math.abs(k - p) * TABLE;
        const i = x | 0;
        if (i < top) sum += buf[k - base] * (table[i] + (table[i + 1] - table[i]) * (x - i));
      }
      out[o] = sum;
    }
    // Input no later output sample reaches is dropped.
    const keepFrom = Math.max(base, Math.floor(n * step - half) - 1);
    if (keepFrom > base) {
      buf = buf.slice(keepFrom - base);
      base = keepFrom;
    }
    return out;
  }

  return {
    push(samples) {
      const next = new Float32Array(buf.length + samples.length);
      next.set(buf);
      next.set(samples, buf.length);
      buf = next;
      total += samples.length;
      return produce(null);
    },
    end: () => produce(total),
  };
}

/** The channels (Float32Array each, the same length) mixed to one: their mean. */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] += channel[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}
