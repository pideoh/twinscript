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

test('safeFileName strips characters that are invalid in file names', () => {
  assert.equal(safeFileName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(safeFileName(''), 'transcript');
});
