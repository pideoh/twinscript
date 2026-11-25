// Whether a newer version of the app has been released: the request to GitHub, how its answer is
// checked, and the release page the app opens. Electron-free; main.js passes in net.fetch.
// Only the version number comes back from the answer. The page and the browser get a release URL
// that is built here from that number, never one taken from the answer.

const REPO = 'pideoh/twinscript';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGES = `https://github.com/${REPO}/releases/`;
export const CHECK_TIMEOUT_MS = 10_000;

// A generic agent: no version, no operating system. Nothing about the user or sessions is sent;
// a fixed Accept-Language replaces the system's languages, which Electron would add otherwise.
export const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/vnd.github+json',
  'Accept-Language': 'en',
  'User-Agent': 'Twinscript',
});

// Digits only, and few enough of them to compare as numbers.
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const TAG = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/;

// "1.2.3" -> [1, 2, 3]; anything else (a pre-release, a prefix, a fourth part) -> null.
export function parseVersion(text) {
  const m = typeof text === 'string' ? VERSION.exec(text) : null;
  return m ? m.slice(1).map(Number) : null;
}

const format = (parts) => parts.join('.');

// < 0, 0 or > 0, part by part as numbers (0.10.0 is newer than 0.9.0). Both must be valid.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new TypeError('not a version');
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The release page of a valid version, or null.
export function releaseUrl(version) {
  const parts = parseVersion(version);
  return parts ? `${RELEASE_PAGES}tag/v${format(parts)}` : null;
}

// The version of GitHub's latest-release answer ({ tag_name: 'v1.2.3', html_url }), or null when
// it is not one: a tag that is not vX.Y.Z, or a page outside this repository's releases.
export function parseRelease(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const m = typeof answer.tag_name === 'string' ? TAG.exec(answer.tag_name) : null;
  if (!m) return null;
  const { html_url: page } = answer;
  if (page !== undefined && (typeof page !== 'string' || !page.startsWith(RELEASE_PAGES))) return null;
  return format(parseVersion(m[1]));
}

// Asks GitHub for the latest release. fetch is net.fetch (or a stand-in); current is the running
// version. Returns { current, latest, newer }, or null on any failure (offline, timeout, rate
// limit, an unexpected answer), which is reported through warn only.
export async function checkForUpdate({ fetch, current, timeoutMs = CHECK_TIMEOUT_MS, warn = () => {} }) {
  const running = parseVersion(current);
  if (!running) {
    warn(`update check: the running version "${current}" is not X.Y.Z`);
    return null;
  }
  try {
    const res = await fetch(RELEASES_API, {
      headers: REQUEST_HEADERS,
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      warn(`update check: GitHub answered ${res.status}`);
      return null;
    }
    const latest = parseRelease(await res.json());
    if (!latest) {
      warn('update check: unexpected answer');
      return null;
    }
    const version = format(running);
    return { current: version, latest, newer: compareVersions(latest, version) > 0 };
  } catch (err) {
    warn(`update check failed: ${err?.message ?? err}`);
    return null;
  }
}
