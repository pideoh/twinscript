// A stand-in for the desktop app's window.appUpdates (app/preload.js), so the browser tests see
// the page as the desktop app shows it; in the desktop app it answers through the real bridge
// (bridge.js). Nothing is asked of GitHub.

import { settleBridge } from './bridge.js';

// The init script for openApp. The running version is `current`; check() answers `latest` (or
// the version in sessionStorage 'e2e-latest', so a test can release a later one), or fails when
// `fail` is 'null' (an answer of null) or 'throw' (or as sessionStorage 'e2e-fail' says, '' for
// none). While sessionStorage 'e2e-hold' is set, check() waits until window.__releaseUpdateCheck()
// is called. window.__updates counts the calls.
export function updatesBridge({ current = '0.13.0', latest = '0.14.0', fail = '' } = {}) {
  return {
    script: ({ current, latest, fail }) => {
      if (window !== top) return;
      const calls = { version: 0, check: 0, opened: [] };
      window.__updates = calls;
      const parts = (v) => v.split('.').map(Number);
      const newer = (a, b) => {
        const [x, y] = [parts(a), parts(b)];
        const i = x.findIndex((n, k) => n !== y[k]);
        return i >= 0 && x[i] > y[i];
      };
      window.__e2eStandIn(
        'appUpdates',
        Object.freeze({
          version: async () => {
            calls.version++;
            return current;
          },
          check: async () => {
            calls.check++;
            if (sessionStorage.getItem('e2e-hold')) {
              await new Promise((resolve) => {
                window.__releaseUpdateCheck = resolve;
              });
            }
            const failing = sessionStorage.getItem('e2e-fail') ?? fail;
            if (failing === 'throw') throw new Error('net::ERR_INTERNET_DISCONNECTED');
            if (failing === 'null') return null;
            const l = sessionStorage.getItem('e2e-latest') ?? latest;
            return { current, latest: l, newer: newer(l, current) };
          },
          openReleasePage: async (version) => {
            calls.opened.push(version);
          },
        }),
      );
    },
    arg: { current, latest, fail },
  };
}

// The calls the page made so far, once it has asked for the running version (the start of its
// update checks) and settled.
export async function updateCalls(page) {
  await page.waitForFunction(() => window.__updates?.version > 0);
  await settleBridge(page);
  return page.evaluate(() => ({ ...window.__updates, opened: [...window.__updates.opened] }));
}
