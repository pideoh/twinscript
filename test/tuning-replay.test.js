import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createVirtualClock } from '../scripts/tuning/clock.mjs';
import { LANGS, parseArgs, replay } from '../scripts/tuning/replay.mjs';

const root = new URL('..', import.meta.url).pathname;
const run = (...args) =>
  promisify(execFile)(process.execPath, ['scripts/tuning/replay.mjs', ...args], {
    cwd: root,
    env: { ...process.env, GEMINI_API_KEY: '' },
  });

const EXPECTED = [
  'strategy       sentences  first ms mean/med/p90  final ms mean/med/p90  flicker mean/med/p90  erased  updates  requests  rateLimited',
  'interval 1.5s  6          833/550/1600           400/400/400            0.00/0.00/0.00        0       13       16        0',
];

test('the replay of the sample trace with the fake translator scores the same on every run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  try {
    const out = join(dir, 'result.json');
    const { stdout } = await run('test/fixtures/replay-trace.json', '--mock', '--speed', '20', '--out', out);
    // --speed shortens the speech 20 times; the fake translator still takes 400 ms.
    assert.equal(stdout.split('\n')[0], EXPECTED[0]);
    assert.equal(
      stdout.split('\n')[1],
      'interval 1.5s  6          495/499/598            400/400/400            0.00/0.00/0.00        0       6        7         0',
      'the speech goes by too fast for most in-progress translations to be shown',
    );

    const { stdout: normal } = await run('test/fixtures/replay-trace.json', '--mock');
    assert.deepEqual(normal.trimEnd().split('\n'), EXPECTED);

    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.runs.length, 1);
    const sentences = result.runs[0].sentences;
    assert.deepEqual(
      sentences.map((s) => s.src),
      [
        'おはようございます。',
        '今日は新しい検索画面の進め方について話したいと思います。',
        'Thanks. I looked at the draft yesterday and I think the filters need more space.',
        'そうですね、フィルターは右側にまとめて、結果の一覧を広くしたいです。',
        '来週までに試作を用意します。',
        'Great, let’s review it on Friday.',
      ],
    );
    assert.equal(sentences[1].finalText, '[English] 今日は新しい検索画面の進め方について話したいと思います。');
    assert.equal(sentences[2].finalText.startsWith('[Japanese] Thanks.'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('several strategies run one after another, one row each', async () => {
  const { stdout } = await run('test/fixtures/replay-trace.json', '--mock', '--strategy', 'interval,interval');
  assert.equal(stdout.trimEnd().split('\n').length, 3);
});

test('without --mock the key must come from the environment', async () => {
  await assert.rejects(run('test/fixtures/replay-trace.json'), (err) => /GEMINI_API_KEY/.test(err.stderr));
});

test('options are checked', () => {
  assert.deepEqual(parseArgs(['t.json', '--interval', '2', '--strategy', 'a,b', '--speed', '4', '--mock']), {
    strategies: ['a', 'b'],
    interval: 2,
    speed: 4,
    mock: true,
    out: null,
    trace: 't.json',
    help: false,
    quiet: false,
  });
  assert.throws(() => parseArgs([]), /No trace file given[\s\S]*--strategy/);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['t.json', '--interval', '0']), /interval/);
  assert.throws(() => parseArgs(['t.json', '--nope']), /nope/);
});

test('the replay knows the same languages as the app', () => {
  const app = readFileSync(join(root, 'src/app.js'), 'utf8');
  const block = app.slice(app.indexOf('const LANGS = ['), app.indexOf('];', app.indexOf('const LANGS = [')));
  const inApp = [...block.matchAll(/code: '([^']+)'.*?name: '([^']+)'/g)].map(([, code, name]) => ({ code, name }));
  assert.ok(inApp.length > 2);
  assert.deepEqual(LANGS, inApp);
});

test('progress is printed apart from the table, and --quiet leaves only the table', async () => {
  const loud = await run('test/fixtures/replay-trace.json', '--mock');
  assert.equal(loud.stdout.trim().split('\n').length, 2, 'stdout holds the table only');
  assert.match(loud.stderr, /Trace: 0:21 of speech, 43 recognizer results \(4 final\), Japanese \/ English\./);
  assert.match(loud.stderr, /interval: 0:\d\d \/ 0:21, 6 sentences, 16 requests/);
  assert.match(loud.stderr, /flicker +share of shown translation/);
  const quiet = await run('test/fixtures/replay-trace.json', '--mock', '--quiet');
  assert.equal(quiet.stderr, '');
  assert.equal(quiet.stdout, loud.stdout);
});

test('--help explains the options without needing a trace or a key', async () => {
  const { stdout } = await run('--help');
  assert.match(stdout, /--strategy a,b/);
  assert.match(stdout, /takes as long as the speech/);
});

test('failed translation requests are counted and reported with their error', async () => {
  const trace = JSON.parse(readFileSync(join(root, 'test/fixtures/replay-trace.json'), 'utf8'));
  const clock = createVirtualClock(Date.UTC(2026, 0, 1));
  const translator = {
    translate: () => Promise.reject(new Error('API key not valid')),
    identify: () => Promise.reject(new Error('API key not valid')),
  };
  const seen = [];
  await replay({ trace, clock, translator, onProgress: (p) => seen.push(p) });
  const last = seen.at(-1);
  assert.ok(last.failed > 0);
  assert.equal(last.answered, 0);
  assert.equal(last.lastError, 'API key not valid');
  assert.ok(seen.some((p) => p.sentences > 0));
  assert.ok(
    seen.every((p, i) => i === 0 || p.traceMs >= seen[i - 1].traceMs),
    'the position in the trace never goes back',
  );
});
