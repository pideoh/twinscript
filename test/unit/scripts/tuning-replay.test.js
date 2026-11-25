import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createVirtualClock } from '../../../scripts/tuning/clock.mjs';
import { LANGS, MockTranslator, parseArgs, replay } from '../../../scripts/tuning/replay.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url)); // not .pathname: that is no path on Windows
const run = (...args) =>
  promisify(execFile)(process.execPath, ['scripts/tuning/replay.mjs', ...args], {
    cwd: root,
    env: { ...process.env, GEMINI_API_KEY: '' },
  });

// The output is two tables separated by an empty line: the scores, then the health of the run.
const scores = (stdout) => stdout.split('\n\n')[0].trimEnd().split('\n');
const healthRows = (stdout) => stdout.split('\n\n')[1].trimEnd().split('\n');

const EXPECTED = [
  'strategy       sentences  first ms mean/med/p90  final ms mean/med/p90  flicker mean/med/p90  erased  updates  requests  rateLimited',
  'interval 1.5s  6          833/550/1600           400/400/400            0.00/0.00/0.00        0       13       16        0',
];

test('the replay of the sample trace with the fake translator scores the same on every run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  try {
    const out = join(dir, 'result.json');
    const { stdout } = await run(
      'test/fixtures/replay-trace.json',
      '--mock',
      '--strategy',
      'interval',
      '--speed',
      '20',
      '--out',
      out,
    );
    // --speed shortens the speech 20 times; the fake translator still takes 400 ms.
    assert.equal(stdout.split('\n')[0], EXPECTED[0]);
    assert.equal(
      stdout.split('\n')[1],
      'interval 1.5s  6          495/499/598            400/400/400            0.00/0.00/0.00        0       6        7         0',
      'the speech goes by too fast for most in-progress translations to be shown',
    );

    const { stdout: normal } = await run('test/fixtures/replay-trace.json', '--mock', '--strategy', 'interval');
    assert.deepEqual(scores(normal), EXPECTED);
    assert.deepEqual(healthRows(normal), [
      'strategy       failed  answer ms mean/med/p90  live  settled  last error',
      'interval 1.5s  0       400/400/400             4/6   0/6',
    ]);

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
  assert.equal(scores(stdout).length, 3);
  assert.equal(healthRows(stdout).length, 3);
});

const STRATEGY_ROWS = {
  mock: [
    'interval 1.5s  6          833/550/1600           400/400/400            0.00/0.00/0.00        0       13       16        0',
    'steady 1.5s    6          500/400/700            400/400/400            0.00/0.00/0.00        0       14       17        0',
    'carry 1.5s     6          500/400/700            400/400/400            0.00/0.00/0.00        0       14       17        0',
    'chunk          6          742/675/1300           400/400/400            0.00/0.00/0.00        0       13       15        0',
  ],
  rephrase: [
    'interval 1.5s  6          833/550/1600           400/400/400            0.46/0.37/1.25        177     13       16        0',
    'steady 1.5s    6          500/400/700            400/400/400            0.42/0.18/1.25        165     14       17        0',
    'carry 1.5s     6          500/400/700            400/400/400            0.00/0.00/0.00        0       14       17        0',
    'chunk          6          742/675/1300           400/400/400            0.00/0.00/0.00        0       13       15        0',
  ],
};

test('every pacing strategy replays the sample trace with the same scores on every run', async () => {
  const strategies = ['--strategy', 'interval,steady,carry,chunk'];
  const { stdout } = await run('test/fixtures/replay-trace.json', '--mock', ...strategies);
  assert.deepEqual(scores(stdout), [EXPECTED[0], ...STRATEGY_ROWS.mock]);
  const { stdout: rephrased } = await run('test/fixtures/replay-trace.json', '--mock=rephrase', ...strategies);
  assert.deepEqual(
    scores(rephrased),
    [EXPECTED[0], ...STRATEGY_ROWS.rephrase],
    'a translator that rephrases makes interval and steady flicker; carry and chunk continue what is shown',
  );
});

// settle keeps an in-progress translation made from the finished text as the final one: half the
// sample's sentences need no final request, and those that waited for one on its way wait less.
const SETTLE_ROWS = {
  mock: 'settle 1.5s    6          450/400/700            250/300/400            0.00/0.00/0.00        0       14       14        0',
  rephrase:
    'settle 1.5s    6          450/400/700            250/300/400            0.00/0.00/0.00        0       14       14        0',
};

test('settle replays the sample trace with the same scores on every run, and counts the settled sentences', async () => {
  const strategies = ['--strategy', 'interval,steady,carry,chunk,settle'];
  for (const mode of ['mock', 'rephrase']) {
    const { stdout } = await run(
      'test/fixtures/replay-trace.json',
      mode === 'mock' ? '--mock' : '--mock=rephrase',
      ...strategies,
    );
    assert.deepEqual(scores(stdout), [EXPECTED[0], ...STRATEGY_ROWS[mode], SETTLE_ROWS[mode]], mode);
    assert.deepEqual(
      healthRows(stdout),
      [
        'strategy       failed  answer ms mean/med/p90  live  settled  last error',
        'interval 1.5s  0       400/400/400             4/6   0/6',
        'steady 1.5s    0       400/400/400             5/6   0/6',
        'carry 1.5s     0       400/400/400             5/6   0/6',
        'chunk          0       400/400/400             5/6   0/6',
        'settle 1.5s    0       400/400/400             5/6   3/6',
      ],
      mode,
    );
  }
});

test('settle: a sentence is final as soon as it is finished, or when the request on its way arrives', async () => {
  const trace = JSON.parse(readFileSync(join(root, 'test/fixtures/replay-trace.json'), 'utf8'));
  const { requests, result } = await recordRequests(trace, 'settle');
  const finals = requests.filter((r) => r.final).map((r) => r.text);
  const settled = result.sentences.filter((s) => s.settled);
  assert.deepEqual(
    settled.map((s) => [s.src, s.metrics.finalDelayMs]),
    [
      ['おはようございます。', 100],
      ['今日は新しい検索画面の進め方について話したいと思います。', 200],
      ['Great, let’s review it on Friday.', 0],
    ],
    'the delay is what was left of the request on its way, or none',
  );
  for (const s of settled) {
    assert.ok(!finals.includes(s.src), `no final request for ${s.src}`);
    assert.equal(s.finalText, s.displays.at(-1).text, 'the final translation is what stays on screen');
  }
  assert.equal(finals.length, 3, 'the others are asked for as with carry');
  for (const s of result.sentences.filter((x) => !x.settled)) assert.ok(finals.includes(s.src), s.src);
});

test('settle: a sentence corrected after it was finished is translated again', async () => {
  // The recognizer moves on before finishing the first utterance, then sends its final result with
  // other punctuation: the finished sentence is corrected.
  const events = [
    { t: 500, kind: 'interim', text: 'こんにちは皆さん' },
    { t: 2000, kind: 'interim', text: '今日は' },
    { t: 2500, kind: 'interim', text: '今日は天気がいい' },
    { t: 4000, kind: 'final', text: 'こんにちは、皆さん。' },
    { t: 6000, kind: 'final', text: '今日は天気がいいですね。' },
  ];
  const trace = { version: 1, langs: ['ja-JP', 'en-US'], events, durationMs: 7000 };
  const { requests, result } = await recordRequests(trace, 'settle');
  assert.deepEqual(
    requests.filter((r) => r.final).map((r) => r.text),
    ['こんにちは、皆さん。', '今日は天気がいいですね。'],
    'the first sentence settled with no request, then its correction was translated',
  );
  assert.deepEqual(
    result.sentences.map((s) => [s.src, s.settled]),
    [
      ['こんにちは、皆さん。', false],
      ['今日は天気がいいですね。', false],
    ],
  );
  assert.ok(result.sentences[0].finalText.includes('、'), result.sentences[0].finalText);
});

test('settle: a sentence in neither language settles only when every line has the same text translated', async () => {
  const words = '안녕하세요 여러분, 오늘은 새로운 검색 화면의 디자인에 대해 이야기하고 싶습니다'.split(' ');
  const events = words.map((_, i) => ({ t: 500 + i * 400, kind: 'interim', text: words.slice(0, i + 1).join(' ') }));
  const last = 500 + words.length * 400;
  const finish = (text) => {
    const list = [...events, { t: last + 1500, kind: 'final', text }];
    return { version: 1, langs: ['ja-JP', 'en-US'], events: list, durationMs: last + 2500 };
  };
  let { requests, result } = await recordRequests(finish(`${words.join(' ')}.`), 'settle');
  assert.deepEqual(
    requests.filter((r) => r.final),
    [],
  );
  assert.equal(result.sentences[0].settled, true);
  assert.equal(result.sentences[0].finalText.split('\n').length, 2, 'both lines');

  ({ requests, result } = await recordRequests(finish(`${words.join(' ')} 감사합니다.`), 'settle'));
  assert.deepEqual(
    requests
      .filter((r) => r.final)
      .map((r) => r.into)
      .sort(),
    ['English', 'Japanese'],
    'other words: both lines are asked for',
  );
  assert.equal(result.sentences[0].settled, false);
});

test('an unknown strategy is refused before the replay starts', async () => {
  await assert.rejects(run('test/fixtures/replay-trace.json', '--mock', '--strategy', 'interval,nope'), (err) =>
    /Unknown strategy: nope\. Known: interval, steady, carry, chunk/.test(err.stderr),
  );
});

test('the fake translator rephrases on request, and continues a translation it is given', async () => {
  const clock = createVirtualClock(0);
  const make = (rephrase) =>
    new MockTranslator({ langA: 'Japanese', langB: 'English', setTimer: clock.setTimer, rephrase });
  const ask = async (translator, text, options) => {
    const out = translator.translate(text, options);
    await clock.runAll();
    return out;
  };
  const plain = make(false);
  assert.equal(await ask(plain, 'I looked at the draft'), '[Japanese] I looked at the draft', 'as before');
  const rephrasing = make(true);
  assert.equal(await ask(rephrasing, 'I looked at'), '[Japanese] at I looked');
  assert.equal(await ask(rephrasing, 'I looked at the draft'), '[Japanese] draft I looked at the');
  assert.equal(await ask(rephrasing, '今日は新しい'), '[English] い今日は新し');
  for (const translator of [plain, rephrasing]) {
    assert.equal(
      await ask(translator, 'I looked at the draft', { previous: '[Japanese] at I looked' }),
      `[Japanese] at I looked ${translator === plain ? 'the draft' : 'draft the'}`,
      'what is shown is kept, the rest is added',
    );
    assert.equal(await ask(translator, 'Thanks.', { previous: '[Japanese] Thanks.' }), '[Japanese] Thanks.');
    assert.equal(
      await ask(translator, 'Thanks. I looked', { previous: '[Japanese] Thanks.' }),
      `[Japanese] Thanks. ${translator === plain ? 'I looked' : 'looked I'}`,
    );
  }
});

// Runs the replay with a translator that records every request.
async function recordRequests(trace, strategy) {
  const clock = createVirtualClock(Date.UTC(2026, 0, 1));
  const mock = new MockTranslator({ langA: 'Japanese', langB: 'English', setTimer: clock.setTimer, rephrase: true });
  const requests = [];
  const translator = {
    translate: (text, options) => {
      requests.push({ text, final: !!options.onDelta, into: options.into, previous: options.previous });
      return mock.translate(text, options);
    },
    identify: () => mock.identify(),
  };
  const result = await replay({ trace, strategy, clock, translator });
  return { requests, result };
}

test('carry and chunk pass what is shown to every request after the first, and to the final one', async () => {
  const trace = JSON.parse(readFileSync(join(root, 'test/fixtures/replay-trace.json'), 'utf8'));
  const { requests: plain } = await recordRequests(trace, 'interval');
  assert.ok(
    plain.every((r) => r.previous === undefined),
    'interval passes nothing',
  );
  for (const strategy of ['carry', 'chunk']) {
    const { requests, result } = await recordRequests(trace, strategy);
    const finals = requests.filter((r) => r.final);
    assert.equal(finals.length, 6);
    for (const s of result.sentences) {
      const shown = s.displays.filter((d) => d.t <= s.finishedAt);
      const final = finals.find((r) => r.text === s.src);
      assert.equal(final.previous, shown.at(-1)?.text, `${strategy}: ${s.src}`);
      if (shown.length) assert.ok(s.finalText.startsWith(shown.at(-1).text), 'the final translation continues it');
    }
    const later = requests.filter((r) => !r.final && r.previous);
    assert.ok(later.length >= 3, strategy);
  }
});

test('a sentence in neither language continues each target line on its own', async () => {
  const words = '안녕하세요 여러분, 오늘은 새로운 검색 화면의 디자인에 대해 이야기하고 싶습니다.'.split(' ');
  const events = words.map((_, i) => ({ t: 500 + i * 400, kind: 'interim', text: words.slice(0, i + 1).join(' ') }));
  events.push({ t: 500 + words.length * 400 + 300, kind: 'final', text: words.join(' ') });
  const trace = { version: 1, langs: ['ja-JP', 'en-US'], events, durationMs: events.at(-1).t + 1000 };
  for (const strategy of ['carry', 'chunk']) {
    const { requests, result } = await recordRequests(trace, strategy);
    const continued = requests.filter((r) => r.previous);
    assert.ok(continued.length >= 4, strategy);
    for (const r of continued) assert.ok(r.previous.startsWith(`[${r.into}] `), `${strategy}: ${r.previous}`);
    const finals = requests.filter((r) => r.final);
    assert.deepEqual(finals.map((r) => r.into).sort(), ['English', 'Japanese']);
    assert.ok(finals.every((r) => r.previous));
    // (The flicker score reads both lines as one text, so a growing first line counts as erasing the
    // second; look at each line instead.)
    const last = new Map();
    for (const { text } of result.sentences[0].displays) {
      for (const line of text.split('\n').filter(Boolean)) {
        const tag = line.slice(0, line.indexOf(']') + 1);
        assert.ok(line.startsWith(last.get(tag) ?? ''), `${strategy}: ${last.get(tag)} -> ${line}`);
        last.set(tag, line);
      }
    }
    assert.deepEqual([...last.keys()].sort(), ['[English]', '[Japanese]']);
  }
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
    limit: null,
    together: false,
  });
  assert.equal(parseArgs(['t.json', '--limit', '90', '--together']).limit, 90);
  assert.equal(parseArgs(['t.json', '--together']).together, true);
  assert.throws(() => parseArgs(['t.json', '--limit', '0']), /limit/);
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
  const loud = await run('test/fixtures/replay-trace.json', '--mock', '--strategy', 'interval');
  assert.equal(scores(loud.stdout).length, 2, 'stdout holds the two tables only');
  assert.equal(healthRows(loud.stdout).length, 2);
  assert.match(loud.stderr, /Trace: 0:21 of speech, 43 recognizer results \(4 final\), Japanese \/ English\./);
  assert.match(loud.stderr, /interval: 0:\d\d \/ 0:21, 6 sentences, 16 requests/);
  assert.match(loud.stderr, /flicker +share of shown translation/);
  const quiet = await run('test/fixtures/replay-trace.json', '--mock', '--strategy', 'interval', '--quiet');
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

test('--limit replays only the beginning of the trace', async () => {
  const { stdout, stderr } = await run(
    'test/fixtures/replay-trace.json',
    '--mock',
    '--strategy',
    'interval',
    '--limit',
    '8',
  );
  assert.match(stderr, /Trace: 0:08 of speech/);
  const sentences = Number(scores(stdout)[1].split(/\s{2,}/)[1]);
  assert.ok(sentences > 0 && sentences < 6, `fewer sentences than the whole trace has: ${sentences}`);
});
