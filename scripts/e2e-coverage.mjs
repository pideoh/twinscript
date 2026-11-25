// Line coverage of the app's scripts as run by the browser tests. The unit tests' coverage (Node's
// --experimental-test-coverage) sees only what the unit tests load; src/app.js and the parts of the
// screen run only in Chrome. With E2E_COVERAGE=<directory>, test/e2e/helpers/app.js writes Chrome's raw
// JavaScript coverage of each page there (one JSON file per page); this script reads them:
//
//   node scripts/e2e-coverage.mjs <directory> [--min <percent>] [--json <file>]
//   node scripts/e2e-coverage.mjs --run [<directory>] [--min …] [--json …] [-- <node --test options>]
//
// --run empties the directory (default dist/e2e-coverage), runs the browser tests with collection on and
// then prints the report; it exits with the tests' code when they fail. --min exits 1 when the total is
// below the percentage; --json writes the per-file figures.
//
// Every .js file under src/ is listed, so a file no page loaded shows as 0% rather than being left out.
// The audio worklet (src/speech/pcm-worklet.js and auto-gain.js, which only it imports) runs in a worklet
// scope that page coverage does not see, so both show 0%; the unit tests cover auto-gain.js.
//
// The line rule, deliberately simple: V8 reports nested byte ranges with an execution count; the count of
// a character is the count of the innermost range around it. A line has code unless, trimmed, it is
// empty, a // comment, inside or the start of a /* */ comment, or only closing brackets and separators
// (`}`, `});`, `],`). A line with code is covered when every non-blank character on it ran in at least
// one page; otherwise it is uncovered. So a line that is only partly run (`} else {` where the else
// branch never ran, `a ? b : c` with one side never taken) counts as uncovered, and a comment after code
// on a line counts as code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_DIR = 'dist/e2e-coverage';
const MAX_RANGES = 10;

// What ran at each character of a script of `length` characters, from one V8 coverage entry's
// `functions`: -1 no range covers it, 0 the innermost range has count 0, 1 it ran. V8's ranges nest, so
// painting them outer first (by start, then longest first) leaves each character with its innermost one.
export function offsetStates(functions, length) {
  const states = new Int8Array(length).fill(-1);
  const ranges = functions.flatMap((f) => f.ranges ?? []);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const { startOffset, endOffset, count } of ranges) {
    states.fill(count > 0 ? 1 : 0, Math.max(0, startOffset), Math.min(length, endOffset));
  }
  return states;
}

// The same script loaded by several pages (or twice by one page): a character ran if it ran anywhere.
export function mergeStates(into, states) {
  for (let i = 0; i < into.length; i++) if (states[i] > into[i]) into[i] = states[i];
  return into;
}

const NO_CODE = /^[)\]};,]*$/;

// One entry per line of `source`: null for a line without code, true when every non-blank character on
// it ran (state 1), false otherwise. A source no page loaded has states all -1: every code line false.
export function lineCoverage(source, states) {
  const lines = [];
  let inComment = false;
  let start = 0;
  for (const text of source.split('\n')) {
    const end = start + text.length;
    const trimmed = text.trim();
    if (inComment) {
      if (trimmed.includes('*/')) inComment = false;
      lines.push(null);
    } else if (trimmed.startsWith('/*')) {
      inComment = !trimmed.includes('*/', 2);
      lines.push(null);
    } else if (trimmed.startsWith('//') || NO_CODE.test(trimmed)) {
      lines.push(null);
    } else {
      let ran = true;
      for (let i = start; i < end && ran; i++) {
        if (!/\s/.test(source[i]) && states[i] !== 1) ran = false;
      }
      lines.push(ran);
    }
    start = end + 1;
  }
  return lines;
}

// Uncovered lines as [first, last] pairs of line numbers (from 1). Lines without code between two
// uncovered lines do not break a range, so a blank line inside an unrun function keeps it one range.
export function uncoveredRanges(lines) {
  const ranges = [];
  let open = null;
  lines.forEach((covered, i) => {
    if (covered === false) {
      if (open) open[1] = i + 1;
      else {
        open = [i + 1, i + 1];
        ranges.push(open);
      }
    } else if (covered === true) open = null;
  });
  return ranges;
}

// "12-14 20 31-40", at most `max` ranges, then how many more there are.
export function formatRanges(ranges, max = MAX_RANGES) {
  const shown = ranges.slice(0, max).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  if (ranges.length > max) shown.push(`… +${ranges.length - max} more`);
  return shown.join(' ');
}

const percent = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);

// Figures of one file from its line coverage.
export function fileFigures(file, lines) {
  const code = lines.filter((l) => l !== null);
  const covered = code.filter(Boolean).length;
  return {
    file,
    lines: code.length,
    covered,
    percent: percent(covered, code.length),
    uncovered: uncoveredRanges(lines),
  };
}

// The total over files: lines of all files together, not the mean of the files' percentages.
export function total(files) {
  const lines = files.reduce((n, f) => n + f.lines, 0);
  const covered = files.reduce((n, f) => n + f.covered, 0);
  return { lines, covered, percent: percent(covered, lines) };
}

// "src/app.js" for a script URL served from the repository's root, or null for anything else (a script a
// test injected, an inline script, a file outside src/).
export function sourcePath(url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  return path.startsWith('/src/') && path.endsWith('.js') ? path.slice(1) : null;
}

export function formatTable(files, sum) {
  const rows = [...files.map((f) => [f.file, f.percent.toFixed(2), formatRanges(f.uncovered)]), null];
  rows.push(['all files', sum.percent.toFixed(2), '']);
  const width = Math.max(...rows.filter(Boolean).map((r) => r[0].length), 'file'.length);
  const line = (r) => `${r[0].padEnd(width)} | ${r[1].padStart(6)} | ${r[2]}`.trimEnd();
  const rule = '-'.repeat(width + 30);
  return [line(['file', 'line %', 'uncovered lines']), rule, ...rows.map((r) => (r ? line(r) : rule)), rule].join('\n');
}

function sourceFiles() {
  return readdirSync(join(ROOT, 'src'), { recursive: true })
    .map((f) => `src/${String(f).split(sep).join('/')}`)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

// Reads every raw file in `dir` and returns the figures of every file under src/.
export function collect(dir) {
  const states = new Map();
  const sources = new Map();
  const source = (path) => {
    if (!sources.has(path)) sources.set(path, readFileSync(join(ROOT, path), 'utf8'));
    return sources.get(path);
  };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const { result = [] } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    for (const entry of result) {
      const path = sourcePath(entry.url);
      if (!path) continue;
      let text;
      try {
        text = source(path);
      } catch {
        continue; // a file that is gone since the run
      }
      const page = offsetStates(entry.functions, text.length);
      states.set(path, states.has(path) ? mergeStates(states.get(path), page) : page);
    }
  }
  return sourceFiles().map((path) => {
    const text = source(path);
    return fileFigures(path, lineCoverage(text, states.get(path) ?? new Int8Array(text.length).fill(-1)));
  });
}

function parse(argv) {
  const options = { run: false, dir: null, min: null, json: null, testArgs: [] };
  const dash = argv.indexOf('--');
  if (dash >= 0) {
    options.testArgs = argv.slice(dash + 1);
    argv = argv.slice(0, dash);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') options.run = true;
    else if (a === '--min') options.min = Number(argv[++i]);
    else if (a === '--json') options.json = argv[++i];
    else if (!a.startsWith('--') && options.dir === null) options.dir = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (options.min !== null && !Number.isFinite(options.min)) throw new Error('--min takes a percentage');
  if (!options.dir) {
    if (!options.run)
      throw new Error('usage: node scripts/e2e-coverage.mjs <directory> [--min <percent>] [--json <file>]');
    options.dir = DEFAULT_DIR;
  }
  return options;
}

export function main(argv, log = console) {
  const options = parse(argv);
  const dir = resolve(options.dir);
  let testStatus = 0;
  if (options.run) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tests = spawnSync(process.execPath, ['--test', ...options.testArgs, 'test/e2e/*.e2e.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, E2E_COVERAGE: dir },
    });
    testStatus = tests.status ?? 1;
  }
  const files = collect(dir);
  const sum = total(files);
  log.log(`Browser test coverage (${relative(ROOT, dir) || dir}):`);
  log.log(formatTable(files, sum));
  if (options.json) writeFileSync(resolve(options.json), `${JSON.stringify({ total: sum, files }, null, 2)}\n`);
  if (testStatus) return testStatus;
  if (options.min !== null && sum.percent < options.min) {
    log.error(`Line coverage ${sum.percent.toFixed(2)}% is below the minimum of ${options.min}%.`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
