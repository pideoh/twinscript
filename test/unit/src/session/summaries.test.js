import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chosenLanguage,
  hasFinished,
  legacySummary,
  lengthOrStandard,
  shownSummary,
  staleness,
  summariesOf,
  summaryLanguages,
  summaryLines,
} from '../../../../src/session/summaries.js';
import { DEFAULT_TEMPLATE } from '../../../../src/session/summary-templates.js';

const labels = {
  overview: 'Overview',
  keyPoints: 'Key points',
  decisions: 'Decisions',
  actionItems: 'Action items',
  owner: 'Owner',
  due: 'Due',
};
const old = { overview: 'We met.', keyPoints: ['A'], decisions: [], actionItems: [], generatedAt: 5, model: 'm' };
const made = (id, createdAt, segmentCount = 2) => ({ id, createdAt, segmentCount, markdown: `# ${id}` });

test('a session can be summarized once it has a finished line', () => {
  assert.equal(hasFinished({ segments: [{ src: '' }, { src: 'Hello' }] }), true);
  assert.equal(hasFinished({ segments: [{ src: '' }] }), false);
  assert.equal(hasFinished({ segments: [] }), false);
});

test('a summary length that is not offered any more counts as standard', () => {
  assert.equal(lengthOrStandard('short'), 'short');
  assert.equal(lengthOrStandard('detailed'), 'detailed');
  assert.equal(lengthOrStandard('huge'), 'standard');
  assert.equal(lengthOrStandard(undefined), 'standard');
});

test('a summary made by an earlier version is shown as Markdown under the default template', () => {
  const entry = legacySummary(old, { labels, templateName: 'Quick' });
  assert.equal(entry.id, 'legacy');
  assert.equal(entry.legacy, true);
  assert.equal(entry.templateId, DEFAULT_TEMPLATE);
  assert.equal(entry.templateName, 'Quick');
  assert.equal(entry.createdAt, 5);
  assert.equal(entry.model, 'm');
  assert.equal(entry.truncated, false);
  assert.equal(entry.segmentCount, 0);
  assert.match(entry.markdown, /Overview/);
  assert.match(entry.markdown, /We met\./);
});

test('the summaries of a session are listed oldest first, with the earlier version one first of all', () => {
  const toEntry = (sum) => ({ id: 'legacy', from: sum });
  const sess = { summary: old, summaries: [made('a', 10), made('b', 20)] };
  assert.deepEqual(
    summariesOf(sess, toEntry).map((s) => s.id),
    ['legacy', 'a', 'b'],
  );
  assert.deepEqual(
    summariesOf({ summaries: [made('a', 10)] }, toEntry).map((s) => s.id),
    ['a'],
  );
  assert.deepEqual(summariesOf({ summary: 'not an object' }, toEntry), []);
  assert.deepEqual(summariesOf({}, toEntry), []);
});

test('the summary chosen in the history is shown, else the latest', () => {
  const list = [made('a', 10), made('b', 20)];
  assert.equal(shownSummary(list, 'a').id, 'a');
  assert.equal(shownSummary(list, undefined).id, 'b');
  assert.equal(shownSummary(list, 'deleted').id, 'b');
  assert.equal(shownSummary([], 'a'), null);
});

const segments = (n) => Array.from({ length: n }, (_, i) => ({ src: `line ${i}` }));

test('a summary is out of date once speech is added after it', () => {
  const shown = made('a', 10, 2);
  assert.deepEqual(staleness({ segments: segments(2) }, shown), { stale: false, speakersOnly: false, replaced: false });
  assert.deepEqual(staleness({ segments: segments(3) }, shown), { stale: true, speakersOnly: false, replaced: false });
});

test('a summary is out of date once the speakers are labelled after it, which is said apart', () => {
  const shown = made('a', 10, 2);
  const labelledAt = (madeAt, n) => ({ segments: segments(n), speakerLabels: { speakers: [], madeAt } });
  assert.deepEqual(staleness(labelledAt(20, 2), shown), { stale: true, speakersOnly: true, replaced: false });
  assert.deepEqual(staleness(labelledAt(20, 3), shown), { stale: true, speakersOnly: false, replaced: false });
  assert.deepEqual(staleness(labelledAt(5, 2), shown), { stale: false, speakersOnly: false, replaced: false });
});

test('a summary made before the transcript was rebuilt or put back is out of date, which is said apart', () => {
  const shown = made('a', 10, 2);
  const replacedAt = (time, n = 2) => ({
    segments: segments(n),
    transcriptChangedAt: time,
    speakerLabels: { speakers: [], madeAt: time },
  });
  assert.deepEqual(staleness(replacedAt(20), shown), { stale: true, speakersOnly: false, replaced: true });
  assert.deepEqual(staleness(replacedAt(20, 1), shown), { stale: true, speakersOnly: false, replaced: true });
  assert.deepEqual(staleness(replacedAt(5), shown), { stale: false, speakersOnly: false, replaced: false });
});

test('without a summary nothing is out of date', () => {
  assert.deepEqual(staleness({ segments: segments(3) }, null), { stale: false, speakersOnly: false, replaced: false });
});

test('a summary can be written in the session languages and the display language, each once', () => {
  const offered = ['ja-JP', 'en-US', 'zh-CN'];
  assert.deepEqual(summaryLanguages({ langA: 'ja-JP', langB: 'en-US' }, 'en-US', offered), ['ja-JP', 'en-US']);
  assert.deepEqual(summaryLanguages({ langA: 'ja-JP', langB: 'en-US', langC: 'zh-CN' }, undefined, offered), [
    'ja-JP',
    'en-US',
    'zh-CN',
  ]);
  assert.deepEqual(summaryLanguages({ langA: 'ja-JP', langB: 'xx-XX' }, 'zh-CN', offered), ['ja-JP', 'zh-CN']);
});

test('the summary language saved is chosen when offered, else the display language, else the first', () => {
  assert.equal(chosenLanguage(['ja-JP', 'en-US'], 'en-US', 'ja-JP'), 'en-US');
  assert.equal(chosenLanguage(['ja-JP', 'en-US'], 'zh-CN', 'ja-JP'), 'ja-JP');
  assert.equal(chosenLanguage(['ja-JP', 'en-US'], 'zh-CN', undefined), 'ja-JP');
});

test('lines sent to be summarized carry the speaker name only when there is one', () => {
  const names = { s1: 'Aiko' };
  const lines = summaryLines(
    [
      { elapsed: 0, src: 'Hi', tgt: 'やあ', speaker: 's1', at: 1, id: 'x' },
      { elapsed: 1000, src: 'Yes', tgt: 'はい' },
    ],
    (id) => names[id] ?? '',
  );
  assert.deepEqual(lines, [
    { elapsed: 0, src: 'Hi', tgt: 'やあ', speaker: 'Aiko' },
    { elapsed: 1000, src: 'Yes', tgt: 'はい' },
  ]);
});
