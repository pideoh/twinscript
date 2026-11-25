import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_EVERY_MS, UPDATE_KEY } from '../../../../src/ui/update-check.js';
import { createUpdateNotice, noticeVersion, UPDATE_LOOK_MS } from '../../../../src/ui/update-notice.js';

const NOW = Date.UTC(2026, 10, 25);
const answered = (state) => ({
  checkedAt: NOW,
  current: '1.0.0',
  latest: '1.1.0',
  newer: true,
  dismissed: null,
  ...state,
});
const t = (key, params) => `${key} ${JSON.stringify(params)}`;

// Stand-ins for the elements the notice uses: plain objects with the properties it sets.
const fakeEls = () => ({
  updatesGroup: { hidden: false },
  updateNotice: { hidden: true, dataset: {} },
  updateText: { textContent: '' },
  updateOpen: {},
  updateDismiss: {},
});
function memoryStorage(initial = {}) {
  const items = { ...initial };
  return {
    items,
    getItem: (name) => items[name] ?? null,
    setItem: (name, value) => {
      items[name] = value;
    },
  };
}
function fakeBridge({ running = '1.0.0', answer = { current: '1.0.0', latest: '1.1.0', newer: true } } = {}) {
  const calls = { check: 0, opened: [] };
  return {
    calls,
    version: async () => running,
    check: async () => {
      calls.check++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    openReleasePage: async (version) => {
      calls.opened.push(version);
    },
  };
}
function setup({ bridge = fakeBridge(), storage = memoryStorage(), checkUpdates = true, now = NOW } = {}) {
  const els = fakeEls();
  const settings = { checkUpdates };
  const timers = [];
  const notice = createUpdateNotice({
    els,
    t,
    settings,
    storage,
    bridge: () => bridge,
    now: () => now,
    repeat: (fn, ms) => timers.push({ fn, ms }),
  });
  return { notice, els, settings, storage, bridge, timers };
}

test('the notice names a newer version only in the desktop app and while checking is on', () => {
  const state = answered();
  assert.equal(noticeVersion({ available: true, enabled: true, state, running: '1.0.0' }), '1.1.0');
  assert.equal(noticeVersion({ available: false, enabled: true, state, running: '1.0.0' }), null);
  assert.equal(noticeVersion({ available: true, enabled: false, state, running: '1.0.0' }), null);
  assert.equal(noticeVersion({ available: true, enabled: true, state, running: '1.1.0' }), null, 'already updated');
});

test('outside the desktop app the setting and the notice stay hidden and nothing is asked', async () => {
  const { notice, els, storage, timers } = setup({ bridge: null });
  assert.equal(els.updatesGroup.hidden, true);
  await notice.start();
  assert.equal(els.updateNotice.hidden, true);
  assert.deepEqual(storage.items, {});
  assert.equal(timers.length, 0);
});

test('at start a newer version is asked for, announced, kept for the next start, and looked for hourly', async () => {
  const { notice, els, storage, bridge, timers } = setup();
  assert.equal(els.updatesGroup.hidden, false);
  await notice.start();
  assert.equal(bridge.calls.check, 1);
  assert.equal(els.updateNotice.hidden, false);
  assert.equal(els.updateNotice.dataset.version, '1.1.0');
  assert.equal(els.updateText.textContent, t('update.available', { version: '1.1.0' }));
  assert.equal(JSON.parse(storage.items[UPDATE_KEY]).latest, '1.1.0');
  assert.deepEqual(
    timers.map((x) => x.ms),
    [UPDATE_LOOK_MS],
  );
});

test('within a day of the last answer the kept answer is shown without asking again', async () => {
  const storage = memoryStorage({ [UPDATE_KEY]: JSON.stringify(answered()) });
  const { notice, els, bridge } = setup({ storage, now: NOW + CHECK_EVERY_MS - 1 });
  await notice.start();
  assert.equal(bridge.calls.check, 0);
  assert.equal(els.updateNotice.hidden, false);
});

test('a dismissed version is not announced again, also after a restart', async () => {
  const first = setup();
  await first.notice.start();
  first.els.updateDismiss.onclick();
  assert.equal(first.els.updateNotice.hidden, true);
  const again = setup({ storage: first.storage, now: NOW + CHECK_EVERY_MS });
  await again.notice.start();
  assert.equal(again.bridge.calls.check, 1);
  assert.equal(again.els.updateNotice.hidden, true);
});

test('the notice opens the release page of the version it announces', async () => {
  const { notice, els, bridge } = setup();
  await notice.start();
  els.updateOpen.onclick();
  assert.deepEqual(bridge.calls.opened, ['1.1.0']);
});

test('with checking turned off nothing is asked and the notice is hidden', async () => {
  const storage = memoryStorage({ [UPDATE_KEY]: JSON.stringify(answered()) });
  const { notice, els, settings, bridge } = setup({ storage, checkUpdates: false });
  await notice.start();
  assert.equal(bridge.calls.check, 0);
  assert.equal(els.updateNotice.hidden, true);
  settings.checkUpdates = true;
  await notice.check();
  assert.equal(els.updateNotice.hidden, false, 'turned on again: the kept answer shows');
});

test('a failed check says nothing and is tried again at the next look', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { notice, els, storage, bridge } = setup({ bridge: fakeBridge({ answer: new Error('offline') }) });
    await notice.start();
    assert.equal(els.updateNotice.hidden, true);
    assert.equal(JSON.parse(storage.items[UPDATE_KEY]).checkedAt, 0);
    await notice.check();
    assert.equal(bridge.calls.check, 2);
  } finally {
    console.warn = warn;
  }
});
