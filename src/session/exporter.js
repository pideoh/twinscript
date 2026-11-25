// Builds downloadable transcripts. Pure functions: no DOM, no storage.
import { nestHeadings } from './markdown.js';

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export function formatDateTime(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const oneLine = (text) => (text || '').replace(/\s*\n\s*/g, ' ').trim();

function srtTime(ms) {
  return `${formatElapsed(ms).replace(/^(\d+)/, (h) => pad(h))},${pad(Math.floor(ms % 1000), 3)}`;
}

// Words used in the header and the Markdown table; the app passes them in the UI language.
// CSV column ids are machine-readable and stay English.
export const DEFAULT_LABELS = {
  title: 'Transcript',
  date: 'Date',
  languages: 'Languages',
  duration: 'Duration',
  time: 'Time',
  source: 'Source',
  translation: 'Translation',
  speaker: 'Speaker',
  separator: '   ',
  // Summary section, written above the transcript in txt and md when a summary is passed in.
  transcript: 'Transcript',
  summary: 'Summary',
  summaryTruncated: 'This summary covers only part of a long transcript.',
};

// session: { title, createdAt, activeMs, langA, langB, segments: [{ elapsed, src, tgt, speaker? }] }
// `speaker` is the name of who said a segment (speaker labels). When any row has one, each format
// carries it: txt and srt put "Name: " before the text, md and csv get a speaker column after the
// time. Without names the files are exactly as before speakers existed.
// options: { format: 'txt' | 'md' | 'csv' | 'srt', content: 'both' | 'src' | 'tgt', langLabel(code), labels,
//   summary: { markdown, title, truncated } }
// The summary (Markdown; `title` is the name of its template), when given, opens txt and md files,
// as it was written in txt and with its headings under the file's own in md; csv and srt never
// include it.
// Returns { text, ext, mime }.
export function buildTranscript(
  session,
  { format = 'txt', content = 'both', langLabel = (c) => c, labels, summary } = {},
) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const rows = session.segments
    .map((seg) => ({
      time: seg.elapsed || 0,
      speaker: oneLine(seg.speaker),
      src: oneLine(seg.src),
      tgt: oneLine(seg.tgt),
    }))
    .filter((r) => (content === 'tgt' ? r.tgt : r.src));
  const named = rows.some((r) => r.speaker);
  const who = (r) => (r.speaker ? `${r.speaker}: ` : '');
  const lines = (r) => (content === 'src' ? [r.src] : content === 'tgt' ? [r.tgt] : [r.src, r.tgt].filter(Boolean));
  const title = session.title || L.title;
  const meta = [
    `${L.date}: ${formatDateTime(session.createdAt)}`,
    `${L.languages}: ${langLabel(session.langA)} ⇄ ${langLabel(session.langB)}`,
    `${L.duration}: ${formatElapsed(session.activeMs || rows.at(-1)?.time || 0)}`,
  ];
  const summaryText = summary?.markdown?.trim() ?? '';
  const summaryHeading = summary?.title ? `${L.summary}: ${oneLine(summary.title)}` : L.summary;
  const note = summary?.truncated ? [L.summaryTruncated, ''] : [];

  if (format === 'md') {
    // Backslashes first, so a "\|" already in the text cannot end the cell.
    const cell = (t) => t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    const head = [
      L.time,
      ...(named ? [L.speaker] : []),
      ...(content === 'both' ? [L.source, L.translation] : [content === 'src' ? L.source : L.translation]),
    ];
    const body = rows.map((r) => {
      const cells = [...(named ? [r.speaker] : []), ...(content === 'both' ? [r.src, r.tgt] : lines(r))];
      return `| ${formatElapsed(r.time)} | ${cells.map(cell).join(' | ')} |`;
    });
    const summaryPart = summaryText
      ? [`## ${summaryHeading}`, '', ...note, nestHeadings(summaryText, 3), '', `## ${L.transcript}`, '']
      : [];
    const text = [
      `# ${title}`,
      '',
      meta.join(' / '),
      '',
      ...summaryPart,
      `| ${head.join(' | ')} |`,
      `|${head.map(() => ' --- ').join('|')}|`,
      ...body,
      '',
    ].join('\n');
    return { text, ext: 'md', mime: 'text/markdown' };
  }

  if (format === 'csv') {
    const quote = (t) => `"${t.replace(/"/g, '""')}"`;
    const head = [
      'time',
      ...(named ? ['speaker'] : []),
      ...(content === 'both' ? ['source', 'translation'] : [content === 'src' ? 'source' : 'translation']),
    ];
    const body = rows.map((r) => {
      const cells = [...(named ? [r.speaker] : []), ...(content === 'both' ? [r.src, r.tgt] : lines(r))];
      return [formatElapsed(r.time), ...cells.map(quote)].join(',');
    });
    // BOM so that Excel opens it as UTF-8.
    return { text: `﻿${[head.join(','), ...body].join('\r\n')}\r\n`, ext: 'csv', mime: 'text/csv' };
  }

  if (format === 'srt') {
    const blocks = rows.map((r, i) => {
      const next = rows[i + 1]?.time ?? Infinity;
      const end = Math.max(r.time + 500, Math.min(next, r.time + 8000));
      const [first, ...rest] = lines(r);
      return `${i + 1}\n${srtTime(r.time)} --> ${srtTime(end)}\n${[`${who(r)}${first}`, ...rest].join('\n')}\n`;
    });
    return { text: blocks.join('\n'), ext: 'srt', mime: 'application/x-subrip' };
  }

  // Plain text: the timestamp on the first line, the translation aligned underneath.
  const indent = ' '.repeat('[00:00:00] '.length);
  const body = rows.map((r) => {
    const [first, ...rest] = lines(r);
    return [`[${formatElapsed(r.time)}] ${who(r)}${first}`, ...rest.map((t) => `${indent}→ ${t}`)].join('\n');
  });
  const summaryPart = summaryText ? [summaryHeading, '', ...note, summaryText, '', L.transcript, ''] : [];
  const text = [
    title,
    meta.join(L.separator),
    '',
    ...summaryPart,
    body.join(content === 'both' ? '\n\n' : '\n'),
    '',
  ].join('\n');
  return { text, ext: 'txt', mime: 'text/plain' };
}

export function safeFileName(title) {
  return (
    (title || 'transcript')
      .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
      .trim()
      .slice(0, 60) || 'transcript'
  );
}

// A session as plain data for a file: its fields as they are, and each segment with only what is
// saved of it (no elements or state of the screen). Optional fields of a segment (`lang`, `tgts`,
// `speaker`) are left out when it has none.
export const serializeSession = (sess) => ({
  ...sess,
  segments: sess.segments.map(({ id, at, elapsed, src, tgt, lang, tgts, speaker }) => ({
    id,
    at,
    elapsed,
    src,
    tgt,
    ...(lang && { lang }),
    ...(tgts && { tgts: tgts.map(({ lang, text }) => ({ lang, text })) }),
    ...(speaker && { speaker }),
  })),
});

// The session with names, not ids, as each segment's speaker: nameOf(id) gives the name, or ''
// for none (every segment of a session without labels gets '').
export const withSpeakerNames = (session, nameOf) => ({
  ...session,
  segments: session.segments.map((seg) => ({ ...seg, speaker: nameOf(seg.speaker) })),
});

// The words of a transcript file (see DEFAULT_LABELS) in the display language, from `t`.
export const transcriptLabels = (t) => ({
  ...Object.fromEntries(
    [
      'title',
      'date',
      'languages',
      'duration',
      'time',
      'speaker',
      'source',
      'translation',
      'separator',
      'transcript',
    ].map((k) => [k, t(`file.${k}`)]),
  ),
  summary: t('summary.title'),
  summaryTruncated: t('summary.truncated'),
});

// The file name of a session's recording: its title and its number (1-based `n`), with the
// extension of its type (MP4 audio is .m4a; everything else is WebM).
export const recordingFileName = (title, n, mime) =>
  `${safeFileName(title)}-${n}.${mime.includes('mp4') ? 'm4a' : 'webm'}`;
