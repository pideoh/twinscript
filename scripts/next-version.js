// Decides the next release version from the commits since the last release tag.
//
//   major: a commit marked as breaking ("BREAKING CHANGE" anywhere, or "type!:" in the subject)
//   minor: a commit that adds something (subject starts with "Add" or "feat")
//   patch: anything else
//
// Usage: node scripts/next-version.js [auto|patch|minor|major]   (prints e.g. 1.4.0)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LEVELS = ['patch', 'minor', 'major'];

export function bumpFor(messages) {
  let level = 0;
  for (const message of messages) {
    const subject = message.split('\n')[0];
    if (/BREAKING CHANGE/.test(message) || /^\w+(\([^)]*\))?!:/.test(subject)) return 'major';
    if (/^(add\b|feat(\([^)]*\))?:)/i.test(subject)) level = 1;
  }
  return LEVELS[level];
}

// last: 'v1.2.3', '1.2.3' or null when nothing has been released yet.
export function nextVersion(last, bump, first = '0.1.0') {
  if (!last) return first;
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(last);
  if (!parts) throw new Error(`Not a release tag: ${last}`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const tags = git('tag', '--list', 'v[0-9]*', '--sort=-v:refname').split('\n').filter(Boolean);
  const last = tags[0] ?? null;
  let bump = process.argv[2] || 'auto';
  if (bump === 'auto') {
    const range = last ? [`${last}..HEAD`] : [];
    const log = git('log', '--no-merges', '--format=%B%x00', ...range);
    bump = bumpFor(log.split('\0').map((m) => m.trim()).filter(Boolean));
  }
  if (!LEVELS.includes(bump)) throw new Error(`Unknown bump: ${bump}`);
  console.log(nextVersion(last, bump));
}
