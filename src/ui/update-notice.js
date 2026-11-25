// The notice of a newer version (desktop app). The main process asks GitHub (app/updates.js, exposed
// as window.appUpdates); this page decides when (src/ui/update-check.js): at start and then at most
// once every 24 hours, only while the setting is on. The last answer is kept, so the notice comes
// back at the next start without a request until it is dismissed or the app is updated. Failures
// say nothing.

import {
  afterCheck,
  checkDue,
  dismissVersion,
  readUpdateState,
  UPDATE_KEY,
  versionToAnnounce,
} from './update-check.js';

export const UPDATE_LOOK_MS = 60 * 60 * 1000; // how often a long-running app looks whether a check is due

// The version the notice announces, or null for none: only in the desktop app (`available`) and
// while "Check for new versions" is on (`enabled`).
export const noticeVersion = ({ available, enabled, state, running }) =>
  available && enabled ? versionToAnnounce(state, running) : null;

// els: the page's elements; t: i18n; settings: the live settings object (checkUpdates);
// storage: a Storage-like object (getItem / setItem) for the state; bridge(): window.appUpdates, or
// undefined outside the desktop app; now(), repeat(fn, ms): the clock and a repeating timer.
export function createUpdateNotice({
  els,
  t,
  settings,
  storage,
  bridge,
  now = () => Date.now(),
  repeat = (fn, ms) => setInterval(fn, ms),
}) {
  let updateState = readUpdateState(null);
  let runningVersion = null;
  let updateChecking = false;
  els.updatesGroup.hidden = !bridge();

  function saveUpdateState() {
    try {
      storage.setItem(UPDATE_KEY, JSON.stringify(updateState));
    } catch {
      /* private mode */
    }
  }
  function showUpdateNotice() {
    const version = noticeVersion({
      available: !!bridge(),
      enabled: settings.checkUpdates,
      state: updateState,
      running: runningVersion,
    });
    els.updateNotice.hidden = !version;
    if (version) {
      els.updateNotice.dataset.version = version;
      els.updateText.textContent = t('update.available', { version });
    }
  }
  async function checkForUpdates() {
    if (!bridge() || !runningVersion || updateChecking) return showUpdateNotice();
    if (settings.checkUpdates && checkDue(updateState, now())) {
      updateChecking = true;
      let result = null;
      try {
        result = await bridge().check();
      } catch (err) {
        console.warn('update check failed', err);
      }
      updateChecking = false;
      updateState = afterCheck(updateState, result, now());
      saveUpdateState();
    }
    showUpdateNotice();
  }
  async function startUpdateChecks() {
    if (!bridge()) return;
    try {
      updateState = readUpdateState(storage.getItem(UPDATE_KEY));
    } catch {
      /* private mode: start empty */
    }
    try {
      runningVersion = await bridge().version();
    } catch (err) {
      console.warn('running version unknown', err);
      return;
    }
    await checkForUpdates();
    repeat(checkForUpdates, UPDATE_LOOK_MS);
  }
  els.updateOpen.onclick = () => {
    bridge()
      ?.openReleasePage(els.updateNotice.dataset.version)
      .catch(() => {});
  };
  els.updateDismiss.onclick = () => {
    updateState = dismissVersion(updateState, els.updateNotice.dataset.version);
    saveUpdateState();
    showUpdateNotice();
  };

  return { show: showUpdateNotice, check: checkForUpdates, start: startUpdateChecks };
}
