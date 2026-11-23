// A simulated clock for the replay's --mock mode and for tests: timers run in time order, as fast as
// the code allows, and promise chains settle between two timers. Same results on every run.

const settle = () => new Promise((resolve) => setImmediate(resolve));

export function createVirtualClock(start = 0) {
  let time = start;
  let seq = 0;
  const timers = new Map(); // id -> { at, seq, fn }

  const next = () => {
    let best = null;
    for (const [id, x] of timers) {
      if (!best || x.at < best.at || (x.at === best.at && x.seq < best.seq)) best = { id, ...x };
    }
    return best;
  };

  const clock = {
    now: () => time,
    setTimer(fn, ms = 0) {
      const id = ++seq;
      timers.set(id, { at: time + Math.max(0, ms), seq: id, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    // Runs every timer due up to now + ms, then leaves the clock at now + ms.
    async advance(ms) {
      const until = time + ms;
      await settle();
      for (let x = next(); x && x.at <= until; x = next()) {
        timers.delete(x.id);
        time = x.at;
        x.fn();
        await settle();
      }
      time = until;
    },
    // Runs timers until none are left.
    async runAll() {
      await settle();
      for (let x = next(); x; x = next()) {
        timers.delete(x.id);
        time = x.at;
        x.fn();
        await settle();
      }
    },
  };
  return clock;
}
