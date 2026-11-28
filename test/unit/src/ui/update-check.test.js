import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  afterCheck,
  afterManualCheck,
  CHECK_EVERY_MS,
  checkDue,
  dismissVersion,
  emptyUpdateState,
  readUpdateState,
  versionToAnnounce,
} from '../../../../src/ui/update-check.js';

const NOW = Date.UTC(2026, 10, 25, 9);

test('stored update state is read defensively', () => {
  assert.deepEqual(readUpdateState(null), emptyUpdateState());
  assert.deepEqual(readUpdateState('not json'), emptyUpdateState());
  assert.deepEqual(readUpdateState('[1]').checkedAt, 0);
  assert.deepEqual(
    readUpdateState(
      JSON.stringify({ checkedAt: NOW, current: '0.13.0', latest: '0.14.0', newer: true, dismissed: '0.12.0' }),
    ),
    { checkedAt: NOW, current: '0.13.0', latest: '0.14.0', newer: true, dismissed: '0.12.0' },
  );
  assert.deepEqual(
    readUpdateState(JSON.stringify({ checkedAt: 'soon', latest: 'https://evil', newer: 'yes', dismissed: 3 })),
    emptyUpdateState(),
  );
});

test('a check is due at the first start and then once every 24 hours', () => {
  assert.ok(checkDue(emptyUpdateState(), NOW));
  const checked = { ...emptyUpdateState(), checkedAt: NOW };
  assert.ok(!checkDue(checked, NOW + 1000));
  assert.ok(!checkDue(checked, NOW + CHECK_EVERY_MS - 1));
  assert.ok(checkDue(checked, NOW + CHECK_EVERY_MS));
  assert.ok(checkDue(checked, NOW - 60_000), 'a clock that went back');
});

test('an answer is kept; a failure keeps what was known and stays due', () => {
  const answered = afterCheck(emptyUpdateState(), { current: '0.13.0', latest: '0.14.0', newer: true }, NOW);
  assert.deepEqual(answered, { checkedAt: NOW, current: '0.13.0', latest: '0.14.0', newer: true, dismissed: null });
  assert.equal(afterCheck(answered, null, NOW + CHECK_EVERY_MS), answered);
  assert.equal(afterCheck(answered, { current: '0.13.0', latest: 'x' }, NOW + CHECK_EVERY_MS), answered);
  assert.ok(checkDue(afterCheck(emptyUpdateState(), null, NOW), NOW));
});

test('the newer version is announced until it is dismissed; a later one is announced again', () => {
  let state = afterCheck(emptyUpdateState(), { current: '0.13.0', latest: '0.14.0', newer: true }, NOW);
  assert.equal(versionToAnnounce(state, '0.13.0'), '0.14.0');
  state = dismissVersion(state, '0.14.0');
  assert.equal(versionToAnnounce(state, '0.13.0'), null);
  state = afterCheck(state, { current: '0.13.0', latest: '0.15.0', newer: true }, NOW + CHECK_EVERY_MS);
  assert.equal(versionToAnnounce(state, '0.13.0'), '0.15.0');
  assert.equal(dismissVersion(state, 'garbage').dismissed, '0.14.0');
});

test('nothing is announced when not newer, or after the app was updated', () => {
  const same = afterCheck(emptyUpdateState(), { current: '0.14.0', latest: '0.14.0', newer: false }, NOW);
  assert.equal(versionToAnnounce(same, '0.14.0'), null);
  const older = afterCheck(emptyUpdateState(), { current: '0.13.0', latest: '0.14.0', newer: true }, NOW);
  assert.equal(versionToAnnounce(older, '0.14.0'), null, 'the answer was for the version before the update');
  assert.equal(versionToAnnounce(older, null), null);
});

test("a check by hand that finds a newer version counts as the day's check and announces it, even if dismissed", () => {
  const dismissed = dismissVersion(
    afterCheck(emptyUpdateState(), { current: '0.13.0', latest: '0.14.0', newer: true }, NOW),
    '0.14.0',
  );
  const later = NOW + 60_000;
  const done = afterManualCheck(dismissed, { current: '0.13.0', latest: '0.14.0', newer: true }, later);
  assert.equal(done.outcome, 'newer');
  assert.equal(done.version, '0.14.0');
  assert.deepEqual(done.state, { checkedAt: later, current: '0.13.0', latest: '0.14.0', newer: true, dismissed: null });
  assert.equal(versionToAnnounce(done.state, '0.13.0'), '0.14.0');
  assert.ok(!checkDue(done.state, later + 60_000), 'the daily check does not ask again a minute later');
});

test('a check by hand keeps an earlier dismissed version dismissed when it finds another', () => {
  const state = { ...emptyUpdateState(), dismissed: '0.14.0' };
  const done = afterManualCheck(state, { current: '0.13.0', latest: '0.15.0', newer: true }, NOW);
  assert.equal(done.state.dismissed, '0.14.0');
  assert.equal(versionToAnnounce(done.state, '0.13.0'), '0.15.0');
});

test("a check by hand on the latest version says so and counts as the day's check", () => {
  const done = afterManualCheck(emptyUpdateState(), { current: '0.14.0', latest: '0.14.0', newer: false }, NOW);
  assert.deepEqual({ outcome: done.outcome, version: done.version }, { outcome: 'current', version: '0.14.0' });
  assert.equal(done.state.checkedAt, NOW);
  assert.equal(versionToAnnounce(done.state, '0.14.0'), null);
});

test('a check by hand that fails changes nothing, so the daily check still comes when due', () => {
  const state = afterCheck(emptyUpdateState(), { current: '0.13.0', latest: '0.13.0', newer: false }, NOW);
  for (const answer of [null, { current: '0.13.0', latest: 'https://evil' }, { latest: '0.14.0', newer: true }]) {
    const done = afterManualCheck(state, answer, NOW + CHECK_EVERY_MS);
    assert.equal(done.outcome, 'failed');
    assert.equal(done.version, null);
    assert.equal(done.state, state);
    assert.ok(checkDue(done.state, NOW + CHECK_EVERY_MS));
  }
});
