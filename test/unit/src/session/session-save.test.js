import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDateTime } from '../../../../src/session/exporter.js';
import { autoTitle, blankSession, createSessionSaver, isEmpty } from '../../../../src/session/session-save.js';

// A clock and timers the test moves by hand.
function fakeClock(start = 1_000_000) {
  let now = start;
  let next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function fakeStore({ fail = false } = {}) {
  return {
    saved: [],
    persistence: 0,
    saveSession(sess) {
      this.saved.push({ id: sess.id, title: sess.title, updatedAt: sess.updatedAt, activeMs: sess.activeMs });
      return fail ? Promise.reject(new Error('disk full')) : Promise.resolve();
    },
    requestPersistence() {
      this.persistence++;
    },
  };
}

const settings = { langA: 'ja-JP', langB: 'en-US', langC: '' };
const spoken = (id, ...texts) => ({
  ...blankSession(settings, { id, now: 500 }),
  segments: texts.map((src, i) => ({ id: `${id}-${i}`, src, tgt: '' })),
});

function setup(options = {}) {
  const clock = fakeClock();
  const store = fakeStore(options);
  const sessions = options.sessions ?? [];
  let flushed = 0;
  const failures = [];
  const saver = createSessionSaver({
    store,
    getSessions: () => sessions,
    beforeSave: options.beforeSave,
    onFlushed: () => flushed++,
    onSaveFailed: (err) => failures.push(err.message),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, store, sessions, saver, failures, flushed: () => flushed };
}

test('a new session has the selected languages, no third one when there is none, and nothing in it', () => {
  const sess = blankSession(settings, { id: 'a', now: 42 });
  assert.equal(sess.id, 'a');
  assert.equal(sess.createdAt, 42);
  assert.equal(sess.updatedAt, 42);
  assert.equal(sess.langA, 'ja-JP');
  assert.equal(sess.langB, 'en-US');
  assert.equal('langC' in sess, false);
  assert.deepEqual([sess.segments, sess.summaries, sess.recordings], [[], [], []]);
  assert.equal(sess.title, '');
  assert.equal(sess.customTitle, false);
  assert.equal(blankSession({ ...settings, langC: 'ko-KR' }, { id: 'b', now: 42 }).langC, 'ko-KR');
});

test('a session with nothing said and nothing recorded counts as empty, also before its segments are loaded', () => {
  assert.equal(isEmpty(blankSession(settings, { id: 'a', now: 1 })), true);
  assert.equal(isEmpty(spoken('a', 'Hello.')), false);
  assert.equal(isEmpty({ segmentCount: 3, recordings: [] }), false);
  assert.equal(isEmpty({ segmentCount: 0, recordings: [] }), true);
  assert.equal(isEmpty({ ...blankSession(settings, { id: 'a', now: 1 }), recordings: [{ id: 'r' }] }), false);
});

test('a session is named after the start of its first sentence, or when it was made', () => {
  assert.equal(
    autoTitle(spoken('a', 'Good morning, everyone. Shall we begin with the agenda?')),
    'Good morning, everyone. Shall ',
  );
  const silent = { ...blankSession(settings, { id: 'b', now: Date.UTC(2026, 0, 2, 3, 4) }), segments: [] };
  assert.equal(autoTitle(silent), formatDateTime(silent.createdAt));
});

test('changes are written once, a moment after the last one', () => {
  const { clock, store, saver } = setup();
  const sess = spoken('a', 'Hello.');
  saver.markDirty(sess);
  clock.advance(200);
  saver.markDirty(sess);
  clock.advance(200);
  assert.equal(store.saved.length, 0);
  clock.advance(50);
  assert.deepEqual(
    store.saved.map((x) => x.id),
    ['a'],
  );
  clock.advance(1000);
  assert.equal(store.saved.length, 1);
});

test('only the sessions that changed are written', () => {
  const a = spoken('a', 'Hello.');
  const b = spoken('b', 'Bye.');
  const { store, saver } = setup({ sessions: [b, a] });
  saver.markDirty(a);
  saver.flushSaves();
  assert.deepEqual(
    store.saved.map((x) => x.id),
    ['a'],
  );
});

test('an empty session is not written and does not appear in the list', () => {
  const { store, saver, sessions, flushed } = setup();
  saver.markDirty(blankSession(settings, { id: 'a', now: 1 }));
  saver.flushSaves();
  assert.equal(store.saved.length, 0);
  assert.equal(sessions.length, 0);
  assert.equal(flushed(), 1);
});

test('a session written for the first time goes to the top of the list, and persistent storage is asked for', () => {
  const old = spoken('old', 'Earlier.');
  const { store, saver, sessions } = setup({ sessions: [old] });
  const sess = spoken('new', 'Now.');
  saver.markDirty(sess);
  saver.flushSaves();
  assert.deepEqual(sessions, [sess, old]);
  assert.equal(store.persistence, 1);
  saver.markDirty(sess);
  saver.flushSaves();
  assert.deepEqual(sessions, [sess, old]);
  assert.equal(store.persistence, 1);
});

test('a written session gets the time of the save and its title, but keeps a title the user gave', () => {
  const { clock, saver } = setup();
  const sess = spoken('a', 'Hello there.');
  saver.markDirty(sess);
  saver.flushSaves();
  assert.equal(sess.updatedAt, clock.now());
  assert.equal(sess.title, 'Hello there.');
  sess.title = 'Weekly';
  sess.customTitle = true;
  saver.markDirty(sess);
  saver.flushSaves();
  assert.equal(sess.title, 'Weekly');
});

test('a session that is not loaded yet keeps its title', () => {
  const { saver } = setup();
  const sess = { id: 'a', title: 'Kept', customTitle: false, segmentCount: 2, recordings: [], createdAt: 1 };
  saver.markDirty(sess);
  saver.flushSaves();
  assert.equal(sess.title, 'Kept');
});

test('the session being recorded is brought up to date just before it is written', () => {
  const seen = [];
  const { store, saver } = setup({
    beforeSave: (sess) => {
      seen.push(sess.id);
      sess.activeMs = 12_345;
    },
  });
  const sess = spoken('a', 'Hello.');
  saver.markDirty(sess);
  saver.markDirty(blankSession(settings, { id: 'empty', now: 1 }));
  saver.flushSaves();
  assert.deepEqual(seen, ['a']);
  assert.equal(store.saved[0].activeMs, 12_345);
});

test('a session deleted before its save is not written', () => {
  const { clock, store, saver } = setup();
  const sess = spoken('a', 'Hello.');
  saver.markDirty(sess);
  saver.forget(sess);
  clock.advance(1000);
  assert.equal(store.saved.length, 0);
});

test('a failed write is reported', async () => {
  const { saver, failures } = setup({ fail: true });
  saver.markDirty(spoken('a', 'Hello.'));
  saver.flushSaves();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, ['disk full']);
});
