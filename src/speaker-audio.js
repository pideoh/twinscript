// Decodes a session's recordings for speaker labels: each recording (its chunks as one blob) at
// 16 kHz, mixed to mono, as 16-bit samples. The browser's decoder does the resampling. The thin
// layer over speakers.js that needs Web Audio; everything else about the audio is there.
import { SAMPLE_RATE } from './speakers.js';

/** Resolves with { samples: Int16Array, durationMs } for one recording. */
export async function decodeRecording(blob, rate = SAMPLE_RATE) {
  const data = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buffer = await ctx.decodeAudioData(data);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const samples = new Int16Array(buffer.length);
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    const s = Math.max(-1, Math.min(1, sum / channels.length));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return { samples, durationMs: (samples.length * 1000) / rate };
}
