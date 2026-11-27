// Reading audio files a piece at a time (src/session/audio-reader.js) against decoding them whole
// (decodeWhole in src/session/speaker-audio.js), in the app's page: files made here (WAV, a silent
// MP3, Ogg and WebM written by Mediabunny, recordings made by MediaRecorder from the fake microphone)
// and the fixtures in test/fixtures/audio/.

import { readFile } from 'node:fs/promises';

const FIXTURES = new URL('../../fixtures/audio/', import.meta.url);
export const fixture = (name) => readFile(new URL(name, FIXTURES));

// A speech-like signal (a harmonic tone with a moving pitch, syllable-like loudness, a little noise)
// as 16-bit PCM WAV, the source of the fixtures.
export function speechWav({ seconds = 1.5, rate = 44100, channels = 2 } = {}) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * channels * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * channels * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * channels * 2, 40);
  let seed = 1;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    phase += (2 * Math.PI * (140 + 40 * Math.sin(2 * Math.PI * 0.7 * t))) / rate;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    v = 0.3 * Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2 * v + 0.01 * ((seed / 2147483648) * 2 - 1);
    for (let c = 0; c < channels; c++)
      b.writeInt16LE(Math.round(8000 * v * (c ? 0.8 : 1)), 44 + (i * channels + c) * 2);
  }
  return b;
}

// MPEG-1 layer III frames of digital silence (44.1 kHz, 128 kbit/s, mono): an MP3 file without an
// encoder, whose every frame decodes to 1152 zero samples.
export function silentMp3({ frames = 60 } = {}) {
  const out = [];
  for (let k = 0; k < frames; k++) {
    // 417 bytes, or 418 with padding, as an encoder spreads them to keep 128 kbit/s.
    const padding = (k * 417.959) % 1 > 0.959 - 1e-9 ? 1 : 0;
    const frame = Buffer.alloc(417 + padding);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90 | (padding << 1);
    frame[3] = 0xc4;
    out.push(frame);
  }
  return Buffer.concat(out);
}

// In the page: Ogg/Opus and WebM/Opus written by Mediabunny from `wav`, and what MediaRecorder makes of
// `seconds` of the fake microphone in WebM/Opus (as the app records) and, where it can, MP4/AAC.
export const madeInPage = (page, wav, seconds = 1.5) =>
  page.evaluate(
    async ({ bytes, seconds }) => {
      const lib = await import('/node_modules/mediabunny/dist/bundles/mediabunny.mjs');
      const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(new Uint8Array(bytes).buffer);
      const out = {};
      for (const [name, Format] of [
        ['mediabunny.ogg', lib.OggOutputFormat],
        ['mediabunny.webm', lib.WebMOutputFormat],
      ]) {
        const target = new lib.BufferTarget();
        const output = new lib.Output({ format: new Format(), target });
        const source = new lib.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
        output.addAudioTrack(source);
        await output.start();
        await source.add(audio);
        await output.finalize();
        out[name] = [...new Uint8Array(target.buffer)];
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const [name, mime] of [
        ['recorder.webm', 'audio/webm;codecs=opus'],
        ['recorder.mp4', 'audio/mp4'],
      ]) {
        if (!MediaRecorder.isTypeSupported(mime)) continue;
        const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start(500);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        await new Promise((r) => {
          rec.onstop = r;
          rec.stop();
        });
        out[name] = [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
      }
      for (const t of stream.getTracks()) t.stop();
      return out;
    },
    { bytes: [...wav], seconds },
  );

// Decodes `bytes` both ways in the page and compares them: { pieces (null: not read in pieces),
// source (what the library reported: codec, first timestamp, first decoded sample, duration, rate),
// wholeLength, piecesLength, lagStart, lagEnd (the shift that matches best near the start and near
// the end, in 16 kHz samples), snrDb (the whole decode against the difference over the middle, at the
// shift found at the start) }.
export const compareDecodes = (page, bytes, type = '') =>
  page.evaluate(
    async ({ bytes, type }) => {
      const { readAudio } = await import('/src/session/audio-reader.js');
      const { decodeWhole } = await import('/src/session/speaker-audio.js');
      const blob = new Blob([new Uint8Array(bytes)], { type });
      const pieces = await readAudio(blob);
      const whole = await decodeWhole(blob);
      if (!pieces) return { pieces: null, wholeLength: whole.samples.length };
      const source = pieces.source;
      const a = whole.samples;
      const b = pieces.samples;
      const n = Math.min(a.length, b.length);
      // The shift with the least difference; for a periodic signal (the fake microphone's tone) several
      // shifts match as well, and the smallest of them is taken.
      const lagAt = (from, to) => {
        let best = 0;
        let bestErr = Infinity;
        for (let k = 0; k <= 3200; k++) {
          const lag = k % 2 ? (k + 1) / 2 : k ? -k / 2 : 0;
          let e = 0;
          for (let i = from; i < to; i++) e += (a[i] - (b[i + lag] ?? 0)) ** 2;
          if (e < bestErr * 0.99) [best, bestErr] = [lag, e];
        }
        return best;
      };
      const lagStart = lagAt(Math.floor(n * 0.05), Math.floor(n * 0.3));
      const lagEnd = lagAt(Math.floor(n * 0.7), Math.floor(n * 0.95));
      // The difference over the middle, at the shift found at the start.
      let err = 0;
      let sig = 0;
      for (let i = Math.floor(n * 0.1); i < Math.floor(n * 0.9); i++) {
        err += (a[i] - (b[i + lagStart] ?? 0)) ** 2;
        sig += a[i] ** 2;
      }
      return {
        pieces: true,
        source,
        wholeLength: a.length,
        piecesLength: b.length,
        lagStart,
        lagEnd,
        snrDb: sig ? 10 * Math.log10(sig / Math.max(err, 1e-9)) : null,
        silent: sig === 0 && b.every((v) => v === 0),
      };
    },
    { bytes: [...bytes], type },
  );
