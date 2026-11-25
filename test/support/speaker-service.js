// A stand-in for the transcription model's speaker labels, for the unit tests of speakers.js and
// diarizer.js. Synthetic audio encodes who speaks: every sample of a speaker's turn has that
// speaker's value (1000 for the first, 2000 for the second, …), silence is 0. The service reads the
// WAV it is sent, cuts each stretch of one value into words of WORD_MS and labels them "spk:<n>",
// numbering the speakers in a different order in every request, as the real one may.

export const RATE = 100; // samples per second: enough to place words, small enough to be fast
export const WORD_MS = 400;

/** Audio pieces ([{ samples }]) from turns [{ speaker: index from 0, ms }] with `gapMs` of silence after each. */
export function synthAudio(turns, { gapMs = 300 } = {}) {
  const total = turns.reduce((n, t) => n + t.ms + gapMs, 0);
  const samples = new Int16Array((total * RATE) / 1000);
  const truth = [];
  let at = 0;
  for (const turn of turns) {
    const from = (at * RATE) / 1000;
    const to = ((at + turn.ms) * RATE) / 1000;
    if (turn.speaker !== null) {
      samples.fill((turn.speaker + 1) * 1000, from, to);
      truth.push({ speaker: turn.speaker, startMs: at, endMs: at + turn.ms });
    }
    at += turn.ms + gapMs;
  }
  return { pieces: [{ samples }], truth, totalMs: total };
}

/** Who speaks at `ms` according to `truth`, or null. */
export const truthAt = (truth, ms) => truth.find((t) => t.startMs <= ms && ms < t.endMs)?.speaker ?? null;

function readWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(40, true) / 2;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = view.getInt16(44 + i * 2, true);
  return samples;
}

/** The words the service would find in `samples`: [{ startMs, endMs, value }]. */
export function wordsIn(samples) {
  const words = [];
  let i = 0;
  while (i < samples.length) {
    const value = samples[i];
    let j = i;
    while (j < samples.length && samples[j] === value) j++;
    if (value !== 0) {
      const from = (i * 1000) / RATE;
      const to = (j * 1000) / RATE;
      for (let t = from; t < to; t += WORD_MS) words.push({ startMs: t, endMs: Math.min(to, t + WORD_MS), value });
    }
    i = j;
  }
  return words;
}

const seconds = (ms) => `${(ms / 1000).toFixed(3)}s`;

/**
 * A diarizer (upload / analyze / remove) over the synthetic audio. options.status(request) gives
 * the answer's status (default 'completed'); options.relabel(value, request) the label of a speaker
 * (default: a rotation per request). Keeps what it was asked in `uploads`, `analyzed`, `removed`.
 */
export function fakeDiarizer({ status = () => 'completed', relabel, fail } = {}) {
  const service = { uploads: [], analyzed: [], removed: [], requests: 0 };
  const label = relabel ?? ((value, request) => `spk:${(value / 1000 - 1 + request) % 8}`);
  service.upload = async (bytes, { mime }) => {
    const name = `files/f${service.uploads.length + 1}`;
    service.uploads.push({ name, mime, samples: readWav(bytes) });
    return { name, uri: `https://example.invalid/${name}`, mime };
  };
  service.analyze = async (file) => {
    const request = service.requests++;
    service.analyzed.push(file.name);
    if (fail?.(request)) throw new Error('analysis failed');
    const { samples } = service.uploads.find((u) => u.name === file.name);
    const annotations = wordsIn(samples).map((w) => ({
      type: 'word_info',
      text: 'word',
      speaker: label(w.value, request),
      start_offset: seconds(w.startMs),
      end_offset: seconds(w.endMs),
    }));
    return {
      status: status(request),
      usage: { total_input_tokens: 100, total_output_tokens: 20 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '…', annotations }] }],
    };
  };
  service.remove = async (file) => {
    service.removed.push(file.name);
  };
  return service;
}
