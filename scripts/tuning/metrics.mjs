// Scores for how translations of speech appeared on screen. Pure functions.
//
// A sentence is { firstInterimAt, finishedAt, finalShownAt, finalText, displays: [{ t, text }] }:
// when its in-progress text first appeared (null if it was finished without any), when it was
// finished, when its final translation was complete on screen, that translation, and every text
// shown for it in time order (translations of the text in progress, streamed pieces of the final
// one, the final one).

const chars = (s) => Array.from(s ?? '');

// Characters of `prev` that are not kept as a prefix by `next`.
export function erased(prev, next) {
  const a = chars(prev);
  const b = chars(next);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length - i;
}

export function sentenceMetrics({
  firstInterimAt = null,
  finishedAt = null,
  finalShownAt = null,
  finalText,
  displays,
}) {
  const first = displays[0];
  let erasedChars = 0;
  let updates = 0;
  let prev = '';
  for (const { text } of displays) {
    if (text === prev) continue;
    erasedChars += erased(prev, text);
    updates++;
    prev = text;
  }
  const finalLength = chars(finalText ?? prev).length;
  return {
    firstDelayMs: firstInterimAt !== null && first ? first.t - firstInterimAt : null,
    finalDelayMs: finishedAt !== null && finalShownAt !== null ? finalShownAt - finishedAt : null,
    flicker: finalLength ? erasedChars / finalLength : 0,
    erasedChars,
    updates,
  };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Nearest-rank percentile.
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

const stats = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return { n: v.length, mean: mean(v), median: median(v), p90: percentile(v, 90) };
};

// rows: the output of sentenceMetrics for each sentence; counts: { requests, rateLimited }.
export function aggregate(rows, counts = {}) {
  return {
    sentences: rows.length,
    firstDelayMs: stats(rows.map((r) => r.firstDelayMs)),
    finalDelayMs: stats(rows.map((r) => r.finalDelayMs)),
    flicker: stats(rows.map((r) => r.flicker)),
    erasedChars: rows.reduce((a, r) => a + r.erasedChars, 0),
    updates: rows.reduce((a, r) => a + r.updates, 0),
    requests: counts.requests ?? 0,
    rateLimited: counts.rateLimited ?? 0,
  };
}

const ms = (x) => (x === null ? '-' : String(Math.round(x)));
const ratio = (x) => (x === null ? '-' : x.toFixed(2));

// One line per run: label and aggregate.
export function formatTable(runs) {
  const head = [
    'strategy',
    'sentences',
    'first ms mean/med/p90',
    'final ms mean/med/p90',
    'flicker mean/med/p90',
    'erased',
    'updates',
    'requests',
    'rateLimited',
  ];
  const lines = runs.map(({ label, summary: a }) => [
    label,
    String(a.sentences),
    [a.firstDelayMs.mean, a.firstDelayMs.median, a.firstDelayMs.p90].map(ms).join('/'),
    [a.finalDelayMs.mean, a.finalDelayMs.median, a.finalDelayMs.p90].map(ms).join('/'),
    [a.flicker.mean, a.flicker.median, a.flicker.p90].map(ratio).join('/'),
    String(a.erasedChars),
    String(a.updates),
    String(a.requests),
    String(a.rateLimited),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const row = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [row(head), ...lines.map(row)].join('\n');
}

// sentences: [{ finishedAt, displays: [{ t }], settled? }]; counts: { failed, lastError, answerMs: [] }.
// settled: the sentence's final translation was an in-progress one, with no final request.
export function health(sentences, counts = {}) {
  const live = sentences.filter((s) => s.displays.some((d) => d.t < s.finishedAt)).length;
  return {
    settledSentences: sentences.filter((s) => s.settled).length,
    failed: counts.failed ?? 0,
    lastError: counts.lastError ?? null,
    answerMs: stats(counts.answerMs ?? []),
    liveSentences: live,
    sentences: sentences.length,
  };
}

export function formatHealth(runs) {
  const head = ['strategy', 'failed', 'answer ms mean/med/p90', 'live', 'settled', 'last error'];
  const lines = runs.map(({ label, health: h }) => [
    label,
    String(h.failed),
    [h.answerMs.mean, h.answerMs.median, h.answerMs.p90].map(ms).join('/'),
    `${h.liveSentences}/${h.sentences}`,
    `${h.settledSentences ?? 0}/${h.sentences}`,
    h.lastError ? String(h.lastError).replace(/\s+/g, ' ').slice(0, 80) : '',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const row = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [row(head), ...lines.map(row)].join('\n');
}
