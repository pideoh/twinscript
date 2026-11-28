// The notice of a newer version (desktop app). The main process asks GitHub (app/updates.js, exposed
// as window.appUpdates); this page decides when (src/ui/update-check.js): at start and then at most
// once every 24 hours, only while the setting is on, or at once when the user asks ("Check now" in
// the settings calls checkNow()). The last answer is kept, so the notice comes back at the next
// start without a request until it is dismissed or the app is updated. Failures say nothing here;
// checkNow() hands them to the settings, which say so. Also shows the running version there.

import {
  afterCheck,
  afterManualCheck,
  checkDue,
  dismissVersion,
  readUpdateState,
  UPDATE_KEY,
  versionToAnnounce,
} from './update-check.js';

export const UPDATE_LOOK_MS = 60 * 60 * 1000; // how often a long-running app looks whether a check is due

// The version the notice announces, or null for none: only in the desktop app (`available`), and
// while "Check for new versions" is on (`enabled`) or when it is the version the user found by asking
// (`asked`, for as long as the app runs).
export function noticeVersion({ available, enabled, state, running, asked = null }) {
  const version = available ? versionToAnnounce(state, running) : null;
  return enabled || version === asked ? version : null;
}

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
  let asking = null; // the request in flight: a check made meanwhile waits for it instead of asking again
  let askedVersion = null; // a newer version the user found with "Check now"
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
      asked: askedVersion,
    });
    els.updateNotice.hidden = !version;
    if (version) {
      els.updateNotice.dataset.version = version;
      els.updateText.textContent = t('update.available', { version });
    }
    els.appVersion.hidden = !runningVersion;
    els.appVersion.textContent = runningVersion ? t('settings.version', { version: runningVersion }) : '';
  }
  // check()'s answer, or null when it failed.
  function ask() {
    asking ??= Promise.resolve()
      .then(() => bridge().check())
      .catch((err) => {
        console.warn('update check failed', err);
        return null;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  }
  async function checkForUpdates() {
    if (!bridge() || !runningVersion || asking) return showUpdateNotice();
    if (settings.checkUpdates && checkDue(updateState, now())) {
      const result = await ask();
      updateState = afterCheck(updateState, result, now());
      saveUpdateState();
    }
    showUpdateNotice();
  }
  // Asks at once, whatever the schedule and the setting. Resolves to { outcome, version }
  // (afterManualCheck): 'newer', 'current' or 'failed'.
  async function checkNow() {
    if (!bridge()) return { outcome: 'failed', version: null };
    const done = afterManualCheck(updateState, await ask(), now());
    if (done.state !== updateState) {
      updateState = done.state;
      saveUpdateState();
    }
    if (done.outcome === 'newer') askedVersion = done.version;
    showUpdateNotice();
    return { outcome: done.outcome, version: done.version };
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
    showUpdateNotice(); // the version, and the last answer, before GitHub answers again
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

  return { show: showUpdateNotice, check: checkForUpdates, checkNow, start: startUpdateChecks };
}
