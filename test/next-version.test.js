import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpFor, nextVersion } from '../scripts/next-version.js';

test('fixes and other changes are a patch', () => {
  assert.equal(bumpFor(['Fix sentences shown twice', 'Default the interval to 1.5 seconds', 'docs: update README']), 'patch');
  assert.equal(bumpFor([]), 'patch');
});

test('a commit that adds something is a minor', () => {
  assert.equal(bumpFor(['Fix a typo', 'Add an always-on-top caption window\n\nDetails']), 'minor');
  assert.equal(bumpFor(['feat: caption window']), 'minor');
  assert.equal(bumpFor(['feat(app): overlay']), 'minor');
  assert.equal(bumpFor(['Address review comments', 'Additional logging']), 'patch', 'only the word Add counts');
});

test('a breaking change is a major, wherever it is mentioned', () => {
  assert.equal(bumpFor(['Add a thing', 'Change storage format\n\nBREAKING CHANGE: saved sessions are reset']), 'major');
  assert.equal(bumpFor(['feat!: drop the old export format']), 'major');
  assert.equal(bumpFor(['refactor(store)!: new schema']), 'major');
});

test('next version', () => {
  assert.equal(nextVersion(null, 'minor'), '0.1.0', 'the first release');
  assert.equal(nextVersion('v0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('v0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('v0.9.3', 'major'), '1.0.0');
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.throws(() => nextVersion('nightly', 'patch'), /Not a release tag/);
});
