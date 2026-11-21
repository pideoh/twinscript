// Decides whether the changes since the last release change what users download.
// Updates to checking and testing tools, workflows, tests and docs do not, so they are merged
// without publishing a new version.
//
// Usage: node scripts/release-needed.js   (prints "true" or "false")
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHIPPED = [
  /^app\//,
  /^src\//,
  /^icons\//,
  /^index\.html$/,
  /^styles\.css$/,
  /^LICENSE$/,
  /^THIRD-PARTY-NOTICES\.md$/,
];

// The parts of package.json that end up in the app or decide how it is built.
function shippedView(pkg) {
  const dev = pkg.devDependencies ?? {};
  return {
    name: pkg.name,
    productName: pkg.productName,
    description: pkg.description,
    author: pkg.author,
    license: pkg.license,
    main: pkg.main,
    type: pkg.type,
    dependencies: pkg.dependencies ?? {},
    overrides: pkg.overrides ?? {},
    build: pkg.build ?? {},
    electron: dev.electron,
    electronBuilder: dev['electron-builder'],
  };
}

export function releaseNeeded({ changedFiles, oldPackage, newPackage }) {
  if (changedFiles.some((file) => SHIPPED.some((pattern) => pattern.test(file)))) return true;
  if (!changedFiles.includes('package.json')) return false;
  return JSON.stringify(shippedView(oldPackage)) !== JSON.stringify(shippedView(newPackage));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const last = git('tag', '--list', 'v[0-9]*', '--sort=-v:refname').split('\n').filter(Boolean)[0];
  if (!last) {
    console.log('true'); // nothing released yet
  } else {
    const changedFiles = git('diff', '--name-only', `${last}..HEAD`).split('\n').filter(Boolean);
    const oldPackage = JSON.parse(git('show', `${last}:package.json`));
    const newPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(String(releaseNeeded({ changedFiles, oldPackage, newPackage })));
  }
}
