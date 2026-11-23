// Checks that commit subjects (and a pull request title) follow Conventional Commits, which
// release-please reads to choose the next version and write the changelog.
//
//   type(scope)!: description      scope and "!" are optional
//
// Merge commits are skipped.
//
// Usage: node scripts/check-commits.js [--title "<pull request title>"] [<git revision range>]
//   e.g. node scripts/check-commits.js --title "fix: ..." origin/main..HEAD
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TYPES = ['feat', 'fix', 'perf', 'revert', 'docs', 'test', 'build', 'ci', 'chore', 'refactor', 'style'];

const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s][^()]*\\))?!?: \\S`);

export function isConventional(subject) {
  return SUBJECT.test(subject);
}

// commits: [{ sha, subject, parents }]. Returns one message per subject that does not conform.
export function checkCommits(commits, title) {
  const problems = [];
  if (title !== undefined && !isConventional(title)) problems.push(`pull request title: "${title}"`);
  for (const { sha, subject, parents = [] } of commits) {
    if (parents.length > 1) continue; // merge commit
    if (!isConventional(subject)) problems.push(`${sha.slice(0, 7)}: "${subject}"`);
  }
  return problems;
}

function parseLog(log) {
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, subject] = line.split('\x1f');
      return { sha, parents: parents.split(' ').filter(Boolean), subject };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let title;
  const titleAt = args.indexOf('--title');
  if (titleAt !== -1) [, title] = args.splice(titleAt, 2);
  const commits = args.length
    ? parseLog(execFileSync('git', ['log', '--format=%H%x1f%P%x1f%s', ...args], { encoding: 'utf8' }))
    : [];
  const problems = checkCommits(commits, title);
  if (problems.length) {
    console.error(
      `Not in Conventional Commits form (type(scope)!: description, types: ${TYPES.join(', ')}):\n` +
        problems.map((p) => `  ${p}`).join('\n') +
        '\nSee CONTRIBUTING.md.',
    );
    process.exit(1);
  }
  console.log(`${commits.length} commit(s)${title === undefined ? '' : ' and the title'} OK`);
}
