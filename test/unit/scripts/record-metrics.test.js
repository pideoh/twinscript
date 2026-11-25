import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAILY_HEADER,
  mergeDaily,
  mergeReferrers,
  mergeSnapshot,
  REFERRER_HEADER,
  SNAPSHOT_HEADER,
  totalDownloads,
} from '../../../scripts/record-metrics.mjs';

const at = (date, count, uniques) => ({ timestamp: `${date}T00:00:00Z`, count, uniques });

test('days are kept after GitHub has dropped them, and a day seen again takes the newer figures', () => {
  const first = mergeDaily('', [at('2026-11-01', 5, 2), at('2026-11-02', 3, 1)], [at('2026-11-02', 7, 4)]);
  assert.equal(first, `${DAILY_HEADER}\n2026-11-01,5,2,0,0\n2026-11-02,3,1,7,4\n`);
  const later = mergeDaily(first, [at('2026-11-02', 9, 3), at('2026-11-16', 1, 1)], []);
  assert.equal(later, `${DAILY_HEADER}\n2026-11-01,5,2,0,0\n2026-11-02,9,3,7,4\n2026-11-16,1,1,0,0\n`);
});

test('a file with Windows line endings is read the same way', () => {
  const csv = `${DAILY_HEADER}\r\n2026-11-01,5,2,0,0\r\n`;
  assert.equal(mergeDaily(csv), `${DAILY_HEADER}\n2026-11-01,5,2,0,0\n`);
});

test('a second run on the same day replaces that day, and earlier days stay', () => {
  const totals = { stars: 1, forks: 0, watchers: 2, downloads: 10 };
  const one = mergeSnapshot('', '2026-11-20', totals);
  const two = mergeSnapshot(one, '2026-11-27', { ...totals, downloads: 15 });
  const again = mergeSnapshot(two, '2026-11-27', { ...totals, downloads: 16 });
  assert.equal(again, `${SNAPSHOT_HEADER}\n2026-11-20,1,0,2,10\n2026-11-27,1,0,2,16\n`);
});

test('referrers are recorded per run; a name that is not a site name is recorded as "other"', () => {
  const csv = mergeReferrers('', '2026-11-27', [
    { referrer: 'zenn.dev', count: 9, uniques: 4 },
    { referrer: '=cmd,"x"', count: 1, uniques: 1 },
  ]);
  assert.equal(csv, `${REFERRER_HEADER}\n2026-11-27,zenn.dev,9,4\n2026-11-27,other,1,1\n`);
  assert.equal(mergeReferrers(csv, '2026-11-27', []), `${REFERRER_HEADER}\n`);
});

test('figures that are not counts, and days that are not dates, do not reach the file', () => {
  const csv = mergeDaily('', [at('2026-11-01', '5,9', -1), { timestamp: 'x\n1,1', count: 1, uniques: 1 }], []);
  assert.equal(csv, `${DAILY_HEADER}\n2026-11-01,0,0,0,0\n`);
});

test('downloads are counted over every file of every release', () => {
  const releases = [{ assets: [{ download_count: 3 }, { download_count: 4 }] }, { assets: [] }, {}];
  assert.equal(totalDownloads(releases), 7);
});
