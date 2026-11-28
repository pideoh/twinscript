// A file the page downloads, the same way for both targets. In Chrome it is Playwright's download
// event; the desktop app saves it into its throwaway profile (desktop.js) without a dialog, and the
// file is handed over once it is complete. Either way the result has suggestedFilename() and
// createReadStream(), as Playwright's Download has.

import { createReadStream } from 'node:fs';
import { DESKTOP, desktopOf } from './desktop.js';

const TIMEOUT_MS = 30_000;

// Does `action` (a click, usually) and resolves to the download it starts.
export async function download(page, action) {
  if (!DESKTOP) {
    const [file] = await Promise.all([page.waitForEvent('download'), action()]);
    return file;
  }
  const { app } = desktopOf(page);
  const before = await app.evaluate(() => globalThis.e2eDownloads.length);
  await action();
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const record = await app.evaluate((_electron, n) => globalThis.e2eDownloads[n], before);
    if (record && record.state !== 'progressing') {
      if (record.state !== 'completed') throw new Error(`download of ${record.name} ${record.state}`);
      return { suggestedFilename: () => record.name, createReadStream: async () => createReadStream(record.path) };
    }
    if (Date.now() > deadline) throw new Error(`no download within ${TIMEOUT_MS} ms`);
    await page.waitForTimeout(50);
  }
}
