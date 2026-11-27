// Browser tests: an audio file read a piece at a time (Mediabunny and the platform's WebCodecs
// decoders, src/session/audio-reader.js) gives the same 16 kHz audio as decoding it whole, for every
// format the import takes. The fixtures in test/fixtures/audio/ were made on macOS from speechWav()
// (test/e2e/helpers/audio-reader.js) with afconvert: speech.m4a and speech.mp4 (`-f m4af` / `-f mp4f
// -d aac -b 64000`, 44.1 kHz stereo, 1.5 s), speech.aac (`-f adts -d aac -b 64000`), speech.flac
// (`-f flac -d flac`, 22.05 kHz mono). WAV, a silent MP3, Ogg/Opus and WebM/Opus are made by the test.
// Vorbis is decoded whole on purpose and has no encoder here, so it is not covered.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDecodes, fixture, madeInPage, setup, silentMp3, speechWav } from './helpers.js';

const { openApp } = setup();

// The encoder's priming that a file marks only in iTunes' iTunSMPB tag (as afconvert and other Apple
// encoders write M4A), in samples at the file's rate and at 16 kHz, or null. Mediabunny 1.66.2 does not
// read that tag (1.66.5 does), so the priming of such a file is kept: its audio comes that much later
// than in the whole-file decode, by the same amount on every platform.
function itunesPriming(bytes) {
  const at = bytes.indexOf('iTunSMPB');
  if (at < 0) return null;
  const words = bytes
    .subarray(at, at + 200)
    .toString('latin1')
    .match(/(?: [0-9A-F]{8,16})+/)[0]
    .trim()
    .split(' ');
  return Number.parseInt(words[1], 16);
}

// What "the same" means: no shift at the start or at the end (so no drift; for a file whose priming
// only iTunSMPB marks, a shift of exactly that priming), the same length within 50 ms (an AAC encoder's
// padding at the end, which decodeAudioData drops, may be kept), and the difference at least 35 dB
// below the signal (two resamplers of similar quality). A failure prints what the library reported.
function assertSame(name, r, { priming = null } = {}) {
  const said = () =>
    `${name}: in pieces ${r.piecesLength} samples, whole ${r.wholeLength}, shifted ${r.lagStart} at the start and ${r.lagEnd} at the end; the library reported ${JSON.stringify(r.source)}`;
  assert.ok(r.pieces, `${name} is read in pieces`);
  const offset = priming && r.source ? Math.round((priming * 16000) / r.source.sampleRate) : 0;
  const shift = r.lagStart === 0 ? 0 : offset;
  assert.ok(Math.abs(r.piecesLength - shift - r.wholeLength) <= 800, said());
  if (r.silent) return;
  assert.ok(Math.abs(r.lagStart - shift) <= 1 && Math.abs(r.lagEnd - shift) <= 1, said());
  assert.ok(r.snrDb >= 35, `${said()}; ${r.snrDb.toFixed(1)} dB`);
}

test('every format the import takes reads in pieces into the same audio as a whole-file decode', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  for (const name of ['speech.m4a', 'speech.mp4', 'speech.aac', 'speech.flac']) {
    const bytes = await fixture(name);
    assertSame(name, await compareDecodes(page, bytes), { priming: itunesPriming(bytes) });
  }
  assertSame('WAV, 44.1 kHz stereo', await compareDecodes(page, speechWav()));
  assertSame('WAV, 8 kHz mono', await compareDecodes(page, speechWav({ rate: 8000, channels: 1 })));
  const mp3 = await compareDecodes(page, silentMp3());
  assertSame('MP3', mp3);
  assert.ok(mp3.silent);
  const made = await madeInPage(page, speechWav());
  assert.ok(made['recorder.webm'], 'MediaRecorder writes WebM/Opus');
  for (const [name, bytes] of Object.entries(made)) assertSame(name, await compareDecodes(page, bytes));
  assert.deepEqual(errors, [], 'the library needs nothing the content security policy blocks');
  await close();
});

test('a file the library cannot read is left to the whole-file decode', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const r = await page.evaluate(async () => {
    const { readAudio } = await import('/src/session/audio-reader.js');
    return readAudio(new Blob([new Uint8Array(1000).fill(7)]));
  });
  assert.equal(r, null);
  assert.deepEqual(errors, []);
  await close();
});
