// Which app the browser tests drive. With E2E_TARGET=desktop (`npm run test:e2e:desktop`) each page
// openApp opens is the main window of its own desktop app (Electron, launched the way
// test/desktop/ launches it); without it, a page of Chrome served by a local static server. This is
// the one place the variable is read.
//
// Each launch gets a profile of its own in a temporary folder (RT_USER_DATA), removed when the app
// is closed, which matches the fresh browser context of a Chrome page. The app loads app://rt/ by
// itself before the test's routes and init scripts exist; openApp then navigates again, so the page
// a test sees is loaded with them. Chromium's fake microphone and permission prompt are passed as
// switches on Electron's command line, the display language and the color scheme as launch options.
// The window is sized to Playwright's default viewport (1280 x 720) so a layout is the one the
// browser tests see, until a test sets its own size.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

export const DESKTOP = process.env.E2E_TARGET === 'desktop';
export const DESKTOP_ORIGIN = 'app://rt';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const VIEWPORT = { width: 1280, height: 720 };

// Launches the desktop app on a throwaway profile. Returns its context (for routes and init
// scripts), its main window and close(), which quits the app and removes the profile.
export async function launchDesktop({ locale, colorScheme }) {
  const profile = await mkdtemp(join(tmpdir(), 'rt-e2e-'));
  let app;
  try {
    // RT_NO_UPDATE_CHECK: the app does not ask GitHub for a newer version.
    app = await electron.launch({
      args: [...FAKE_MEDIA, ROOT],
      env: { ...process.env, RT_USER_DATA: profile, RT_NO_UPDATE_CHECK: '1' },
      locale,
      colorScheme,
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
    }, VIEWPORT);
    let closed;
    const close = () => {
      closed ??= app.close().finally(() => rm(profile, { recursive: true, force: true }));
      return closed;
    };
    return { context: app.context(), page, close };
  } catch (error) {
    await app?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
