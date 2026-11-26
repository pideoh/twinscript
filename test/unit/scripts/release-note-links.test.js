import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numbersLinkedAsIssues, withPullLinks } from '../../../scripts/release-note-links.mjs';

const REPO = 'pideoh/twinscript';
const NOTES = [
  '### Bug Fixes',
  '',
  "* capture every app's sound ([#153](https://github.com/pideoh/twinscript/issues/153)) ([24ed398](https://github.com/pideoh/twinscript/commit/24ed398)), closes [#152](https://github.com/pideoh/twinscript/issues/152)",
  '* another fix ([#1530](https://github.com/pideoh/twinscript/issues/1530))',
  '* see [#153](https://github.com/someone/else/issues/153)',
].join('\n');

test('a link to a pull request leads to the pull request, and a link to an issue stays', () => {
  const notes = withPullLinks(NOTES, REPO, new Set([153]));
  assert.ok(notes.includes('([#153](https://github.com/pideoh/twinscript/pull/153))'));
  assert.ok(
    notes.includes('closes [#152](https://github.com/pideoh/twinscript/issues/152)'),
    'the issue is still an issue',
  );
  assert.ok(notes.includes('twinscript/issues/1530)'), 'a longer number that starts the same is not touched');
  assert.ok(notes.includes('https://github.com/someone/else/issues/153'), 'nor is another repository');
  assert.ok(notes.includes('commit/24ed398'), 'nor a commit');
});

test('the numbers to look up are those linked as issues of this repository, each once', () => {
  assert.deepEqual(numbersLinkedAsIssues(NOTES, REPO), [153, 152, 1530]);
  assert.deepEqual(numbersLinkedAsIssues('', REPO), []);
  assert.deepEqual(numbersLinkedAsIssues(null, REPO), []);
});

test('notes without such links come back unchanged', () => {
  const plain = '### Features\n\n* something new';
  assert.equal(withPullLinks(plain, REPO, new Set([1])), plain);
  assert.equal(withPullLinks(NOTES, REPO, new Set()), NOTES);
});
