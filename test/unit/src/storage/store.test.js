// How sessions are laid out in storage: the parts of src/storage/store.js that need no IndexedDB,
// and, with the in-memory stand-in of test/support/fake-indexeddb.js, the upgrades and the stores.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  keptFromRecord,
  keptRecord,
  questionFromRecord,
  questionRecord,
  segmentChanges,
  segmentFromRecord,
  segmentRange,
  segmentRecord,
  splitSession,
  summaryFromRecord,
  summaryRecord,
} from '../../../../src/storage/store.js';
import { createFakeIndexedDB } from '../../../support/fake-indexeddb.js';
import { withGlobals } from '../../../support/globals.js';

const twoLanguages = {
  id: 's1',
  title: 'Weekly',
  customTitle: false,
  createdAt: 1,
  updatedAt: 2,
  langA: 'ja',
  langB: 'en',
  activeMs: 5000,
  segments: [
    { id: 'a', at: 10, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。' },
    { id: 'b', at: 20, elapsed: 1000, src: 'Failed.', tgt: undefined },
    { id: 'c', at: 30, elapsed: 2000, src: 'No translation field.' },
  ],
  recordings: [{ id: 'r1', startedAt: 1, elapsedStart: 0, durationMs: 4000, mime: 'audio/webm' }],
};
const threeLanguages = {
  ...twoLanguages,
  id: 's2',
  langC: 'zh',
  segments: [
    {
      id: 'x',
      at: 1,
      elapsed: 0,
      src: 'Bonjour.',
      tgt: 'こんにちは。\nHello.',
      lang: 'other',
      tgts: [
        { lang: 'ja', text: 'こんにちは。' },
        { lang: 'en', text: 'Hello.' },
      ],
    },
  ],
  summary: { overview: 'o', keyPoints: [], decisions: [], actionItems: [], segmentCount: 1 },
};

test('a stored session keeps everything but its segments, plus how many there are', () => {
  const { meta, segments } = splitSession(twoLanguages, { fromDisk: true });
  const { segments: _, ...rest } = twoLanguages;
  assert.deepEqual(meta, { ...rest, segmentCount: 3 });
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(segmentFromRecord), twoLanguages.segments, 'nothing lost, same order');
  assert.deepEqual(
    segments.map((s) => [s.sessionId, s.pos]),
    [
      ['s1', 0],
      ['s1', 1],
      ['s1', 2],
    ],
  );
});

test('three-language segments and the summary survive the split', () => {
  const { meta, segments } = splitSession(threeLanguages, { fromDisk: true });
  assert.deepEqual(meta.summary, threeLanguages.summary);
  assert.equal(meta.langC, 'zh');
  assert.deepEqual(segments.map(segmentFromRecord), threeLanguages.segments);
});

test('the upgrade keeps fields a stored segment has even if the app no longer writes them', () => {
  const old = { ...twoLanguages, segments: [{ id: 'a', at: 1, elapsed: 0, src: 's', tgt: 't', extra: 42 }] };
  assert.equal(splitSession(old, { fromDisk: true }).segments[0].extra, 42);
});

test('saving stores only what a segment is, not its screen state', () => {
  const el = {};
  const seg = { id: 'a', at: 1, elapsed: 0, src: 's', tgt: 't', el, rev: 3, lines: new Map(), spoken: true };
  assert.deepEqual(segmentRecord('s1', 4, seg), {
    sessionId: 's1',
    pos: 4,
    id: 'a',
    at: 1,
    elapsed: 0,
    src: 's',
    tgt: 't',
  });
  const tgts = [{ lang: 'ja', text: 'x', node: el }];
  const record = segmentRecord('s1', 0, { ...seg, lang: 'en', tgts });
  assert.deepEqual(record.tgts, [{ lang: 'ja', text: 'x' }]);
  assert.notEqual(record.tgts[0], tgts[0], 'a copy, so later changes are noticed');
});

test('a session listed without its segments keeps its count and writes no segments', () => {
  const { segments, ...listed } = { ...twoLanguages, segmentCount: 3 };
  const split = splitSession(listed);
  assert.equal(split.segments, null);
  assert.equal(split.meta.segmentCount, 3);
});

test('only new and changed segments are written again', () => {
  const session = structuredClone(twoLanguages);
  const first = splitSession(session).segments;
  assert.deepEqual(segmentChanges(first, null).puts, first, 'nothing known yet: everything');
  assert.deepEqual(segmentChanges(first, first), { puts: [], trimFrom: null }, 'nothing changed');

  session.segments[1].tgt = 'Translated later.';
  session.segments.push({ id: 'd', at: 40, elapsed: 3000, src: 'New.', tgt: '' });
  const second = splitSession(session).segments;
  assert.deepEqual(
    segmentChanges(second, first).puts.map((r) => r.pos),
    [1, 3],
  );

  const three = splitSession(structuredClone(threeLanguages)).segments;
  const changed = structuredClone(threeLanguages);
  changed.segments[0].tgts[1].text = 'Hi.';
  assert.equal(segmentChanges(splitSession(changed).segments, three).puts.length, 1, 'one line of a segment');
});

test('a segment keeps its speaker, and labelling rewrites only the segments whose speaker changed', () => {
  const session = structuredClone(twoLanguages);
  const before = splitSession(session).segments;
  assert.ok(!('speaker' in before[0]), 'no speaker field until there is one');
  session.segments[0].speaker = 's1';
  session.segments[2].speaker = 's2';
  const labeled = splitSession(session).segments;
  assert.equal(labeled[0].speaker, 's1');
  assert.deepEqual(
    segmentChanges(labeled, before).puts.map((r) => r.pos),
    [0, 2],
  );
  session.segments[2].speaker = 's1'; // corrected by hand
  assert.deepEqual(
    segmentChanges(splitSession(session).segments, labeled).puts.map((r) => r.pos),
    [2],
  );
});

test('removed or reordered segments are rewritten or trimmed', () => {
  const session = structuredClone(twoLanguages);
  const before = splitSession(session).segments;
  session.segments.reverse();
  const reordered = segmentChanges(splitSession(session).segments, before);
  assert.deepEqual(
    reordered.puts.map((r) => r.id),
    ['c', 'a'],
  );
  session.segments.splice(1, 2); // c is left, where a was
  const removed = segmentChanges(splitSession(session).segments, before);
  assert.deepEqual(
    removed.puts.map((r) => r.id),
    ['c'],
  );
  assert.equal(removed.trimFrom, 1);
});

test("a session's segment keys sort between the bounds of its range and no other session's", () => {
  // IndexedDB orders numbers before strings before arrays, and arrays element by element.
  const order = (a, b) => {
    const rank = (x) => (Array.isArray(x) ? 2 : typeof x === 'string' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (!Array.isArray(a)) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = order(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  };
  const [lower, upper] = segmentRange('s1');
  // Segment positions, and summary ids (strings), which use the same range.
  for (const pos of [0, 1, 99999, '', '0f8e-summary', 'zzzz']) {
    assert.ok(order(lower, ['s1', pos]) < 0 && order(['s1', pos], upper) < 0);
  }
  for (const other of [
    ['s0', 5],
    ['s10', 0],
    ['s2', 0],
  ]) {
    assert.ok(order(other, lower) < 0 || order(other, upper) > 0, String(other));
  }
});

test('summaries are stored one record each, apart from the session record that the list reads', () => {
  const summary = {
    id: 'sum-1',
    templateId: 'preset:minutes',
    templateName: 'Meeting minutes',
    length: 'short',
    language: 'ja-JP',
    createdAt: 5,
    markdown: '## Decisions\n\n- Ship it',
    model: 'm',
    truncated: false,
    segmentCount: 3,
  };
  const { meta } = splitSession({ ...twoLanguages, summaries: [summary] });
  assert.equal(meta.summaries, undefined, 'not in the session record');
  const record = summaryRecord('s1', summary);
  assert.deepEqual(record, { ...summary, sessionId: 's1' });
  assert.deepEqual(summaryFromRecord(record), summary);
});

test('a question is stored with its session id and only the fields of the layout', () => {
  const entry = {
    id: 'q-1',
    question: 'What was decided?',
    answer: '- Ship on Friday [00:01:05]',
    model: 'm',
    createdAt: 7,
    truncated: false,
    usage: { version: 1 },
  };
  const record = questionRecord('s1', entry);
  const { usage, ...kept } = entry;
  assert.deepEqual(record, { ...kept, sessionId: 's1' });
  assert.deepEqual(questionFromRecord(record), kept);
  const { meta } = splitSession({ ...twoLanguages, questions: [entry] });
  assert.equal(meta.questions, undefined, 'not in the session record');
});

// ---------- with the IndexedDB stand-in ----------

let instance = 0;
// A store module of its own (the module keeps its open database).
const freshStore = async () => (await import(`../../../../src/storage/store.js?instance=${++instance}`)).store;
const opened = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const readAll = async (indexedDB, name) => {
  const db = await opened(indexedDB.open('twinscript'));
  return opened(db.transaction(name).objectStore(name).getAll());
};
const STORES_V5 = ['audio', 'questions', 'segments', 'sessions', 'summaries', 'transcripts'];

// What version 3 of the app left on disk: a session, its segments, a summary and a recording chunk.
const V3 = {
  session: { id: 's1', title: 'Weekly', createdAt: 1, updatedAt: 2, langA: 'ja', langB: 'en', segmentCount: 2 },
  segments: [
    { sessionId: 's1', pos: 0, id: 'a', at: 10, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。' },
    { sessionId: 's1', pos: 1, id: 'b', at: 20, elapsed: 65_000, src: 'Ship it.', tgt: '出荷します。' },
  ],
  summary: { sessionId: 's1', id: 'sum-1', markdown: '## Decisions', createdAt: 5, truncated: false },
  audio: { sessionId: 's1', recId: 'r1', blob: 'chunk' },
};

function seedVersion3(indexedDB) {
  const req = indexedDB.open('twinscript', 3);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore('sessions', { keyPath: 'id' }).put(V3.session);
    const audio = db.createObjectStore('audio', { autoIncrement: true });
    audio.createIndex('recording', ['sessionId', 'recId']);
    audio.createIndex('session', 'sessionId');
    audio.add(V3.audio);
    const segments = db.createObjectStore('segments', { keyPath: ['sessionId', 'pos'] });
    for (const s of V3.segments) segments.put(s);
    db.createObjectStore('summaries', { keyPath: ['sessionId', 'id'] }).put(V3.summary);
  };
  return opened(req);
}

const withFakeDb = (fn) => {
  const fake = createFakeIndexedDB();
  return withGlobals({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange }, () => fn(fake.indexedDB));
};

test('saved sessions of version 3 open at version 5 with stores for questions and kept transcripts and nothing else changed', () =>
  withFakeDb(async (indexedDB) => {
    await seedVersion3(indexedDB);
    const store = await freshStore();
    assert.deepEqual(await store.listSessions(), [V3.session]);

    const db = await opened(indexedDB.open('twinscript'));
    assert.equal(db.version, 5);
    assert.deepEqual([...db.objectStoreNames], STORES_V5);
    assert.deepEqual(await readAll(indexedDB, 'segments'), V3.segments);
    assert.deepEqual(await readAll(indexedDB, 'summaries'), [V3.summary]);
    assert.deepEqual(await readAll(indexedDB, 'audio'), [V3.audio]);
    assert.deepEqual(await readAll(indexedDB, 'questions'), []);
    assert.deepEqual(await readAll(indexedDB, 'transcripts'), []);
    assert.deepEqual(await store.loadSegments('s1'), V3.segments.map(segmentFromRecord));
    assert.deepEqual(await store.loadSummaries('s1'), [summaryFromRecord(V3.summary)]);
    assert.deepEqual(await store.getAudioChunks('s1', 'r1'), ['chunk']);
  }));

test("a session's questions are kept one record each, listed in the order they were asked, and deleted one by one", () =>
  withFakeDb(async (indexedDB) => {
    await seedVersion3(indexedDB);
    const store = await freshStore();
    const ask = (id, createdAt) => ({
      id,
      question: `Q ${id}`,
      answer: `A ${id}`,
      model: 'm',
      createdAt,
      truncated: false,
    });
    await store.putQuestion('s1', ask('zz', 100));
    await store.putQuestion('s1', ask('aa', 200));
    await store.putQuestion('s2', ask('other', 150));
    assert.deepEqual(
      (await store.loadQuestions('s1')).map((q) => q.id),
      ['zz', 'aa'],
      'oldest first, whatever the ids',
    );
    assert.deepEqual((await store.loadQuestions('s1'))[0], ask('zz', 100));
    await store.putQuestion('s1', { ...ask('zz', 100), answer: 'rewritten' });
    assert.equal((await store.loadQuestions('s1'))[0].answer, 'rewritten', 'the same id is replaced, not added');
    await store.deleteQuestion('s1', 'zz');
    assert.deepEqual(
      (await store.loadQuestions('s1')).map((q) => q.id),
      ['aa'],
    );
    assert.deepEqual(
      (await store.loadQuestions('s2')).map((q) => q.id),
      ['other'],
      'another session keeps its own',
    );
    assert.deepEqual(await store.loadQuestions('none'), []);
  }));

test('deleting a session deletes its questions with its segments, summaries and recording', () =>
  withFakeDb(async (indexedDB) => {
    await seedVersion3(indexedDB);
    const store = await freshStore();
    const entry = { id: 'q', question: 'Q', answer: 'A', model: 'm', createdAt: 1, truncated: true };
    await store.putQuestion('s1', entry);
    await store.putQuestion('s2', entry);
    await store.deleteSession('s1');
    assert.deepEqual(await store.listSessions(), []);
    assert.deepEqual(await store.loadQuestions('s1'), []);
    assert.deepEqual(await store.loadSegments('s1'), []);
    assert.deepEqual(await store.loadSummaries('s1'), []);
    assert.deepEqual(await store.getAudioChunks('s1', 'r1'), []);
    assert.deepEqual(await store.loadQuestions('s2'), [entry], "another session's questions stay");
  }));

test('a new install starts at version 5 with every store', () =>
  withFakeDb(async (indexedDB) => {
    const store = await freshStore();
    assert.deepEqual(await store.listSessions(), []);
    const db = await opened(indexedDB.open('twinscript'));
    assert.equal(db.version, 5);
    assert.deepEqual([...db.objectStoreNames], STORES_V5);
  }));

// ---------- a kept transcript ----------

const live = [
  { id: 'a', at: 10, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。', speaker: 's1', el: 'node', rev: 2 },
  { id: 'b', at: 20, elapsed: 65_000, src: 'Ship it.', tgt: '出荷します。' },
];
const liveLabels = { speakers: [{ id: 's1', name: 'Aiko' }], madeAt: 3, uncertain: false, model: 'm' };
const rebuiltLines = [{ id: 'n1', at: 10, elapsed: 0, src: 'Hello, ship it.', tgt: 'こんにちは、出荷して。' }];

test('a kept transcript is stored as its segments are, without their screen state, and read back', () => {
  const record = keptRecord('s1', { segments: live, speakerLabels: liveLabels, keptAt: 9 });
  assert.deepEqual(record, {
    sessionId: 's1',
    keptAt: 9,
    segments: [
      { id: 'a', at: 10, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。', speaker: 's1' },
      { id: 'b', at: 20, elapsed: 65_000, src: 'Ship it.', tgt: '出荷します。' },
    ],
    speakerLabels: liveLabels,
  });
  assert.deepEqual(keptFromRecord(record), { keptAt: 9, segments: record.segments, speakerLabels: liveLabels });
  assert.equal(keptFromRecord(keptRecord('s1', { segments: [], speakerLabels: null, keptAt: 1 })).speakerLabels, null);
});

test('replacing a transcript writes the session and all its new segments together with the one kept, which is loaded only when asked', () =>
  withFakeDb(async (indexedDB) => {
    await seedVersion3(indexedDB);
    const store = await freshStore();
    const [meta] = await store.listSessions();
    const sess = { ...meta, segments: await store.loadSegments('s1'), recordings: [] };
    const kept = { segments: sess.segments, speakerLabels: liveLabels, keptAt: 9 };
    await store.replaceTranscript({ ...sess, segments: rebuiltLines, rebuilt: { madeAt: 9 } }, { kept });
    assert.deepEqual(await store.loadSegments('s1'), rebuiltLines, 'the two old segments are gone');
    assert.equal((await store.listSessions())[0].segmentCount, 1);
    assert.deepEqual((await store.listSessions())[0].rebuilt, { madeAt: 9 });
    const loaded = await store.loadKeptTranscript('s1');
    assert.deepEqual(loaded.segments, V3.segments.map(segmentFromRecord));
    assert.deepEqual(loaded.speakerLabels, liveLabels);
    assert.equal(await store.loadKeptTranscript('s2'), null);

    // Rebuilt again: the kept one stays as it is.
    await store.replaceTranscript({ ...sess, segments: rebuiltLines.slice(0, 1) });
    assert.deepEqual((await store.loadKeptTranscript('s1')).segments, loaded.segments);

    // Put back: the kept one is gone.
    await store.replaceTranscript({ ...sess, segments: loaded.segments }, { kept: null });
    assert.deepEqual(await store.loadSegments('s1'), loaded.segments);
    assert.equal(await store.loadKeptTranscript('s1'), null);
    await assert.rejects(store.replaceTranscript({ ...meta }), /not loaded/);
  }));

test('deleting a session deletes its kept transcript', () =>
  withFakeDb(async (indexedDB) => {
    await seedVersion3(indexedDB);
    const store = await freshStore();
    const sess = { ...V3.session, segments: rebuiltLines, recordings: [] };
    await store.replaceTranscript(sess, { kept: { segments: live, speakerLabels: null, keptAt: 1 } });
    await store.replaceTranscript({ ...sess, id: 's2' }, { kept: { segments: live, speakerLabels: null, keptAt: 1 } });
    await store.deleteSession('s1');
    assert.equal(await store.loadKeptTranscript('s1'), null);
    assert.ok(await store.loadKeptTranscript('s2'), "another session's stays");
  }));

// ---------- a session made from an audio file ----------

test('a session made from a file is stored with its segments and its audio in one go, and deleted with them', () =>
  withFakeDb(async (indexedDB) => {
    const store = await freshStore();
    const sess = {
      ...twoLanguages,
      id: 'imp',
      segments: [{ id: 'a', elapsed: 0, src: 'Hello.', tgt: 'こんにちは。', speaker: 's1', el: 'node' }],
      summaries: [],
      questions: [],
      recordings: [{ id: 'r1', elapsedStart: 0, durationMs: 4000, mime: 'audio/mpeg' }],
    };
    await store.addSession(sess, [{ recId: 'r1', blob: 'the file' }]);
    const [meta] = await store.listSessions();
    assert.equal(meta.id, 'imp');
    assert.equal(meta.segmentCount, 1);
    assert.equal(meta.segments, undefined);
    assert.deepEqual(meta.recordings, sess.recordings);
    assert.deepEqual(await store.loadSegments('imp'), [
      { id: 'a', at: undefined, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。', speaker: 's1' },
    ]);
    assert.deepEqual(await store.getAudioChunks('imp', 'r1'), ['the file']);
    await assert.rejects(store.addSession({ ...meta, id: 'other' }, []), /not loaded/);
    assert.equal((await store.listSessions()).length, 1, 'nothing written without its segments');

    await store.deleteSession('imp');
    assert.deepEqual(await store.listSessions(), []);
    assert.deepEqual(await readAll(indexedDB, 'segments'), []);
    assert.deepEqual(await readAll(indexedDB, 'audio'), []);
  }));
