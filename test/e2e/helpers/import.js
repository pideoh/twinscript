// Making a session from an audio file: WAV files made here (nothing binary is committed), choosing one
// through the sidebar's control, and what IndexedDB holds afterwards. The Files, Interactions and
// translation mocks are those of speakers.js and rebuild.js.

// A mono WAV of `seconds` of a tone at `rate` (amplitude 0: silence; `bits` 16 or 8), as Playwright's
// setFiles takes it. A long file is kept small with 8 bits at 3000 Hz, the lowest rate Chrome
// reads (11 MB an hour).
export function wavFile({ name = 'Weekly sync.wav', seconds = 20, rate = 8000, bits = 16, amplitude = 3000 } = {}) {
  const n = Math.round(rate * seconds);
  const width = bits / 8;
  const bytes = Buffer.alloc(44 + n * width);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + n * width, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * width, 28);
  bytes.writeUInt16LE(width, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(n * width, 40);
  for (let i = 0; i < n; i++) {
    const value = Math.sin((i / rate) * 2 * Math.PI * Math.min(220, rate / 4));
    if (bits === 8) bytes.writeUInt8(128 + Math.round((amplitude / 256) * value), 44 + i);
    else bytes.writeInt16LE(Math.round(amplitude * value), 44 + i * 2);
  }
  return { name, mimeType: 'audio/wav', buffer: bytes };
}

// Presses the sidebar's control and chooses `file` in the file picker it opens; waits for the dialog.
export async function chooseAudioFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importAudio')]);
  await chooser.setFiles(file);
  await page.waitForSelector('#importDialog[open]');
}

// Waits until the file in the dialog has been read (it can be imported) or refused (it says why).
export const fileRead = (page) =>
  page.waitForFunction(
    () => !document.getElementById('importError').hidden || !document.getElementById('importConfirm').disabled,
  );

// Every record of the audio store, as { sessionId, recId, size }.
export const storedAudio = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const request = open.result.transaction('audio').objectStore('audio').getAll();
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result.map(({ sessionId, recId, blob }) => ({ sessionId, recId, size: blob.size })));
          };
        };
      }),
  );
