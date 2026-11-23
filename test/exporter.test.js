import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranscript, formatElapsed, safeFileName } from '../src/exporter.js';

const session = {
  title: '定例会議',
  createdAt: new Date(2026, 10, 15, 9, 5).getTime(),
  activeMs: 754_000,
  langA: 'ja-JP',
  langB: 'en-US',
  segments: [
    { elapsed: 3_200, src: 'こんにちは。', tgt: 'Hello.' },
    { elapsed: 65_000, src: 'He said "go" | now,\nright?', tgt: '彼は「行け」と言った。' },
    { elapsed: 3_725_000, src: 'まだ翻訳されていない文', tgt: '' },
  ],
};
const langLabel = (code) => ({ 'ja-JP': '日本語', 'en-US': '英語' })[code];
// What the app passes in when the UI is Japanese.
const labels = {
  title: '文字起こし',
  date: '日時',
  languages: '言語',
  duration: '長さ',
  time: '時間',
  source: '原文',
  translation: '訳文',
  separator: '　',
};

test('formatElapsed', () => {
  assert.equal(formatElapsed(0), '00:00:00');
  assert.equal(formatElapsed(65_999), '00:01:05');
  assert.equal(formatElapsed(3_725_000), '01:02:05');
});

test('plain text has a header, timestamps and the translation aligned under the source', () => {
  const { text, ext } = buildTranscript(session, { langLabel, labels });
  assert.equal(ext, 'txt');
  assert.equal(
    text,
    [
      '定例会議',
      '日時: 2026-11-15 09:05　言語: 日本語 ⇄ 英語　長さ: 00:12:34',
      '',
      '[00:00:03] こんにちは。',
      '           → Hello.',
      '',
      '[00:01:05] He said "go" | now, right?',
      '           → 彼は「行け」と言った。',
      '',
      '[01:02:05] まだ翻訳されていない文',
      '',
    ].join('\n'),
  );
});

test('source-only and translation-only text', () => {
  const src = buildTranscript(session, { content: 'src', langLabel }).text.split('\n').slice(3);
  assert.deepEqual(src, [
    '[00:00:03] こんにちは。',
    '[00:01:05] He said "go" | now, right?',
    '[01:02:05] まだ翻訳されていない文',
    '',
  ]);
  const tgt = buildTranscript(session, { content: 'tgt', langLabel }).text.split('\n').slice(3);
  assert.deepEqual(
    tgt,
    ['[00:00:03] Hello.', '[00:01:05] 彼は「行け」と言った。', ''],
    'untranslated lines are left out',
  );
});

test('markdown is a table with escaped pipes', () => {
  const { text, ext } = buildTranscript(session, { format: 'md', langLabel, labels });
  assert.equal(ext, 'md');
  const lines = text.split('\n');
  assert.equal(lines[0], '# 定例会議');
  assert.equal(lines[4], '| 時間 | 原文 | 訳文 |');
  assert.equal(lines[6], '| 00:00:03 | こんにちは。 | Hello. |');
  assert.equal(lines[7], '| 00:01:05 | He said "go" \\| now, right? | 彼は「行け」と言った。 |');
});

test('markdown keeps backslashes and pipes inside their cell', () => {
  const tricky = { ...session, segments: [{ elapsed: 0, src: 'C:\\temp | a\\|b', tgt: 'x' }] };
  const { text } = buildTranscript(tricky, { format: 'md', langLabel, labels });
  const row = text.split('\n')[6];
  assert.equal(row, '| 00:00:00 | C:\\\\temp \\| a\\\\\\|b | x |');
  // Unescaped pipes (not preceded by an odd number of backslashes) are exactly the 4 cell borders.
  assert.equal(row.match(/(?<!\\)(?:\\\\)*\|/g).length, 4);
});

test('csv quotes fields and starts with a BOM', () => {
  const { text, ext } = buildTranscript(session, { format: 'csv', langLabel });
  assert.equal(ext, 'csv');
  assert.ok(text.startsWith('﻿time,source,translation\r\n'));
  assert.ok(text.includes('00:01:05,"He said ""go"" | now, right?","彼は「行け」と言った。"\r\n'));
});

test('srt cues end at the next cue, capped at 8 seconds', () => {
  const { text, ext } = buildTranscript(session, { format: 'srt', langLabel });
  assert.equal(ext, 'srt');
  const blocks = text.trimEnd().split('\n\n');
  assert.equal(blocks[0], '1\n00:00:03,200 --> 00:00:11,200\nこんにちは。\nHello.');
  assert.equal(blocks[2], '3\n01:02:05,000 --> 01:02:13,000\nまだ翻訳されていない文');
  const close = buildTranscript(
    {
      ...session,
      segments: [
        { elapsed: 1000, src: 'a' },
        { elapsed: 2500, src: 'b' },
      ],
    },
    { format: 'srt' },
  );
  assert.ok(close.text.startsWith('1\n00:00:01,000 --> 00:00:02,500\na\n'));
});

test('labels default to English and the CSV header never changes', () => {
  const untitled = { ...session, title: '' };
  const txt = buildTranscript(untitled).text.split('\n');
  assert.equal(txt[0], 'Transcript');
  assert.equal(txt[1], 'Date: 2026-11-15 09:05   Languages: ja-JP ⇄ en-US   Duration: 00:12:34');
  const md = buildTranscript(untitled, { format: 'md', content: 'tgt' }).text.split('\n');
  assert.equal(md[0], '# Transcript');
  assert.equal(md[4], '| Time | Translation |');
  assert.equal(
    buildTranscript(untitled, { format: 'md', content: 'src', labels }).text.split('\n')[4],
    '| 時間 | 原文 |',
  );
  const zh = { title: '转录文本', date: '日期', languages: '语言', duration: '时长' };
  assert.equal(
    buildTranscript(untitled, { labels: zh }).text.split('\n')[1],
    '日期: 2026-11-15 09:05   语言: ja-JP ⇄ en-US   时长: 00:12:34',
    'labels that are not given keep their defaults',
  );
  assert.ok(buildTranscript(untitled, { format: 'csv', labels }).text.startsWith('\ufefftime,source,translation\r\n'));
});

// The latest summary of a session, as the app passes it in: Markdown and the name of its template.
const summary = {
  markdown:
    '## Overview\n\nThe team reviewed progress.\n\n## Action items\n\n- Send the report (Ana, Wednesday)\n\n```\n# not a heading\n```',
  title: 'Quick summary',
  truncated: false,
};

test('a text file opens with the summary as it was written, under the name of its template', () => {
  const lines = buildTranscript(session, { langLabel, summary }).text.split('\n');
  assert.deepEqual(lines.slice(2, 20), [
    '',
    'Summary: Quick summary',
    '',
    '## Overview',
    '',
    'The team reviewed progress.',
    '',
    '## Action items',
    '',
    '- Send the report (Ana, Wednesday)',
    '',
    '```',
    '# not a heading',
    '```',
    '',
    'Transcript',
    '',
    '[00:00:03] こんにちは。',
  ]);
  const without = buildTranscript(session, { langLabel, labels }).text;
  assert.ok(!without.includes('Summary') && !without.includes('Transcript'), 'no summary, no extra headings');
});

test('a markdown file nests the summary under its own headings, in the UI language, and notes a truncated transcript', () => {
  const jaLabels = { ...labels, summary: '要約', transcript: '文字起こし', summaryTruncated: '一部のみ' };
  const lines = buildTranscript(session, {
    format: 'md',
    langLabel,
    labels: jaLabels,
    summary: { ...summary, title: '議事録', truncated: true },
  }).text.split('\n');
  assert.deepEqual(lines.slice(3, 22), [
    '',
    '## 要約: 議事録',
    '',
    '一部のみ',
    '',
    '### Overview',
    '',
    'The team reviewed progress.',
    '',
    '### Action items',
    '',
    '- Send the report (Ana, Wednesday)',
    '',
    '```',
    '# not a heading',
    '```',
    '',
    '## 文字起こし',
    '',
  ]);
  assert.equal(lines[22], '| 時間 | 原文 | 訳文 |');
  assert.equal(
    buildTranscript(session, { format: 'md', langLabel, labels }).text.split('\n')[4],
    '| 時間 | 原文 | 訳文 |',
  );
});

test('csv and srt never include the summary', () => {
  for (const format of ['csv', 'srt']) {
    assert.equal(
      buildTranscript(session, { format, langLabel, summary }).text,
      buildTranscript(session, { format, langLabel }).text,
    );
  }
});

const labeled = {
  ...session,
  segments: [
    { ...session.segments[0], speaker: '佐藤' },
    { ...session.segments[1], speaker: 'Speaker 2' },
    { ...session.segments[2], speaker: '' },
  ],
};

test('with speaker labels, text and subtitles put the name before each line', () => {
  const txt = buildTranscript(labeled, { langLabel, labels }).text.split('\n').slice(3);
  assert.deepEqual(txt, [
    '[00:00:03] 佐藤: こんにちは。',
    '           → Hello.',
    '',
    '[00:01:05] Speaker 2: He said "go" | now, right?',
    '           → 彼は「行け」と言った。',
    '',
    '[01:02:05] まだ翻訳されていない文',
    '',
  ]);
  const srt = buildTranscript(labeled, { format: 'srt' }).text;
  assert.match(srt, /^1\n00:00:03,200 --> 00:00:11,200\n佐藤: こんにちは。\nHello\.\n/);
  assert.match(srt, /\n3\n01:02:05,000 --> 01:02:13,000\nまだ翻訳されていない文\n$/);
  const tgtOnly = buildTranscript(labeled, { format: 'srt', content: 'tgt' }).text;
  assert.match(tgtOnly, /^1\n00:00:03,200 --> 00:00:11,200\n佐藤: Hello\.\n/);
});

test('with speaker labels, Markdown and CSV get a speaker column after the time', () => {
  const md = buildTranscript(labeled, { format: 'md', langLabel, labels: { ...labels, speaker: '話者' } }).text;
  assert.match(
    md,
    /\| 時間 \| 話者 \| 原文 \| 訳文 \|\n\| --- \| --- \| --- \| --- \|\n\| 00:00:03 \| 佐藤 \| こんにちは。 \| Hello\. \|/,
  );
  assert.match(md, /\| 01:02:05 \| {2}\| まだ翻訳されていない文 \| {2}\|/);
  const csv = buildTranscript(labeled, { format: 'csv', content: 'src' }).text;
  assert.equal(
    csv,
    '﻿time,speaker,source\r\n00:00:03,"佐藤","こんにちは。"\r\n00:01:05,"Speaker 2","He said ""go"" | now, right?"\r\n01:02:05,"","まだ翻訳されていない文"\r\n',
  );
});

test('files of a session without speaker labels are the same as before labels existed', () => {
  const none = { ...session, segments: session.segments.map((seg) => ({ ...seg, speaker: '' })) };
  for (const format of ['txt', 'md', 'csv', 'srt']) {
    for (const content of ['both', 'src', 'tgt']) {
      assert.equal(
        buildTranscript(none, { format, content, langLabel, labels }).text,
        buildTranscript(session, { format, content, langLabel, labels }).text,
        `${format} ${content}`,
      );
    }
  }
});

test('safeFileName strips characters that are invalid in file names', () => {
  assert.equal(safeFileName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(safeFileName(''), 'transcript');
});
