// The structure rules of .claude/rules/structure.md, enforced (principle 7 in docs/principles.md:
// a rule that matters is a check). Every message names the file to look at and what to do.
//
// The import scanner is a regular expression, not a parser. It reads static `import ... from`
// (multi-line lists included), `import 'x'`, `export ... from` and `import('x')` with a string
// literal, after removing comments. It does not understand regular expression literals that contain
// quotes or `//`, nor template literals with nested `${}` strings, and it cannot see an import whose
// path is built at run time. A path inside an ordinary string is ignored unless the string itself
// is written like an import statement outside any quotes.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const posix = (p) => p.split(sep).join('/');
const rel = (abs) => posix(relative(ROOT, abs));
const read = (abs) => readFile(abs, 'utf8');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const listing = async (folder, filter) => (await walk(join(ROOT, folder))).filter((f) => filter.test(f)).sort();
const SCRIPT_FILES = /\.(js|mjs|sh)$/;
const sourceFiles = async () =>
  (await Promise.all(['src', 'app', 'scripts'].map((d) => listing(d, SCRIPT_FILES)))).flat();

// Source without comments. Strings are copied whole so that `//` in a URL is not taken for a comment.
function stripComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && !(c !== '`' && code[j] === '\n')) j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Blank out string contents too, to look for identifiers in code only.
const codeOnly = (code) => stripComments(code).replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');

// Import specifiers of a module, as written.
function importsOf(code) {
  const text = stripComments(code);
  const patterns = [
    /(?:^|[\s;}])import\s+(?:[\w$*{][^'";]*?\s+from\s*)?(['"])([^'"\n]+)\1/g,
    /(?:^|[\s;}])export\s+(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[2]));
}

// Relative imports of a file as repository paths with forward slashes.
const localImports = (abs, code) =>
  importsOf(code)
    .filter((s) => s.startsWith('.'))
    .map((s) => rel(resolve(dirname(abs), s)));

const LOGIC = ['speech', 'translation', 'session', 'storage', 'usage'];
const logicFiles = async () => (await Promise.all(LOGIC.map((g) => listing(`src/${g}`, /\.js$/)))).flat();

test('the import scanner reads the forms it claims to read', () => {
  const code = `
    // import x from './nope.js';
    /* import y from './nope2.js'; */
    import a from './a.js';
    import {
      b,
      c,
    } from "./b.js";
    import './side.js';
    import * as ns from './ns.js';
    export { d } from './d.js';
    export * from './e.js';
    const s = "import z from './str.js'";
    const url = 'https://example.com/x'; // import w from './trailing.js'
    const m = await import('./dyn.js');
    import fs from 'node:fs';
  `;
  assert.deepEqual(importsOf(code).sort(), [
    './a.js',
    './b.js',
    './d.js',
    './dyn.js',
    './e.js',
    './ns.js',
    './side.js',
    'node:fs',
  ]);
});

// 1
test('no module imports src/app.js', async () => {
  const offenders = [];
  for (const f of await sourceFiles()) {
    if (rel(f) === 'src/app.js') continue;
    if (localImports(f, await read(f)).includes('src/app.js')) offenders.push(rel(f));
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')} import src/app.js. app.js wires the parts together and nothing may depend on it (that makes cycles): pass what is needed in as an argument or a callback instead.`,
  );
});

// 2
// A "part" of the screen is a ui/ module that exports a create... factory taking the page (`els`).
// Everything else in ui/ (message-error, langs, icons, i18n, update-check) is derived as pure and
// may be imported by a part. No list to keep.
const isPart = (code) => /export\s+(?:async\s+)?function\s+create\w*\s*\(\s*\{[^)]*\bels\b/.test(stripComments(code));

test('a part of the screen does not import another part of the screen', async () => {
  const files = await listing('src/ui', /\.js$/);
  const parts = new Set();
  for (const f of files) if (isPart(await read(f))) parts.add(rel(f));
  assert.ok(parts.size >= 5, 'found too few parts: did the factory signature change? Update isPart in this test.');
  const offenders = [];
  for (const f of files) {
    if (!parts.has(rel(f))) continue;
    for (const dep of localImports(f, await read(f))) {
      if (parts.has(dep) && dep !== rel(f)) offenders.push(`${rel(f)} imports ${dep}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join('; ')}. A part must not import another part: connect them in src/app.js with a callback, or move what they share into a pure module.`,
  );
});

// 3
// Files in the logic folders that must touch the browser, each with the reason. A new file is not
// allowed in by default: put the page access in src/ui/ or inject it.
const BROWSER_EXCEPTIONS = {
  'src/speech/audio.js': 'picks the AudioContext constructor from window (with the webkit prefix) when capturing audio',
};
const BROWSER_USE = /\b(?:document|window|localStorage|sessionStorage)\b/;

test('logic folders stay off the page', async () => {
  const offenders = [];
  const used = new Set();
  for (const f of await logicFiles()) {
    if (!BROWSER_USE.test(codeOnly(await read(f)))) continue;
    if (rel(f) in BROWSER_EXCEPTIONS) used.add(rel(f));
    else offenders.push(rel(f));
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(', ')} uses document, window or localStorage directly. Logic modules take what they need as an argument so they run under node:test: move the page access to src/ui/ or src/app.js and pass it in, or, only if the file truly must touch the browser, add it to BROWSER_EXCEPTIONS with the reason.`,
  );
  const stale = Object.keys(BROWSER_EXCEPTIONS).filter((f) => !used.has(f));
  assert.deepEqual(stale, [], `${stale.join(', ')} no longer touches the page: remove it from BROWSER_EXCEPTIONS.`);
});

// 4
// Modules in the logic folders that have no unit test today (they use browser APIs through
// injection or need a real browser). The list can only shrink: when a test is added the check below
// fails until the name is removed. Never add a name: write the test.
const UNTESTED_LOGIC = new Set([]);

// Tests whose name is not their subject's name, with the subject(s). A test file belongs here only
// when it covers a module under another name or several modules together.
const TEST_SUBJECTS = {
  'app/desktop-policy': ['app/policy.js'],
  'scripts/mac-signing': ['scripts/sign-mac.js', 'scripts/verify-mac-signature.js'],
};

const exists = (p) =>
  readFile(p).then(
    () => true,
    () => false,
  );

test('every unit test sits next to its subject, and every logic module has a test', async () => {
  const tests = await listing('test/unit', /\.test\.js$/);
  const scripts = (await listing('scripts', SCRIPT_FILES)).map((f) => rel(f).slice('scripts/'.length));
  const problems = [];
  for (const t of tests) {
    const r = rel(t).slice('test/unit/'.length);
    const name = r.replace(/\.test\.js$/, '');
    if (r.startsWith('rules/')) continue; // checks of a rule, not of a module
    if (name in TEST_SUBJECTS) {
      for (const subject of TEST_SUBJECTS[name]) {
        if (!(await exists(join(ROOT, subject)))) problems.push(`${rel(t)}: there is no ${subject}`);
      }
      continue;
    }
    if (r.startsWith('src/')) {
      if (!(await exists(join(ROOT, `${name}.js`)))) problems.push(`${rel(t)}: there is no ${name}.js`);
    } else if (r.startsWith('app/')) {
      if (!(await exists(join(ROOT, `${name}.js`)))) problems.push(`${rel(t)}: there is no ${name}.js`);
    } else if (r.startsWith('scripts/')) {
      // A script in a folder is named with the folder joined by "-": scripts/tuning/replay.mjs is
      // tested in test/unit/scripts/tuning-replay.test.js. Other scripts keep their file name.
      const base = name.slice('scripts/'.length);
      const ok = scripts.some((s) => s.replace(/\.\w+$/, '').replace(/\//g, '-') === base);
      if (!ok) problems.push(`${rel(t)}: no script under scripts/ is called ${base}`);
    } else problems.push(`${rel(t)}: a unit test belongs under test/unit/src, app, scripts or rules`);
  }
  assert.deepEqual(
    problems,
    [],
    `${problems.join('; ')}. A unit test mirrors its subject's path (test/unit/src/<group>/<name>.test.js for src/<group>/<name>.js): move or rename the test or the module.`,
  );

  const missing = [];
  const stale = [];
  const haveTest = new Set(tests.map(rel));
  const logic = new Set();
  for (const f of await logicFiles()) {
    const r = rel(f);
    if (r in BROWSER_EXCEPTIONS) continue;
    logic.add(r);
    const has = haveTest.has(`test/unit/${r.replace(/\.js$/, '.test.js')}`);
    if (!has && !UNTESTED_LOGIC.has(r)) missing.push(r);
    if (has && UNTESTED_LOGIC.has(r)) stale.push(r);
  }
  for (const r of UNTESTED_LOGIC) if (!logic.has(r)) stale.push(r);
  assert.deepEqual(
    missing,
    [],
    `${missing.join(', ')} has no unit test. Every DOM-free module in speech/, translation/, session/, storage/ and usage/ has one at test/unit/<same path>.test.js: add it.`,
  );
  assert.deepEqual(stale, [], `${stale.join(', ')}: remove from UNTESTED_LOGIC (it has a test now, or is gone).`);
});

// 5
test('every source file starts with a comment that says what it is for', async () => {
  const bad = [];
  for (const f of await sourceFiles()) {
    const lines = (await read(f)).split(/\r?\n/);
    let i = 0;
    if (lines[0]?.startsWith('#!')) i = 1; // a shebang line comes first
    const first = lines[i]?.trim() ?? '';
    const ok = /^(\/\/|\/\*|#)\s*\S/.test(first) && (i === 0 ? first.startsWith('//') || first.startsWith('/*') : true);
    if (!ok) bad.push(rel(f));
  }
  assert.deepEqual(
    bad,
    [],
    `${bad.join(', ')} does not start with a comment. Add a first comment saying what the module is for and what is not obvious about it (.claude/rules/structure.md).`,
  );
});

// 6
test('the folders under src/ are exactly the ones the desktop app serves', async () => {
  const onDisk = (await readdir(join(ROOT, 'src'), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  // Read the served-files pattern from the module's own source: the list is not exported.
  const policy = await read(join(ROOT, 'app/policy.js'));
  const alternation = /\/\^src\\\/\(([\w|-]+)\)\\\//.exec(policy)?.[1];
  assert.ok(
    alternation,
    'app/policy.js: no pattern like /^src\\/(a|b)\\/…/ found. Update this check if the pattern changed shape.',
  );
  const served = alternation.split('|').sort();
  assert.deepEqual(
    onDisk,
    served,
    `src/ has the folders [${onDisk.join(', ')}] but app/policy.js serves [${served.join(', ')}]. A new folder must be added to ALLOWED in app/policy.js (with the traversal cases in test/unit/app/desktop-policy.test.js) and to the map of CLAUDE.md; a removed one must be taken out.`,
  );
});

// 7
// Lower this when app.js shrinks; never raise it.
const APP_MAX_LINES = 746;

test('src/app.js does not grow', async () => {
  const text = await read(join(ROOT, 'src/app.js'));
  const lines = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
  assert.ok(
    lines <= APP_MAX_LINES,
    `src/app.js has ${lines} lines (limit ${APP_MAX_LINES}). New logic goes into a module (see .claude/rules/structure.md), not into app.js. The limit is lowered when the file shrinks, never raised.`,
  );
});
