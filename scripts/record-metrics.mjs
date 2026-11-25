// Records the repository's traffic and download figures as CSV files, because GitHub keeps views and
// clones for 14 days only. Run by .github/workflows/metrics.yml once a week:
//
//   GH_TOKEN=... node scripts/record-metrics.mjs <directory> [owner/repo]
//
// daily.csv      one row per day: views and clones, and how many different people (rows already
//                there are replaced by newer figures for the same day, as the last day is partial)
// snapshots.csv  one row per run: stars, forks, watchers and release downloads so far
// referrers.csv  one row per run and site: where visitors of the last 14 days came from
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DAILY_HEADER = 'date,views,visitors,clones,cloners';
export const SNAPSHOT_HEADER = 'date,stars,forks,watchers,downloads';
export const REFERRER_HEADER = 'date,referrer,views,visitors';

const rowsOf = (csv) =>
  String(csv ?? '')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => line.split(','));
const toCsv = (header, rows) => `${[header, ...rows.map((r) => r.join(','))].join('\n')}\n`;
const day = (timestamp) => String(timestamp).slice(0, 10);
// A referrer is a site name from GitHub, but it ends up in a CSV file that people open in spreadsheets.
const cell = (text) =>
  String(text)
    .replace(/[",\r\n]/g, ' ')
    .replace(/^[=+\-@]/, "'$&");

// views, clones: the `views` and `clones` arrays of the traffic API ({ timestamp, count, uniques }).
export function mergeDaily(csv, views = [], clones = []) {
  const byDate = new Map(rowsOf(csv).map(([date, ...rest]) => [date, rest.map(Number)]));
  const at = (date) => byDate.get(date) ?? byDate.set(date, [0, 0, 0, 0]).get(date);
  for (const v of views) at(day(v.timestamp)).splice(0, 2, v.count, v.uniques);
  for (const c of clones) at(day(c.timestamp)).splice(2, 2, c.count, c.uniques);
  const rows = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, n]) => [date, ...n]);
  return toCsv(DAILY_HEADER, rows);
}

// One row per date: a second run on the same day replaces the first.
export function mergeSnapshot(csv, date, { stars, forks, watchers, downloads }) {
  const rows = rowsOf(csv).filter(([d]) => d !== date);
  rows.push([date, stars, forks, watchers, downloads]);
  return toCsv(
    SNAPSHOT_HEADER,
    rows.sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function mergeReferrers(csv, date, referrers = []) {
  const rows = rowsOf(csv).filter(([d]) => d !== date);
  for (const r of referrers) rows.push([date, cell(r.referrer), r.count, r.uniques]);
  return toCsv(REFERRER_HEADER, rows);
}

export const totalDownloads = (releases = []) =>
  releases.reduce((sum, release) => sum + (release.assets ?? []).reduce((n, a) => n + (a.download_count ?? 0), 0), 0);

async function main([dir, repo = process.env.GITHUB_REPOSITORY]) {
  const token = process.env.GH_TOKEN;
  if (!dir || !repo || !token) {
    console.error('Usage: GH_TOKEN=... node scripts/record-metrics.mjs <directory> [owner/repo]');
    process.exit(2);
  }
  const get = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const hint =
        res.status === 403 ? ' (traffic needs a token with read access to the repository administration)' : '';
      throw new Error(`GET ${path}: HTTP ${res.status}${hint}`);
    }
    return res.json();
  };
  const [views, clones, referrers, info, releases] = await Promise.all([
    get('/traffic/views'),
    get('/traffic/clones'),
    get('/traffic/popular/referrers'),
    get(''),
    get('/releases?per_page=100'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  const update = (name, merge) => {
    const file = join(dir, name);
    writeFileSync(file, merge(existsSync(file) ? readFileSync(file, 'utf8') : ''));
  };
  update('daily.csv', (csv) => mergeDaily(csv, views.views, clones.clones));
  update('snapshots.csv', (csv) =>
    mergeSnapshot(csv, today, {
      stars: info.stargazers_count,
      forks: info.forks_count,
      watchers: info.subscribers_count,
      downloads: totalDownloads(releases),
    }),
  );
  update('referrers.csv', (csv) => mergeReferrers(csv, today, referrers));
  console.log(`Recorded ${views.views.length} days of views and ${clones.clones.length} days of clones for ${today}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
