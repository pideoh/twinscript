// How sessions are laid out in storage: the parts of src/store.js that need no IndexedDB.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  segmentChanges,
  segmentFromRecord,
  segmentRange,
  segmentRecord,
  splitSession,
  summaryFromRecord,
  summaryRecord,
} from '../../../src/store.js';

const twoLanguages = {
  id: 's1',
  title: 'Weekly',
  customTitle: false,
  createdAt: 1,
  updatedAt: 2,
  langA: 'ja',
  langB: 'en',
  activeMs: 5000,
  segments: [
    { id: 'a', at: 10, elapsed: 0, src: 'Hello.', tgt: 'こんにちは。' },
    { id: 'b', at: 20, elapsed: 1000, src: 'Failed.', tgt: undefined },
    { id: 'c', at: 30, elapsed: 2000, src: 'No translation field.' },
  ],
  recordings: [{ id: 'r1', startedAt: 1, elapsedStart: 0, durationMs: 4000, mime: 'audio/webm' }],
};
const threeLanguages = {
  ...twoLanguages,
  id: 's2',
  langC: 'zh',
  segments: [
    {
      id: 'x',
      at: 1,
      elapsed: 0,
      src: 'Bonjour.',
      tgt: 'こんにちは。\nHello.',
      lang: 'other',
      tgts: [
        { lang: 'ja', text: 'こんにちは。' },
        { lang: 'en', text: 'Hello.' },
      ],
    },
  ],
  summary: { overview: 'o', keyPoints: [], decisions: [], actionItems: [], segmentCount: 1 },
};

test('a stored session keeps everything but its segments, plus how many there are', () => {
  const { meta, segments } = splitSession(twoLanguages, { fromDisk: true });
  const { segments: _, ...rest } = twoLanguages;
  assert.deepEqual(meta, { ...rest, segmentCount: 3 });
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(segmentFromRecord), twoLanguages.segments, 'nothing lost, same order');
  assert.deepEqual(
    segments.map((s) => [s.sessionId, s.pos]),
    [
      ['s1', 0],
      ['s1', 1],
      ['s1', 2],
    ],
  );
});

test('three-language segments and the summary survive the split', () => {
  const { meta, segments } = splitSession(threeLanguages, { fromDisk: true });
  assert.deepEqual(meta.summary, threeLanguages.summary);
  assert.equal(meta.langC, 'zh');
  assert.deepEqual(segments.map(segmentFromRecord), threeLanguages.segments);
});

test('the upgrade keeps fields a stored segment has even if the app no longer writes them', () => {
  const old = { ...twoLanguages, segments: [{ id: 'a', at: 1, elapsed: 0, src: 's', tgt: 't', extra: 42 }] };
  assert.equal(splitSession(old, { fromDisk: true }).segments[0].extra, 42);
});

test('saving stores only what a segment is, not its screen state', () => {
  const el = {};
  const seg = { id: 'a', at: 1, elapsed: 0, src: 's', tgt: 't', el, rev: 3, lines: new Map(), spoken: true };
  assert.deepEqual(segmentRecord('s1', 4, seg), {
    sessionId: 's1',
    pos: 4,
    id: 'a',
    at: 1,
    elapsed: 0,
    src: 's',
    tgt: 't',
  });
  const tgts = [{ lang: 'ja', text: 'x', node: el }];
  const record = segmentRecord('s1', 0, { ...seg, lang: 'en', tgts });
  assert.deepEqual(record.tgts, [{ lang: 'ja', text: 'x' }]);
  assert.notEqual(record.tgts[0], tgts[0], 'a copy, so later changes are noticed');
});

test('a session listed without its segments keeps its count and writes no segments', () => {
  const { segments, ...listed } = { ...twoLanguages, segmentCount: 3 };
  const split = splitSession(listed);
  assert.equal(split.segments, null);
  assert.equal(split.meta.segmentCount, 3);
});

test('only new and changed segments are written again', () => {
  const session = structuredClone(twoLanguages);
  const first = splitSession(session).segments;
  assert.deepEqual(segmentChanges(first, null).puts, first, 'nothing known yet: everything');
  assert.deepEqual(segmentChanges(first, first), { puts: [], trimFrom: null }, 'nothing changed');

  session.segments[1].tgt = 'Translated later.';
  session.segments.push({ id: 'd', at: 40, elapsed: 3000, src: 'New.', tgt: '' });
  const second = splitSession(session).segments;
  assert.deepEqual(
    segmentChanges(second, first).puts.map((r) => r.pos),
    [1, 3],
  );

  const three = splitSession(structuredClone(threeLanguages)).segments;
  const changed = structuredClone(threeLanguages);
  changed.segments[0].tgts[1].text = 'Hi.';
  assert.equal(segmentChanges(splitSession(changed).segments, three).puts.length, 1, 'one line of a segment');
});

test('a segment keeps its speaker, and labelling rewrites only the segments whose speaker changed', () => {
  const session = structuredClone(twoLanguages);
  const before = splitSession(session).segments;
  assert.ok(!('speaker' in before[0]), 'no speaker field until there is one');
  session.segments[0].speaker = 's1';
  session.segments[2].speaker = 's2';
  const labeled = splitSession(session).segments;
  assert.equal(labeled[0].speaker, 's1');
  assert.deepEqual(
    segmentChanges(labeled, before).puts.map((r) => r.pos),
    [0, 2],
  );
  session.segments[2].speaker = 's1'; // corrected by hand
  assert.deepEqual(
    segmentChanges(splitSession(session).segments, labeled).puts.map((r) => r.pos),
    [2],
  );
});

test('removed or reordered segments are rewritten or trimmed', () => {
  const session = structuredClone(twoLanguages);
  const before = splitSession(session).segments;
  session.segments.reverse();
  const reordered = segmentChanges(splitSession(session).segments, before);
  assert.deepEqual(
    reordered.puts.map((r) => r.id),
    ['c', 'a'],
  );
  session.segments.splice(1, 2); // c is left, where a was
  const removed = segmentChanges(splitSession(session).segments, before);
  assert.deepEqual(
    removed.puts.map((r) => r.id),
    ['c'],
  );
  assert.equal(removed.trimFrom, 1);
});

test("a session's segment keys sort between the bounds of its range and no other session's", () => {
  // IndexedDB orders numbers before strings before arrays, and arrays element by element.
  const order = (a, b) => {
    const rank = (x) => (Array.isArray(x) ? 2 : typeof x === 'string' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (!Array.isArray(a)) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = order(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  };
  const [lower, upper] = segmentRange('s1');
  // Segment positions, and summary ids (strings), which use the same range.
  for (const pos of [0, 1, 99999, '', '0f8e-summary', 'zzzz']) {
    assert.ok(order(lower, ['s1', pos]) < 0 && order(['s1', pos], upper) < 0);
  }
  for (const other of [
    ['s0', 5],
    ['s10', 0],
    ['s2', 0],
  ]) {
    assert.ok(order(other, lower) < 0 || order(other, upper) > 0, String(other));
  }
});

test('summaries are stored one record each, apart from the session record that the list reads', () => {
  const summary = {
    id: 'sum-1',
    templateId: 'preset:minutes',
    templateName: 'Meeting minutes',
    length: 'short',
    language: 'ja-JP',
    createdAt: 5,
    markdown: '## Decisions\n\n- Ship it',
    model: 'm',
    truncated: false,
    segmentCount: 3,
  };
  const { meta } = splitSession({ ...twoLanguages, summaries: [summary] });
  assert.equal(meta.summaries, undefined, 'not in the session record');
  const record = summaryRecord('s1', summary);
  assert.deepEqual(record, { ...summary, sessionId: 's1' });
  assert.deepEqual(summaryFromRecord(record), summary);
});
