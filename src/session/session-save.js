// Saving sessions: what a new session looks like, when a session counts as empty, the title a
// session gets until the user names it and the one a typed name gives it, and the saver that writes changed sessions a moment after
// the last change. DOM-free: the store, the clock and the timers are passed in.
//
// The saver writes whole sessions that were marked changed; the store (src/storage/store.js) then
// writes only the segments that changed since its last save. Empty sessions are never written, so
// opening the app or a new session does not litter the list. A session written for the first time
// is added at the top of the list of saved sessions (getSessions(), the same array the app lists).
//
// A session:
// { id, title, customTitle, createdAt, updatedAt, langA, langB, langC?, activeMs, segmentCount?,
//   usage?, usagePartial?, demo? (src/usage/usage.js, src/usage/usage-log.js),
//   imported? (made from an audio file, src/session/import-audio.js),
//   speakerLabels?: { speakers: [{ id, name }], madeAt, uncertain, model } (src/session/speaker-labels.js),
//   segments: [{ id, at, elapsed, src, tgt, lang?, tgts?, speaker? }],
//   recordings: [{ id, startedAt, elapsedStart, durationMs, mime }],
//   summaries: [{ id, templateId, templateName, length, language, createdAt, markdown, model, truncated,
//                 segmentCount }] (oldest first),
//   summary?: { overview, keyPoints, decisions, actionItems: [{ task, owner, due }], truncated,
//               generatedAt, model, segmentCount } (the one summary an earlier version kept),
//   questions: [{ id, question, answer, model, createdAt, truncated }] (oldest first) }
// With a third language (langC), a segment also has `lang`, the code of the language it was
// spoken in ('other' for none of the three), and `tgts: [{ lang, text }]`, one translation per
// target language; `tgt` then holds those translations joined by line breaks, so everything that
// reads `tgt` works as with two languages.
// Saved sessions are listed without their segments (`segments` is absent and `segmentCount` says
// how many there are) and without their summaries and questions; all are loaded the first time the
// session is shown (src/storage/store.js has how each is stored).

import { emptyUsage } from '../usage/usage.js';
import { formatDateTime } from './exporter.js';

const TITLE_LENGTH = 30;

// A new id for a session or a recording. randomUUID needs a secure context; the fallback takes 128
// bits from the same CSPRNG.
export const uid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

// A new session in the languages selected in `settings`; id and now (epoch ms) are passed in.
// A session with two languages has no langC at all.
export function blankSession(settings, { id, now }) {
  return {
    id,
    title: '',
    customTitle: false,
    createdAt: now,
    updatedAt: now,
    langA: settings.langA,
    langB: settings.langB,
    ...(settings.langC && { langC: settings.langC }),
    activeMs: 0,
    usage: emptyUsage(), // what it used of the API (src/usage/usage.js); absent in sessions made before it was counted
    segments: [],
    summaries: [],
    questions: [],
    recordings: [],
  };
}

// Nothing said and nothing recorded. A saved session not yet opened has segmentCount, not segments.
export const isEmpty = (sess) => !(sess.segments?.length ?? sess.segmentCount) && !sess.recordings.length;

// The title of a session the user has not named: the start of its first sentence, or when it was
// made while there is none.
export const autoTitle = (sess) => sess.segments[0]?.src.slice(0, TITLE_LENGTH) || formatDateTime(sess.createdAt);

// The title a name typed by the user gives a session whose title is `title`: the name without the
// spaces around it, or null when that leaves nothing or the same title (the session keeps its own).
export function typedTitle(typed, title) {
  const name = typed.trim();
  return name && name !== title ? name : null;
}

// store: saveSession(sess) -> Promise, requestPersistence(); getSessions(): the saved sessions,
// newest first (a new one is put at the top of this array); beforeSave(sess): brings a session's
// running figures up to date just before it is written; onFlushed(): after each round of saves
// (the list of sessions may have changed); onSaveFailed(err): a write failed; now(), setTimer(fn, ms),
// clearTimer(id): the clock and timers; delay: how long after the last change the saves are written.
export function createSessionSaver({
  store,
  getSessions,
  beforeSave = () => {},
  onFlushed = () => {},
  onSaveFailed = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delay = 250,
}) {
  const dirty = new Set();
  const forgotten = new WeakSet(); // deleted sessions: work on them that finishes later is not saved
  let saveTimer;

  // The session changed: it is written `delay` ms after the last change to any session.
  function markDirty(sess) {
    if (forgotten.has(sess)) return;
    dirty.add(sess);
    clearTimer(saveTimer);
    saveTimer = setTimer(flushSaves, delay);
  }

  // Writes every changed session now.
  function flushSaves() {
    clearTimer(saveTimer);
    for (const sess of dirty) {
      if (isEmpty(sess)) continue; // don't litter the list with untouched sessions
      beforeSave(sess);
      sess.updatedAt = now();
      if (!sess.customTitle && sess.segments) sess.title = autoTitle(sess);
      const sessions = getSessions();
      if (!sessions.includes(sess)) {
        sessions.unshift(sess);
        store.requestPersistence();
      }
      store.saveSession(sess).catch(onSaveFailed);
    }
    dirty.clear();
    onFlushed();
  }

  return {
    markDirty,
    flushSaves,
    // A session about to be deleted is not written again, even when it is marked changed later.
    forget: (sess) => {
      forgotten.add(sess);
      dirty.delete(sess);
    },
    isForgotten: (sess) => forgotten.has(sess),
  };
}
