import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommits, isConventional } from '../../../scripts/check-commits.js';

test('subjects with a known type, optional scope and optional "!" are accepted', () => {
  for (const subject of [
    'feat: read translations aloud',
    'fix(captions): keep the window on top',
    'perf: reuse the audio context',
    'revert: feat: read translations aloud',
    'docs: link the pricing page',
    'test: cover the caption window',
    'build: bump electron',
    'ci: publish releases from a release pull request (release-please)',
    'chore(deps): bump the actions group with 2 updates',
    'chore(deps-dev): bump @biomejs/biome from 2.6.8 to 2.6.9',
    'chore(main): release 0.7.1',
    'refactor!: store sessions per language',
    'style(app): format',
    'feat(store)!: drop the old session format',
  ]) {
    assert.ok(isConventional(subject), subject);
  }
});

test('subjects without a known type or in the wrong shape are rejected', () => {
  for (const subject of [
    'Add reading translations aloud',
    'Fix sentences shown twice',
    'Revert "feat: read translations aloud"',
    'feature: something',
    'Feat: capitalised type',
    'feat:missing space',
    'feat: ',
    'feat (app): space before the scope',
    'feat(): empty scope',
    'fix(a)(b): two scopes',
    'feat!!: two marks',
    '',
  ]) {
    assert.equal(isConventional(subject), false, subject);
  }
});

test('merge commits are skipped and each bad subject is reported once', () => {
  const problems = checkCommits([
    { sha: 'aaaaaaa1111', subject: 'feat: a', parents: ['p1'] },
    { sha: 'bbbbbbb2222', subject: "Merge branch 'main' into feat/a", parents: ['p1', 'p2'] },
    { sha: 'ccccccc3333', subject: 'Add b', parents: ['p1'] },
  ]);
  assert.deepEqual(problems, ['ccccccc: "Add b"']);
});

test('the pull request title, which becomes the squash-merge subject, is checked too', () => {
  assert.deepEqual(checkCommits([], 'fix: a'), []);
  assert.deepEqual(checkCommits([], 'Fix a'), ['pull request title: "Fix a"']);
});
