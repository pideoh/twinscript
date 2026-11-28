// When the desktop app asks whether a newer version exists, and which version the page announces.
// The request itself is made by the main process (window.appUpdates, app/updates.js). Pure,
// DOM-free: the state is kept as JSON in localStorage under UPDATE_KEY.
//
// State: { checkedAt, current, latest, newer, dismissed }
//   checkedAt  time of the last check that got an answer (ms), 0 for none
//   current    the version that was running then; latest, newer: what GitHub said
//   dismissed  the version whose notice the user closed
// A check is made at start and once a day while the setting is on (checkDue, afterCheck), or when
// the user asks for one in the settings (afterManualCheck).

export const UPDATE_KEY = 'rt-update';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const version = (v) => (typeof v === 'string' && VERSION.test(v) ? v : null);

export const emptyUpdateState = () => ({ checkedAt: 0, current: null, latest: null, newer: false, dismissed: null });

// The stored state, with anything unreadable replaced by its empty value.
export function readUpdateState(json) {
  let stored;
  try {
    stored = JSON.parse(json ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return emptyUpdateState();
  return {
    checkedAt: Number.isFinite(stored.checkedAt) && stored.checkedAt > 0 ? stored.checkedAt : 0,
    current: version(stored.current),
    latest: version(stored.latest),
    newer: stored.newer === true,
    dismissed: version(stored.dismissed),
  };
}

// Whether it is time to ask again: never asked, or 24 hours since the last answer (or a clock that
// went back).
export const checkDue = (state, now) =>
  !state.checkedAt || now - state.checkedAt >= CHECK_EVERY_MS || now < state.checkedAt;

// The state after check() answered `result` ({ current, latest, newer } or null). A failure
// changes nothing, so the next start (or the next hourly look) asks again.
export function afterCheck(state, result, now) {
  const current = version(result?.current);
  const latest = version(result?.latest);
  if (!current || !latest) return state;
  return { ...state, checkedAt: now, current, latest, newer: result.newer === true };
}

// What a check the user asked for ("Check now") found, and the state after it: { state, outcome,
// version }. outcome is 'newer' (version: the latest), 'current' (version: the running one) or
// 'failed' (version: null). An answer is kept as afterCheck keeps it, so it counts as the day's
// check; a newer version found this way is no longer dismissed (the user asked now). A failure
// changes nothing.
export function afterManualCheck(state, result, now) {
  const next = afterCheck(state, result, now);
  if (next === state) return { state, outcome: 'failed', version: null };
  if (!next.newer) return { state: next, outcome: 'current', version: next.current };
  const dismissed = next.dismissed === next.latest ? null : next.dismissed;
  return { state: { ...next, dismissed }, outcome: 'newer', version: next.latest };
}

// The version to announce while `running` is the running version, or null: the last answer said
// there is a newer one, it was given for this version (not before an update), and that notice
// was not dismissed.
export function versionToAnnounce(state, running) {
  if (!state.newer || !state.latest || !running || state.current !== running) return null;
  return state.latest === state.dismissed ? null : state.latest;
}

export const dismissVersion = (state, v) => ({ ...state, dismissed: version(v) ?? state.dismissed });
