// Debug-only (?debug=1) record of what the recognizer delivered during one run, for tuning
// segmentation and translation timing offline. The text is the raw recognizer text, before the
// correction rules. DOM-free; the clock is injectable so timing can be tested.

export const TRACE_VERSION = 1;

// langs: language codes in the order of the selects; source: 'mic' | 'system' | 'both' | 'file'.
// now(): milliseconds from a monotonic clock; date(): the wall-clock start.
export function createTrace({
  langs = [],
  source = 'mic',
  now = () => performance.now(),
  date = () => new Date(),
} = {}) {
  const origin = now();
  const startedAt = date().toISOString();
  const events = [];
  let durationMs = null;
  const elapsed = () => Math.max(0, Math.round(now() - origin));
  return {
    add(kind, text) {
      if (durationMs !== null) return; // nothing is recorded after the run ended
      events.push({ t: elapsed(), kind, text });
    },
    end() {
      if (durationMs === null) durationMs = elapsed();
    },
    toJSON() {
      return {
        version: TRACE_VERSION,
        startedAt,
        langs: [...langs],
        source,
        events: events.map((e) => ({ ...e })),
        durationMs: durationMs ?? elapsed(),
      };
    },
  };
}

// twinscript-trace-yyyymmdd-hhmmss.json, in local time.
export function traceFileName(date) {
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const time = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `twinscript-trace-${day}-${time}.json`;
}
