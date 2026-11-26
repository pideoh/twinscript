// Makes the links in a published release's notes lead to where they say. release-please writes
// every "#N" as .../issues/N, also when N is a pull request; GitHub redirects such an address when
// it is opened directly, but a click on it inside GitHub ends in "Unable to load page". This
// rewrites those links to .../pull/N in the notes of one release, after it has been created.
//
// Usage: GH_TOKEN=... node scripts/release-note-links.mjs <tag> [owner/repo]
// Run by .github/workflows/release.yml; a failure here must not fail the release.
import { pathToFileURL } from 'node:url';

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const issueLink = (repo) => new RegExp(`(https://github\\.com/${escaped(repo)}/)issues/(\\d+)\\b`, 'g');

/** The numbers that the notes link to as issues of `repo` ("owner/name"), each once, in order. */
export function numbersLinkedAsIssues(notes, repo) {
  return [...new Set([...String(notes ?? '').matchAll(issueLink(repo))].map((m) => Number(m[2])))];
}

/** The notes with the links to the numbers in `pulls` (a Set) pointing at the pull request. */
export function withPullLinks(notes, repo, pulls) {
  return String(notes ?? '').replace(issueLink(repo), (link, base, n) =>
    pulls.has(Number(n)) ? `${base}pull/${n}` : link,
  );
}

async function main([tag, repo = process.env.GITHUB_REPOSITORY]) {
  const token = process.env.GH_TOKEN;
  if (!tag || !repo || !token) {
    console.error('Usage: GH_TOKEN=... node scripts/release-note-links.mjs <tag> [owner/repo]');
    process.exit(2);
  }
  const api = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  const found = await api(`/releases/tags/${encodeURIComponent(tag)}`);
  if (!found.ok) throw new Error(`The release ${tag} could not be read: HTTP ${found.status}`);
  const release = await found.json();
  const pulls = new Set();
  for (const n of numbersLinkedAsIssues(release.body, repo)) {
    // 200: a pull request. 404: an issue. Anything else: leave the link as it is.
    if ((await api(`/pulls/${n}`)).status === 200) pulls.add(n);
  }
  const notes = withPullLinks(release.body, repo, pulls);
  if (notes === release.body) return console.log('No link to change.');
  const saved = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ body: notes }) });
  if (!saved.ok) throw new Error(`The notes of ${tag} could not be saved: HTTP ${saved.status}`);
  console.log(`Links to ${pulls.size} pull request(s) now lead to the pull request.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
