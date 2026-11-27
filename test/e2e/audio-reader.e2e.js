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

// What "the same" means: no shift at the start or at the end (so no drift), the same length within
// 50 ms (an AAC encoder's padding at the end, which decodeAudioData drops, may be kept), and the
// difference at least 35 dB below the signal (two resamplers of similar quality).
function assertSame(name, r) {
  assert.ok(r.pieces, `${name} is read in pieces`);
  assert.ok(Math.abs(r.piecesLength - r.wholeLength) <= 800, `${name}: ${r.piecesLength} against ${r.wholeLength}`);
  if (r.silent) return;
  assert.equal(r.lagStart, 0, `${name}: shifted at the start`);
  assert.equal(r.lagEnd, 0, `${name}: shifted at the end`);
  assert.ok(r.snrDb >= 35, `${name}: ${r.snrDb.toFixed(1)} dB`);
}

test('every format the import takes reads in pieces into the same audio as a whole-file decode', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  for (const name of ['speech.m4a', 'speech.mp4', 'speech.aac', 'speech.flac'])
    assertSame(name, await compareDecodes(page, await fixture(name)));
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
