// Browser tests: how sessions are kept in IndexedDB. Transcripts saved by earlier versions (one
// record per session, segments inside) are moved to one record per segment, saving while listening
// writes only the segments that changed, and deleting a session removes everything it had.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  download,
  mockGemini,
  reload,
  rows,
  saved,
  sessionNames,
  setup,
  showTab,
  tagged,
  translated,
} from './helpers.js';

const { openApp } = setup();

const T0 = Date.UTC(2026, 9, 1, 0, 0);
const HOUR = 3_600_000;
const seg = (id, i, src, tgt) => ({ id: `${id}-${i}`, at: T0 + i * 1000, elapsed: i * 1000, src, tgt });

// Sessions in the shapes earlier versions saved (database version 1), oldest first.
// `audio`: the bytes of each recorded chunk, per session.
const OLD = {
  sessions: [
    {
      // Two languages, title taken from the first sentence; a translation that failed (no `tgt`)
      // and an empty one.
      id: 'two',
      title: 'Opening remarks.',
      customTitle: false,
      createdAt: T0,
      updatedAt: T0 + HOUR,
      langA: 'ja',
      langB: 'en',
      activeMs: 65_000,
      segments: [
        seg('two', 0, 'Opening remarks.', '開会の挨拶。'),
        { id: 'two-1', at: T0 + 1000, elapsed: 1000, src: 'Lost translation.' },
        seg('two', 2, 'Empty translation.', ''),
      ],
      recordings: [],
    },
    {
      // Three languages: each segment has the language it was spoken in and one line per target.
      id: 'three',
      title: '三か国語',
      customTitle: true,
      createdAt: T0 + HOUR,
      updatedAt: T0 + 2 * HOUR,
      langA: 'ja',
      langB: 'en',
      langC: 'zh',
      activeMs: 3_723_000,
      segments: [
        {
          ...seg('three', 0, 'おはようございます。', 'Good morning.\n早上好。'),
          lang: 'ja',
          tgts: [
            { lang: 'en', text: 'Good morning.' },
            { lang: 'zh', text: '早上好。' },
          ],
        },
        {
          ...seg('three', 1, 'Bonjour.', 'こんにちは。\nHello.\n你好。'),
          lang: 'other',
          tgts: [
            { lang: 'ja', text: 'こんにちは。' },
            { lang: 'en', text: 'Hello.' },
            { lang: 'zh', text: '你好。' },
          ],
        },
      ],
      recordings: [],
    },
    {
      // A long one with a summary.
      id: 'long',
      title: 'Quarterly review',
      customTitle: true,
      createdAt: T0 + 2 * HOUR,
      updatedAt: T0 + 3 * HOUR,
      langA: 'en',
      langB: 'ja',
      activeMs: 1_800_000,
      segments: Array.from({ length: 320 }, (_, i) => seg('long', i, `Sentence number ${i}.`, `${i}番目の文。`)),
      recordings: [],
      summary: {
        overview: '四半期の振り返りを行った。',
        keyPoints: ['売上が伸びた'],
        decisions: ['予算を増やす'],
        actionItems: [{ task: '計画を書く', owner: '田中', due: '月曜日' }],
        truncated: false,
        generatedAt: T0 + 3 * HOUR,
        model: 'gemini-3.5-flash-lite',
        segmentCount: 320,
      },
    },
    {
      // Recorded audio.
      id: 'recorded',
      title: 'Recorded call.',
      customTitle: false,
      createdAt: T0 + 3 * HOUR,
      updatedAt: T0 + 4 * HOUR,
      langA: 'ja',
      langB: 'en',
      activeMs: 9_000,
      segments: [seg('recorded', 0, 'Recorded call.', '録音した通話。'), seg('recorded', 1, 'Bye.', 'さようなら。')],
      recordings: [{ id: 'rec-1', startedAt: T0 + 3 * HOUR, elapsedStart: 0, durationMs: 9_000, mime: 'audio/webm' }],
    },
    {
      // A recording in which nothing was said.
      id: 'silent',
      title: '2026-10-01 05:00',
      customTitle: false,
      createdAt: T0 + 4 * HOUR,
      updatedAt: T0 + 5 * HOUR,
      langA: 'ja',
      langB: 'en',
      activeMs: 4_000,
      segments: [],
      recordings: [{ id: 'rec-2', startedAt: T0 + 4 * HOUR, elapsedStart: 0, durationMs: 4_000, mime: 'audio/webm' }],
    },
  ],
  audio: [
    { sessionId: 'recorded', recId: 'rec-1', bytes: [1, 2, 3, 4, 5] },
    { sessionId: 'recorded', recId: 'rec-1', bytes: [6, 7, 8] },
    { sessionId: 'silent', recId: 'rec-2', bytes: [9, 9] },
  ],
};

// Runs in the page before the app, once per test: creates the database the way version 1 of the
// store did and fills it.
function seedVersion1(old) {
  if (window !== top || localStorage.getItem('e2e-db-seeded')) return;
  localStorage.setItem('e2e-db-seeded', '1');
  const request = indexedDB.open('twinscript', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
    const audio = db.createObjectStore('audio', { autoIncrement: true });
    audio.createIndex('recording', ['sessionId', 'recId']);
    audio.createIndex('session', 'sessionId');
    for (const s of old.sessions) sessions.put(s);
    for (const { sessionId, recId, bytes } of old.audio)
      audio.add({ sessionId, recId, blob: new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }) });
  };
  request.onsuccess = () => request.result.close();
}

// Everything on disk: { version, stores, sessions, segments, audio }.
const dump = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('twinscript');
        request.onerror = () => reject(request.error);
        request.onsuccess = async () => {
          const db = request.result;
          const all = (name) =>
            new Promise((res) => {
              const r = db.transaction(name).objectStore(name).getAll();
              r.onsuccess = () => res(r.result);
            });
          const out = {
            version: db.version,
            stores: [...db.objectStoreNames],
            sessions: await all('sessions'),
            segments: db.objectStoreNames.contains('segments') ? await all('segments') : [],
            audio: await Promise.all(
              (await all('audio')).map(async ({ sessionId, recId, blob }) => ({
                sessionId,
                recId,
                bytes: [...new Uint8Array(await blob.arrayBuffer())],
              })),
            ),
          };
          db.close();
          resolve(out);
        };
      }),
  );

const openSession = async (page, title, count) => {
  await page.locator('#sessionList .session', { hasText: title }).locator('.open').click();
  await page.waitForFunction(
    ([t, n]) =>
      document.querySelector('#sessionList .current .name')?.textContent === t &&
      document.querySelectorAll('.seg').length === n,
    [title, count],
  );
};
const times = (page) => page.locator('.seg .time').allTextContents();
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);

test('transcripts saved by an earlier version are moved to the new layout without losing anything', async () => {
  const { page, errors, close } = await openApp('', { record: false }, { script: seedVersion1, arg: OLD });
  await page.waitForSelector('#sessionList .session');

  // The list: newest first, with titles and durations as before.
  const newestFirst = [...OLD.sessions].reverse();
  assert.deepEqual(
    await sessionNames(page),
    newestFirst.map((s) => s.title),
  );
  const when = await page.locator('#sessionList .when').allTextContents();
  assert.deepEqual(
    when.map((w) => w.split(' ・ ')[1]),
    newestFirst.map((s) => hhmmss(s.activeMs)),
  );

  // On disk: version 5, session records without segments, one record per segment in order, and
  // stores for summaries, questions and kept transcripts (an old summary stays in its session record
  // as it was).
  const disk = await dump(page);
  assert.equal(disk.version, 5);
  assert.deepEqual(disk.stores.sort(), ['audio', 'questions', 'segments', 'sessions', 'summaries', 'transcripts']);
  for (const old of OLD.sessions) {
    const { segments, ...meta } = old;
    const record = disk.sessions.find((s) => s.id === old.id);
    assert.deepEqual(record, { ...meta, segmentCount: segments.length }, `${old.id}: metadata kept, segments moved`);
    const moved = disk.segments.filter((s) => s.sessionId === old.id);
    assert.deepEqual(
      moved.map(({ sessionId, pos, ...rest }) => rest),
      segments,
      `${old.id}: every segment, in order`,
    );
    assert.deepEqual(
      moved.map((s) => s.pos),
      segments.map((_, i) => i),
    );
  }
  assert.equal(disk.segments.length, 327);
  assert.deepEqual(disk.audio, OLD.audio, 'recordings untouched');

  // Each session opens with exactly its segments.
  await openSession(page, 'Opening remarks.', 3);
  assert.deepEqual(await rows(page), [
    { live: false, src: 'Opening remarks.', tgt: '開会の挨拶。' },
    { live: false, src: 'Lost translation.', tgt: '' },
    { live: false, src: 'Empty translation.', tgt: '' },
  ]);
  assert.deepEqual(await times(page), ['00:00:00', '00:00:01', '00:00:02']);

  await openSession(page, '三か国語', 2);
  assert.deepEqual(
    (await tagged(page)).map(({ src, lines }) => ({ src, lines: lines.map(([, text]) => text) })),
    [
      { src: 'おはようございます。', lines: ['Good morning.', '早上好。'] },
      { src: 'Bonjour.', lines: ['こんにちは。', 'Hello.', '你好。'] },
    ],
  );

  await openSession(page, 'Quarterly review', 320);
  const long = await rows(page);
  assert.deepEqual(
    long,
    OLD.sessions[2].segments.map(({ src, tgt }) => ({ live: false, src, tgt })),
  );
  assert.equal((await times(page))[319], '00:05:19');
  await showTab(page, 'summary');
  await page.waitForSelector('#summary:not([hidden])');
  assert.ok((await page.textContent('#summaryContent')).includes('四半期の振り返りを行った。'), 'summary kept');
  assert.ok(await page.locator('#summaryStale').isHidden(), 'and still up to date');
  // The summary an earlier version made (structured, not Markdown) is shown in today's form.
  assert.deepEqual(await page.locator('#summaryContent h3').allTextContents(), [
    '概要',
    '主なポイント',
    '決定事項',
    'アクションアイテム',
  ]);
  assert.deepEqual(await page.locator('#summaryContent li').allTextContents(), [
    '売上が伸びた',
    '予算を増やす',
    '計画を書く (担当: 田中, 期限: 月曜日)',
  ]);
  assert.match(await page.textContent('#summaryDetails'), /^クイック要約 ・ 以前のバージョンで作成$/);
  assert.match((await page.locator('#summaryHistory option').allTextContents())[0], / ・ クイック要約$/);

  await openSession(page, 'Recorded call.', 2);
  await page.click('#export');
  assert.match(await page.textContent('#recordings .rec span'), /^録音 1 ・ .* ・ 00:00:09$/);
  const file = await download(page, () => page.click('#recordings .rec button'));
  const bytes = [];
  for await (const chunk of await file.createReadStream()) bytes.push(...chunk);
  assert.deepEqual(bytes, [1, 2, 3, 4, 5, 6, 7, 8], 'the recording downloads as it was saved');
  await page.keyboard.press('Escape');

  await openSession(page, '2026-10-01 05:00', 0);

  // Opening sessions changes nothing on disk, and neither does starting again.
  assert.deepEqual(await dump(page), disk);
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(
    await sessionNames(page),
    newestFirst.map((s) => s.title),
  );
  assert.deepEqual(await rows(page), [], 'the last one opened had no transcript');
  assert.deepEqual(await dump(page), disk);
  assert.deepEqual(errors, []);
  await close();
});

// Counts what is written to the segment store.
function countSegmentWrites() {
  if (window !== top) return;
  window.segmentWrites = [];
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'segments') window.segmentWrites.push({ pos: value.pos, src: value.src, tgt: value.tgt });
    return put.call(this, value, key);
  };
}

test('saving while listening writes only the sentences that changed, and a reload restores them', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', record: false },
    { script: countSegmentWrites },
  );
  await mockGemini(page, [
    [3, 'final', 'First sentence.'],
    [12, 'final', 'Second sentence.'],
    [24, 'final', 'Third sentence.'],
  ]);
  await page.click('#toggle');
  await translated(page, 1);
  await saved(page);
  const afterFirst = await page.evaluate(() => window.segmentWrites.length);
  assert.ok(afterFirst >= 1);

  await translated(page, 3);
  await saved(page);
  const writes = await page.evaluate(() => window.segmentWrites);
  assert.deepEqual(
    writes.slice(afterFirst).filter((w) => w.pos === 0),
    [],
    'the first sentence is not written again when others are added',
  );
  for (const pos of [0, 1, 2]) {
    const mine = writes.filter((w) => w.pos === pos);
    assert.ok(mine.length >= 1 && mine.length <= 2, `sentence ${pos} written ${mine.length} times`);
    assert.match(mine.at(-1).tgt, /^訳:/, 'its last write has the translation');
  }
  const disk = await dump(page);
  assert.equal(disk.sessions.length, 1);
  assert.equal(disk.sessions[0].segments, undefined);
  assert.equal(disk.sessions[0].segmentCount, 3);
  assert.deepEqual(
    disk.segments.map((s) => [s.pos, s.src, s.tgt]),
    [
      [0, 'First sentence.', '訳:First sentence.'],
      [1, 'Second sentence.', '訳:Second sentence.'],
      [2, 'Third sentence.', '訳:Third sentence.'],
    ],
  );

  // Reloaded while still listening.
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(await sessionNames(page), ['First sentence.']);
  assert.deepEqual(await rows(page), [
    { live: false, src: 'First sentence.', tgt: '訳:First sentence.' },
    { live: false, src: 'Second sentence.', tgt: '訳:Second sentence.' },
    { live: false, src: 'Third sentence.', tgt: '訳:Third sentence.' },
  ]);
  assert.deepEqual(errors, []);
  await close();
});

test('deleting a session removes its transcript and recordings and leaves the others', async () => {
  const { page, errors, close } = await openApp('', { record: false }, { script: seedVersion1, arg: OLD });
  await page.waitForSelector('#sessionList .session');
  const before = await dump(page);

  page.once('dialog', (d) => d.accept());
  await page.locator('#sessionList .session', { hasText: 'Recorded call.' }).locator('.act').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 4);
  await saved(page);

  const after = await dump(page);
  assert.deepEqual(
    after.sessions,
    before.sessions.filter((s) => s.id !== 'recorded'),
  );
  assert.deepEqual(
    after.segments,
    before.segments.filter((s) => s.sessionId !== 'recorded'),
  );
  assert.deepEqual(
    after.audio,
    before.audio.filter((a) => a.sessionId !== 'recorded'),
  );
  assert.equal(after.segments.length, 325);
  assert.deepEqual(after.audio, [{ sessionId: 'silent', recId: 'rec-2', bytes: [9, 9] }]);

  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.ok(!(await sessionNames(page)).includes('Recorded call.'));
  await openSession(page, 'Quarterly review', 320);
  assert.deepEqual(errors, []);
  await close();
});
