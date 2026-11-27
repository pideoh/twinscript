// Persistence in IndexedDB. The only module that knows the layout:
//   sessions  keyPath 'id': a session's metadata (everything but its segments) and `segmentCount`.
//   segments  keyPath ['sessionId', 'pos']: one record per segment, `pos` being its index in the
//             session, so a session's segments are one key range, in order, and one segment can be
//             rewritten on its own.
//   summaries keyPath ['sessionId', 'id']: every summary made of a session, one record each
//             (they can be made as often as wanted, so they stay out of the list of sessions).
//   questions keyPath ['sessionId', 'id']: every question asked about a session and its answer, one
//             record each: { sessionId, id, question, answer, model, createdAt, truncated }.
//   audio     auto-increment: recorded chunks { sessionId, recId, blob }.
//   transcripts keyPath 'sessionId': the one transcript kept besides a session's own, once its
//             transcript was rebuilt from the recording (src/session/rebuild.js): { sessionId, keptAt,
//             segments: [segment records without sessionId and pos], speakerLabels? }. It is read
//             only to put it back, and written together with the session it belongs to.
// Version 1 kept the segments inside the session record; the upgrade to version 2 moves them out.
// Version 3 adds `summaries`. A session saved by an earlier version may still hold its one
// summary in the old shape (`summary`, structured JSON) in its record: it is left there and shown
// by the app as the oldest entry of the session's summaries.
// Version 4 adds `questions`; nothing else is moved or rewritten.
// Version 5 adds `transcripts`; nothing else is moved or rewritten.

const DB_NAME = 'twinscript';
const DB_VERSION = 5;
let dbPromise;

// ---------- pure helpers (no IndexedDB; unit-tested) ----------

// All segment (and summary and question) keys of a session lie between these: arrays sort after numbers and strings.
export const segmentRange = (sessionId) => [[sessionId], [sessionId, []]];

// The stored form of an in-memory segment (which also carries DOM nodes and translation state).
// `speaker` is the id of who said it, once the session's speakers have been labelled.
export function segmentRecord(sessionId, pos, { id, at, elapsed, src, tgt, lang, tgts, speaker }) {
  return {
    sessionId,
    pos,
    id,
    at,
    elapsed,
    src,
    tgt,
    ...(lang && { lang }),
    ...(tgts && { tgts: tgts.map(({ lang, text }) => ({ lang, text })) }),
    ...(speaker && { speaker }),
  };
}

// A stored segment as the app uses it.
export function segmentFromRecord(record) {
  const { sessionId, pos, ...segment } = record;
  return segment;
}

const sameTargets = (a, b) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x.lang === b[i].lang && x.text === b[i].text));
export const sameSegment = (a, b) =>
  !!a &&
  !!b &&
  a.sessionId === b.sessionId &&
  a.pos === b.pos &&
  a.id === b.id &&
  a.at === b.at &&
  a.elapsed === b.elapsed &&
  a.src === b.src &&
  a.tgt === b.tgt &&
  a.lang === b.lang &&
  a.speaker === b.speaker &&
  sameTargets(a.tgts, b.tgts);

// Splits a session into the record for `sessions` and the records for `segments`. A session whose
// segments are not loaded (`segments` absent) keeps the count it was listed with and yields no
// segment records. Used for saving and, on records read from disk, by the upgrade from version 1,
// which keeps every field a stored segment has.
// The session's summaries and questions (`summaries`, `questions`, in memory once loaded) are not
// part of either: they are written one by one (store.putSummary, store.putQuestion).
export function splitSession(session, { fromDisk = false } = {}) {
  const { segments, summaries, questions, ...meta } = session;
  if (!Array.isArray(segments)) return { meta: { ...meta, segmentCount: meta.segmentCount ?? 0 }, segments: null };
  return {
    meta: { ...meta, segmentCount: segments.length },
    segments: segments.map((seg, pos) =>
      fromDisk ? { ...seg, sessionId: session.id, pos } : segmentRecord(session.id, pos, seg),
    ),
  };
}

// What a save has to write, given the segment records last written for the session (`saved`,
// null when nothing is known about them). `puts`: the records that differ; `trimFrom`: the
// position from which stored segments no longer exist, or null.
export function segmentChanges(records, saved) {
  const puts = saved ? records.filter((rec, i) => !sameSegment(rec, saved[i])) : records;
  const trimFrom = saved && saved.length > records.length ? records.length : null;
  return { puts, trimFrom };
}

// ---------- IndexedDB ----------

function upgrade(db, tx, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('sessions', { keyPath: 'id' });
    const audio = db.createObjectStore('audio', { autoIncrement: true });
    audio.createIndex('recording', ['sessionId', 'recId']);
    audio.createIndex('session', 'sessionId');
  }
  if (oldVersion < 2) {
    const segments = db.createObjectStore('segments', { keyPath: ['sessionId', 'pos'] });
    // Inside the version-change transaction: if any write fails, the whole upgrade is aborted and
    // the database stays at version 1, untouched.
    tx.objectStore('sessions').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const split = splitSession(cursor.value, { fromDisk: true });
      for (const record of split.segments ?? []) segments.put(record);
      cursor.update(split.meta);
      cursor.continue();
    };
  }
  if (oldVersion < 3) db.createObjectStore('summaries', { keyPath: ['sessionId', 'id'] });
  if (oldVersion < 4) db.createObjectStore('questions', { keyPath: ['sessionId', 'id'] });
  if (oldVersion < 5) db.createObjectStore('transcripts', { keyPath: 'sessionId' });
}

// The stored form of a summary, and back.
export const summaryRecord = (sessionId, summary) => ({ ...summary, sessionId });
export function summaryFromRecord(record) {
  const { sessionId, ...summary } = record;
  return summary;
}

// The stored form of a question and its answer: only the fields of the layout above (what a
// request used is counted in the session's usage, not here), and back.
export const questionRecord = (sessionId, { id, question, answer, model, createdAt, truncated }) => ({
  sessionId,
  id,
  question,
  answer,
  model,
  createdAt,
  truncated: !!truncated,
});
export function questionFromRecord(record) {
  const { sessionId, ...entry } = record;
  return entry;
}

// The stored form of a kept transcript ({ segments, speakerLabels, keptAt }), and back. Its
// segments are stored as the segments store has them, without the key.
export function keptRecord(sessionId, { segments, speakerLabels, keptAt }) {
  return {
    sessionId,
    keptAt,
    segments: segments.map((seg, pos) => segmentFromRecord(segmentRecord(sessionId, pos, seg))),
    ...(speakerLabels && { speakerLabels }),
  };
}
export function keptFromRecord(record) {
  const { sessionId, ...kept } = record;
  return { ...kept, speakerLabels: kept.speakerLabels ?? null };
}

// Called when the upgrade has to wait because another window of an earlier version still has the
// database open; it goes on by itself once that window is closed.
let onBlocked = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => upgrade(request.result, request.transaction, e.oldVersion);
    request.onblocked = () => onBlocked?.();
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version in another tab upgrade instead of waiting for this one to close.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

async function write(stores, fn) {
  const tx = (await open()).transaction(stores, 'readwrite');
  fn(tx);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const rangeOf = (sessionId) => IDBKeyRange.bound(...segmentRange(sessionId));

// The segment records last written (or read) per session id, so a save writes only what changed.
const written = new Map();

export const store = {
  // cb(): the saved sessions cannot be opened until another, older window of the app is closed.
  onUpgradeBlocked(cb) {
    onBlocked = cb;
  },
  // Metadata only (no segments), newest first.
  async listSessions() {
    const all = await done((await open()).transaction('sessions').objectStore('sessions').getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  // A session's segments, in order.
  async loadSegments(sessionId) {
    const records = await done(
      (await open()).transaction('segments').objectStore('segments').getAll(rangeOf(sessionId)),
    );
    written.set(sessionId, records);
    return records.map(segmentFromRecord);
  },

  // Writes the session record and the segments that changed since the last save. What is written
  // is taken from `session` now, so later changes to it go into the next save.
  saveSession(session) {
    const { meta, segments } = splitSession(session);
    const before = written.get(session.id) ?? null;
    const changes = segments && segmentChanges(segments, before);
    if (segments) written.set(session.id, segments);
    return write(['sessions', 'segments'], (tx) => {
      tx.objectStore('sessions').put(meta);
      if (!changes) return;
      const rows = tx.objectStore('segments');
      for (const record of changes.puts) rows.put(record);
      if (changes.trimFrom !== null) rows.delete(IDBKeyRange.bound([session.id, changes.trimFrom], [session.id, []]));
    }).catch((err) => {
      written.delete(session.id); // not known what is on disk: the next save writes every segment
      throw err;
    });
  },

  // Writes the session record and all its segments in place of those stored, in one transaction with
  // the transcript kept besides it: `kept` is put ({ segments, speakerLabels, keptAt }), deleted
  // (null) or left as it is (undefined). Either all of it is written or none of it.
  replaceTranscript(session, { kept } = {}) {
    const { meta, segments } = splitSession(session);
    if (!segments) return Promise.reject(new Error('the segments of the session are not loaded'));
    written.set(session.id, segments);
    return write(['sessions', 'segments', 'transcripts'], (tx) => {
      tx.objectStore('sessions').put(meta);
      const rows = tx.objectStore('segments');
      rows.delete(rangeOf(session.id));
      for (const record of segments) rows.put(record);
      const transcripts = tx.objectStore('transcripts');
      if (kept) transcripts.put(keptRecord(session.id, kept));
      else if (kept === null) transcripts.delete(session.id);
    }).catch((err) => {
      written.delete(session.id);
      throw err;
    });
  },

  // The transcript kept besides a session's own, or null.
  async loadKeptTranscript(sessionId) {
    const record = await done((await open()).transaction('transcripts').objectStore('transcripts').get(sessionId));
    return record ? keptFromRecord(record) : null;
  },

  // A session's summaries, oldest first.
  async loadSummaries(sessionId) {
    const records = await done(
      (await open()).transaction('summaries').objectStore('summaries').getAll(rangeOf(sessionId)),
    );
    return records.map(summaryFromRecord).sort((a, b) => a.createdAt - b.createdAt);
  },

  putSummary(sessionId, summary) {
    return write('summaries', (tx) => tx.objectStore('summaries').put(summaryRecord(sessionId, summary)));
  },

  deleteSummary(sessionId, id) {
    return write('summaries', (tx) => tx.objectStore('summaries').delete([sessionId, id]));
  },

  // A session's questions and answers, in the order they were asked.
  async loadQuestions(sessionId) {
    const records = await done(
      (await open()).transaction('questions').objectStore('questions').getAll(rangeOf(sessionId)),
    );
    return records.map(questionFromRecord).sort((a, b) => a.createdAt - b.createdAt);
  },

  putQuestion(sessionId, entry) {
    return write('questions', (tx) => tx.objectStore('questions').put(questionRecord(sessionId, entry)));
  },

  deleteQuestion(sessionId, id) {
    return write('questions', (tx) => tx.objectStore('questions').delete([sessionId, id]));
  },

  deleteSession(id) {
    written.delete(id);
    return write(['sessions', 'segments', 'summaries', 'questions', 'transcripts', 'audio'], (tx) => {
      tx.objectStore('sessions').delete(id);
      tx.objectStore('transcripts').delete(id);
      tx.objectStore('segments').delete(rangeOf(id));
      tx.objectStore('summaries').delete(rangeOf(id));
      tx.objectStore('questions').delete(rangeOf(id));
      const audio = tx.objectStore('audio');
      audio.index('session').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        audio.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  },

  addAudioChunk(sessionId, recId, blob) {
    return write('audio', (tx) => tx.objectStore('audio').add({ sessionId, recId, blob }));
  },

  // Chunks of one recording, in the order they were recorded.
  async getAudioChunks(sessionId, recId) {
    const index = (await open()).transaction('audio').objectStore('audio').index('recording');
    return (await done(index.getAll(IDBKeyRange.only([sessionId, recId])))).map((row) => row.blob);
  },

  // Ask the browser not to evict our data under storage pressure.
  requestPersistence() {
    navigator.storage?.persist?.().catch(() => {});
  },
};
