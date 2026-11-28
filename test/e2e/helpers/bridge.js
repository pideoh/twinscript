// Stand-ins for the desktop app's preload bridge (window.secretStore, window.appUpdates), defined
// once for both targets. A stand-in's init script hands its object to window.__e2eStandIn(name, api):
// in Chrome that becomes window[name], as if the preload had exposed it; in the desktop app the real
// bridge stays and the main process answers its calls from the object (see desktop.js), so the calls
// cross the real preload and IPC.

import { DESKTOP } from './desktop.js';

// The init script openApp adds before a test's own, so stand-ins can use __e2eStandIn.
export const standInInstaller = {
  script: (desktop) => {
    window.__e2eStandIn = (name, api) => {
      if (!desktop) {
        window[name] = api;
        return;
      }
      window.__e2eBridge ??= {};
      window.__e2eBridge[name] = api;
    };
  },
  arg: DESKTOP,
};

// Waits until bridge calls the page has started have reached its stand-ins. In Chrome a call reaches
// the stand-in in the same turn; in the desktop app it crosses IPC twice, so a few round trips to the
// main process (which keep their order) let the calls sent before them arrive.
export async function settleBridge(page) {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  if (!DESKTOP) return;
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.appShortcuts.status().then(() => new Promise((r) => setTimeout(r, 0))));
  }
}
