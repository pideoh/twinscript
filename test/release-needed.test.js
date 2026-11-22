import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseNeeded } from '../scripts/release-needed.js';

const pkg = (over = {}) => ({
  name: 'twinscript',
  scripts: { test: 'node --test' },
  devDependencies: {
    electron: '45.4.1',
    'electron-builder': '26.18.0',
    '@biomejs/biome': '2.6.8',
    'playwright-core': '1.50.0',
  },
  build: { appId: 'x' },
  ...over,
});
const needed = (changedFiles, oldPackage = pkg(), newPackage = pkg()) =>
  releaseNeeded({ changedFiles, oldPackage, newPackage });

test('changes to the app are released', () => {
  for (const file of [
    'src/app.js',
    'src/locales/ja.js',
    'app/main.js',
    'index.html',
    'styles.css',
    'icons/icon.svg',
    'LICENSE',
  ]) {
    assert.equal(needed([file]), true, file);
  }
});

test('docs, tests, workflows and tooling are not', () => {
  assert.equal(
    needed([
      'README.md',
      'CLAUDE.md',
      'test/e2e/shell.e2e.js',
      '.github/workflows/release.yml',
      'scripts/screenshots.mjs',
      'biome.json',
      'docs/demo.png',
    ]),
    false,
  );
});

test('an update of a checking or testing tool is not released', () => {
  const next = pkg();
  next.devDependencies['@biomejs/biome'] = '2.7.0';
  next.devDependencies['playwright-core'] = '1.51.0';
  next.devDependencies['axe-core'] = '4.11.0';
  next.scripts.lint = 'biome check .';
  assert.equal(needed(['package.json', 'package-lock.json'], pkg(), next), false);
});

test('an update of Electron or of the packaging tool is released', () => {
  const electron = pkg();
  electron.devDependencies.electron = '45.5.0';
  assert.equal(needed(['package.json', 'package-lock.json'], pkg(), electron), true);
  const builder = pkg();
  builder.devDependencies['electron-builder'] = '26.19.0';
  assert.equal(needed(['package.json'], pkg(), builder), true);
});

test('a change to the build configuration, overrides or app metadata is released', () => {
  assert.equal(needed(['package.json'], pkg(), pkg({ build: { appId: 'y' } })), true);
  assert.equal(needed(['package.json'], pkg(), pkg({ overrides: { minimatch: '^11' } })), true);
  assert.equal(needed(['package.json'], pkg(), pkg({ productName: 'Other' })), true);
});

test('a lock file change alone is not released', () => {
  assert.equal(needed(['package-lock.json']), false);
});
