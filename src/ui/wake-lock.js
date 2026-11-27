// Keeps the screen on while listening, where the browser allows it. The system drops the lock when
// the page is hidden, so it is asked for again when the page is shown while still listening.
// isRunning(): whether a run is in progress.

export function createWakeLock({ isRunning }) {
  let lock = null;
  async function hold() {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      /* unsupported or denied */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (isRunning() && document.visibilityState === 'visible') hold();
  });
  return {
    hold,
    release() {
      lock?.release().catch(() => {});
      lock = null;
    },
  };
}
