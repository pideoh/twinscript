import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECK_TIMEOUT_MS,
  checkForUpdate,
  compareVersions,
  parseRelease,
  parseVersion,
  RELEASES_API,
  REQUEST_HEADERS,
  releaseUrl,
} from '../app/updates.js';
import {
  afterCheck,
  CHECK_EVERY_MS,
  checkDue,
  dismissVersion,
  emptyUpdateState,
  readUpdateState,
  versionToAnnounce,
} from '../src/update-check.js';

const PAGE = 'https://github.com/pideoh/twinscript/releases/tag/';

test('a version is three groups of digits and nothing else', () => {
  assert.deepEqual(parseVersion('0.13.0'), [0, 13, 0]);
  assert.deepEqual(parseVersion('10.0.12'), [10, 0, 12]);
  for (const bad of ['v0.13.0', '0.13', '0.13.0.1', '0.13.0-beta.1', '0.13.0 ', ' 0.13.0', '1.a.0', '', null, 13, {}])
    assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(parseVersion('1234567.0.0'), null, 'too many digits to compare safely');
});

test('versions are compared part by part as numbers', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.9.10', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.13.0', '0.13.1') < 0);
  assert.equal(compareVersions('0.13.0', '0.13.0'), 0);
  assert.throws(() => compareVersions('0.13.0', 'v0.13.0'), TypeError);
});

test('the release page is built from a valid version only', () => {
  assert.equal(releaseUrl('0.14.0'), `${PAGE}v0.14.0`);
  for (const bad of ['v0.14.0', '0.14.0/../../evil', 'https://example.com', '0.14', undefined])
    assert.equal(releaseUrl(bad), null, String(bad));
});

test('a release answer gives its version when the tag is vX.Y.Z and the page is in this repository', () => {
  assert.equal(parseRelease({ tag_name: 'v0.14.0', html_url: `${PAGE}v0.14.0`, body: 'notes' }), '0.14.0');
  assert.equal(parseRelease({ tag_name: 'v0.14.0' }), '0.14.0', 'html_url is not needed');
  for (const tag of ['0.14.0', 'v0.14', 'v0.14.0-rc.1', 'v0.14.0\n', 'release-0.14.0', 'v0.14.0 ', 'V0.14.0', 14, null])
    assert.equal(parseRelease({ tag_name: tag, html_url: `${PAGE}v0.14.0` }), null, String(tag));
  assert.equal(parseRelease({ tag_name: 'v0.14.0', html_url: 'https://evil.example/releases/tag/v0.14.0' }), null);
  assert.equal(parseRelease({ tag_name: 'v0.14.0', html_url: 42 }), null);
});

test('garbage answers give no version', () => {
  for (const answer of [null, undefined, 'v0.14.0', 42, [], [{ tag_name: 'v0.14.0' }], {}, { message: 'Not Found' }])
    assert.equal(parseRelease(answer), null, JSON.stringify(answer));
});

// A stand-in for net.fetch that records what was asked.
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status === undefined || answer.status === 200,
      status: answer.status ?? 200,
      json: async () => {
        if (answer.json instanceof Error) throw answer.json;
        return answer.json;
      },
    };
  };
  return { fetch, calls };
}

test('the check asks GitHub for the latest release with a generic agent, no credentials and a timeout', async () => {
  const { fetch, calls } = fakeFetch({ json: { tag_name: 'v0.14.0', html_url: `${PAGE}v0.14.0` } });
  assert.deepEqual(await checkForUpdate({ fetch, current: '0.13.0' }), {
    current: '0.13.0',
    latest: '0.14.0',
    newer: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/pideoh/twinscript/releases/latest');
  assert.equal(calls[0].url, RELEASES_API);
  assert.deepEqual(calls[0].options.headers, {
    Accept: 'application/vnd.github+json',
    'Accept-Language': 'en',
    'User-Agent': 'Twinscript',
  });
  assert.equal(calls[0].options.headers, REQUEST_HEADERS);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(CHECK_TIMEOUT_MS, 10_000);
});

test('the check says not newer for the same or an older release', async () => {
  for (const [tag, current] of [
    ['v0.13.0', '0.13.0'],
    ['v0.9.0', '0.10.0'],
  ]) {
    const { fetch } = fakeFetch({ json: { tag_name: tag } });
    assert.deepEqual(await checkForUpdate({ fetch, current }), { current, latest: tag.slice(1), newer: false });
  }
});

test('a failed check answers null and only warns', async () => {
  const cases = [
    new TypeError('net::ERR_INTERNET_DISCONNECTED'),
    { status: 403, json: { message: 'API rate limit exceeded' } },
    { status: 404, json: { message: 'Not Found' } },
    { json: new SyntaxError('Unexpected token') },
    { json: { tag_name: 'nightly' } },
    { json: [] },
  ];
  for (const answer of cases) {
    const warnings = [];
    const { fetch } = fakeFetch(answer);
    assert.equal(await checkForUpdate({ fetch, current: '0.13.0', warn: (m) => warnings.push(m) }), null);
    assert.equal(warnings.length, 1);
  }
  const { fetch, calls } = fakeFetch({ json: { tag_name: 'v0.14.0' } });
  assert.equal(await checkForUpdate({ fetch, current: 'dev' }), null, 'a running version that is not X.Y.Z');
  assert.equal(calls.length, 0, 'and then nothing is asked');
});

test('a check that takes too long is given up', async () => {
  const fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.equal(await checkForUpdate({ fetch, current: '0.13.0', timeoutMs: 20 }), null);
});

// ---------- the page side: when to ask and what to announce ----------

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
