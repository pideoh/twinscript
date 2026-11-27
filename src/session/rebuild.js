// Rebuilding a session's transcript from its recording (made by src/session/recording-transcript.js),
// as the session keeps it: when it is offered, which speaker names carry over to the new transcript,
// how the new transcript takes the place of the one made while listening and how that one is put
// back, and what is older than the transcript now shown. Pure, DOM-free; the panel is
// src/ui/rebuild-panel.js and the storage of the kept transcript src/storage/store.js.
//
// The model: a session keeps at most one other transcript, the one made while listening. A rebuild
// keeps it (unless it is kept already: rebuilding a rebuilt transcript replaces only the rebuilt
// one) and marks the session `rebuilt: { madeAt, model }`. Restoring puts it back with its
// translations and speakers and drops the rebuilt one. Both set `transcriptChangedAt`: summaries and
// answers made before it were made from another transcript than the one shown.

import { hasLabels } from './speaker-labels.js';
import { MIN_CLIP_SHARE, MIN_OVERLAP_WORDS, recordingTimeline, segmentSpans } from './speakers.js';

// A stopped session with a recording can be rebuilt, except in the demo, which has no engine for it.
// Unlike speaker labels it needs no line: a recording whose live transcript is empty is the case it
// helps most. running: whether a run is in progress.
export const canRebuild = (sess, running, demo = false) =>
  !demo && !running && !!sess && sess.recordings.some((rec) => rec.durationMs > 0);

// Whether the transcript made while listening is kept, and can be put back.
export const canRestore = (sess, running) => !running && !!sess?.rebuilt;

// Whether something made at `time` (a summary, an answer) was made from another transcript than the
// one the session shows now.
export const madeBeforeChange = (sess, time) =>
  Number.isFinite(sess?.transcriptChangedAt) && Number.isFinite(time) && time < sess.transcriptChangedAt;

// The session's transcript as it is kept: { segments, speakerLabels } (null without labels).
export const transcriptOf = (sess) => ({
  segments: sess.segments,
  speakerLabels: hasLabels(sess) ? sess.speakerLabels : null,
});

// What a swap changes on the session, to put it back as it was if the swap cannot be saved.
const FIELDS = ['segments', 'speakerLabels', 'rebuilt', 'transcriptChangedAt', 'customTitle', 'title'];
export const snapshot = (sess) => Object.fromEntries(FIELDS.filter((f) => f in sess).map((f) => [f, sess[f]]));
export function putBack(sess, snap) {
  for (const f of FIELDS) {
    if (f in snap) sess[f] = snap[f];
    else delete sess[f];
  }
}

// The title stays what it was: one the app made from the first line would otherwise change with it.
const keepTitle = (sess) => {
  sess.customTitle = true;
};

/**
 * Puts a rebuilt transcript in place of the session's own. segments, speakers: as
 * transcribeRecording gives them (speakers named by keepNames); uncertain, model: of the pass;
 * now: the time. Returns the transcript to keep besides it ({ segments, speakerLabels, keptAt }), or
 * undefined when the one made while listening is kept already (it stays as it is).
 */
export function applyRebuilt(sess, { segments, speakers, uncertain, model, now }) {
  const keep = sess.rebuilt ? undefined : { ...transcriptOf(sess), keptAt: now };
  keepTitle(sess);
  sess.segments = segments;
  if (speakers.length) sess.speakerLabels = { speakers, madeAt: now, uncertain: !!uncertain, model };
  else delete sess.speakerLabels;
  sess.rebuilt = { madeAt: now, model };
  sess.transcriptChangedAt = now;
  return keep;
}

/** Puts the kept transcript ({ segments, speakerLabels }) back in place of the rebuilt one. */
export function applyRestored(sess, kept, now) {
  keepTitle(sess);
  sess.segments = kept.segments;
  if (kept.speakerLabels) sess.speakerLabels = kept.speakerLabels;
  else delete sess.speakerLabels;
  delete sess.rebuilt;
  sess.transcriptChangedAt = now;
}

/**
 * The names the user gave carried over to the speakers of a new transcript, where a new speaker can
 * be matched to an earlier one, with the safeguards speaker labels use between parts: a new speaker
 * takes an earlier one's name only when at least MIN_CLIP_SHARE of its speaking time within earlier
 * lines that had a speaker falls in that speaker's lines, over at least MIN_OVERLAP_WORDS words, and
 * no other new speaker matches the same one. Otherwise its name stays empty (the default).
 *   before: { segments, speakerLabels } of the earlier transcript (segments with `elapsed`, `speaker`);
 *   speakers: [{ id, name }] of the new transcript; words: [{ startMs, endMs, speaker }] in audio
 *   time with the new ids; recordings: [{ elapsedStart, durationMs }] as transcribeRecording gives.
 * Returns the new speakers with names.
 */
export function keepNames(before, { speakers, words, recordings }) {
  const named = new Map((before.speakerLabels?.speakers ?? []).filter((s) => s.name).map((s) => [s.id, s.name]));
  if (!named.size) return speakers;
  // The earlier lines in audio time, with their speakers; each runs to the next one (speakers.js).
  const spans = segmentSpans(before.segments, recordingTimeline(recordings))
    .map((span, i) => span && before.segments[i].speaker && { ...span, speaker: before.segments[i].speaker })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
  const time = new Map(); // new id -> Map(earlier id -> ms)
  const count = new Map(); // new id -> words counted
  let j = 0;
  for (const w of [...words].sort((a, b) => a.startMs - b.startMs)) {
    if (w.speaker == null) continue;
    const mid = (w.startMs + w.endMs) / 2;
    while (j < spans.length && spans[j].endMs <= mid) j++;
    const span = spans[j];
    if (!span || span.startMs > mid) continue;
    if (!time.has(w.speaker)) time.set(w.speaker, new Map());
    const byEarlier = time.get(w.speaker);
    byEarlier.set(span.speaker, (byEarlier.get(span.speaker) ?? 0) + Math.max(1, w.endMs - w.startMs));
    count.set(w.speaker, (count.get(w.speaker) ?? 0) + 1);
  }
  const match = new Map(); // new id -> earlier id
  for (const [id, byEarlier] of time) {
    let top = null;
    let best = 0;
    let total = 0;
    for (const [earlier, ms] of byEarlier) {
      total += ms;
      if (ms > best) [top, best] = [earlier, ms];
    }
    if (count.get(id) >= MIN_OVERLAP_WORDS && best / total >= MIN_CLIP_SHARE) match.set(id, top);
  }
  // Two new speakers that match one earlier speaker: which one it is cannot be told.
  const claims = new Map();
  for (const earlier of match.values()) claims.set(earlier, (claims.get(earlier) ?? 0) + 1);
  return speakers.map((s) => {
    const earlier = match.get(s.id);
    const name = earlier && claims.get(earlier) === 1 ? named.get(earlier) : '';
    return { ...s, name: name ?? '' };
  });
}
