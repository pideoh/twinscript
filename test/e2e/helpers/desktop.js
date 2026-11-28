// Which app the browser tests drive. With E2E_TARGET=desktop (`npm run test:e2e:desktop`) each page
// openApp opens is the main window of its own desktop app (Electron, launched the way
// test/desktop/ launches it); without it, a page of Chrome served by a local static server. This is
// the one place the variable is read.
//
// Each launch gets a profile of its own in a temporary folder (RT_USER_DATA), removed when the app
// is closed, which matches the fresh browser context of a Chrome page. The app loads app://rt/ by
// itself before the test's routes and init scripts exist, and that first load already writes to
// storage (the database at its current version, for one). So the window is first sent to a page of
// the app that does not exist (a 404, which runs nothing), the profile's storage is cleared, and
// openApp then opens the page the test asked for, with its routes and init scripts. Chromium's fake microphone and permission prompt are passed as
// switches on Electron's command line, the display language and the color scheme as launch options.
// The window is sized to Playwright's default viewport (1280 x 720) so a layout is the one the
// browser tests see, until a test sets its own size.
//
// Two things of the main process are replaced at launch, through Playwright's evaluation in it:
// - The handlers behind the preload's window.secretStore and window.appUpdates. A call still goes
//   through the real preload and IPC; the handler answers from the stand-in a test installed in the
//   page (bridge.js), or else from a store in memory (secrets: so the system keychain is never
//   asked) and a check that fails without a request (updates: GitHub is never asked).
// - Downloads: each is saved into the profile instead of asking where (Electron's default is a
//   save dialog), and recorded so that download() (download.js) can hand it to the test.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

export const DESKTOP = process.env.E2E_TARGET === 'desktop';
export const DESKTOP_ORIGIN = 'app://rt';

// Without the trailing separator: on Windows a path ending in \ is quoted on the command line as
// "...\", where \" escapes the closing quote, and Electron does not find the app.
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const VIEWPORT = { width: 1280, height: 720 };

const launched = new WeakMap(); // page -> { app, downloads } of the desktop app it belongs to

// The desktop app a page of it belongs to, and the folder its downloads are saved in.
export const desktopOf = (page) => launched.get(page);

// Runs in the main process (see the comment at the top). `channels` maps an IPC channel to the
// bridge and method the page's stand-in has for it.
function replaceMainProcess({ app, ipcMain, session }, { downloads, sep, channels }) {
  const secrets = new Map();
  const fallback = {
    'secret:get': (name) => ({ value: secrets.get(name) ?? '', available: true }),
    'secret:set': (name, value) => {
      if (value) secrets.set(name, value);
      else secrets.delete(name);
      return { persisted: true };
    },
    'update:version': () => app.getVersion(),
    'update:check': () => null,
    'update:open-release': () => undefined,
  };
  for (const [channel, [bridge, method]] of Object.entries(channels)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith('app://rt/'))
        throw new Error('not allowed');
      // One script: the stand-in is called as soon as it runs, as a page's own call would be.
      const answer = await frame.executeJavaScript(
        `(() => {
          const standIn = window.__e2eBridge?.[${JSON.stringify(bridge)}];
          if (!standIn) return { missing: true };
          return Promise.resolve(standIn[${JSON.stringify(method)}](...${JSON.stringify(args)})).then((value) => ({ value }));
        })()`,
      );
      return answer.missing ? fallback[channel](...args) : answer.value;
    });
  }
  globalThis.e2eDownloads = [];
  session.defaultSession.on('will-download', (_event, item) => {
    const record = { name: item.getFilename(), state: 'progressing' };
    record.path = `${downloads}${sep}${globalThis.e2eDownloads.length}-${record.name}`;
    item.setSavePath(record.path);
    item.once('done', (_e, state) => {
      record.state = state;
    });
    globalThis.e2eDownloads.push(record);
  });
}

const CHANNELS = {
  'secret:get': ['secretStore', 'get'],
  'secret:set': ['secretStore', 'set'],
  'update:version': ['appUpdates', 'version'],
  'update:check': ['appUpdates', 'check'],
  'update:open-release': ['appUpdates', 'openReleasePage'],
};

// Launches the desktop app on a throwaway profile. Returns its context (for routes and init
// scripts), its main window and close(), which quits the app and removes the profile.
export async function launchDesktop({ locale, colorScheme }) {
  const profile = await mkdtemp(join(tmpdir(), 'rt-e2e-'));
  const downloads = join(profile, 'e2e-downloads');
  let app;
  try {
    await mkdir(downloads);
    app = await electron.launch({
      args: [...FAKE_MEDIA, ROOT],
      env: { ...process.env, RT_USER_DATA: profile, RT_NO_UPDATE_CHECK: '1' },
      locale,
      colorScheme,
    });
    // The app registers its handlers before it opens its window, so they are replaced after that.
    const page = await app.firstWindow();
    await page.goto(`${DESKTOP_ORIGIN}/e2e-blank`);
    await app.evaluate(({ session }) => session.defaultSession.clearStorageData());
    await app.evaluate(replaceMainProcess, { downloads, sep, channels: CHANNELS });
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
    }, VIEWPORT);
    launched.set(page, { app, downloads });
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

// Options for test(): a test of what only one of the two has is skipped in the other, with the
// reason in the output. `why` says what the test needs.
export const browserOnly = (why) => ({ skip: DESKTOP && `browser only: ${why}` });
export const desktopOnly = (why) => ({ skip: !DESKTOP && `desktop app only: ${why}` });
