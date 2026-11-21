// Builds downloadable transcripts. Pure functions: no DOM, no storage.

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
  separator: '   ',
};

// session: { title, createdAt, activeMs, langA, langB, segments: [{ elapsed, src, tgt }] }
// options: { format: 'txt' | 'md' | 'csv' | 'srt', content: 'both' | 'src' | 'tgt', langLabel(code), labels }
// Returns { text, ext, mime }.
export function buildTranscript(session, { format = 'txt', content = 'both', langLabel = (c) => c, labels } = {}) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const rows = session.segments
    .map((seg) => ({ time: seg.elapsed || 0, src: oneLine(seg.src), tgt: oneLine(seg.tgt) }))
    .filter((r) => (content === 'tgt' ? r.tgt : r.src));
  const lines = (r) => (content === 'src' ? [r.src] : content === 'tgt' ? [r.tgt] : [r.src, r.tgt].filter(Boolean));
  const title = session.title || L.title;
  const meta = [
    `${L.date}: ${formatDateTime(session.createdAt)}`,
    `${L.languages}: ${langLabel(session.langA)} ⇄ ${langLabel(session.langB)}`,
    `${L.duration}: ${formatElapsed(session.activeMs || rows.at(-1)?.time || 0)}`,
  ];

  if (format === 'md') {
    // Backslashes first, so a "\|" already in the text cannot end the cell.
    const cell = (t) => t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    const head =
      content === 'both' ? [L.time, L.source, L.translation] : [L.time, content === 'src' ? L.source : L.translation];
    const body = rows.map((r) => {
      const cells = content === 'both' ? [r.src, r.tgt] : lines(r);
      return `| ${formatElapsed(r.time)} | ${cells.map(cell).join(' | ')} |`;
    });
    const text = [
      `# ${title}`,
      '',
      meta.join(' / '),
      '',
      `| ${head.join(' | ')} |`,
      `|${head.map(() => ' --- ').join('|')}|`,
      ...body,
      '',
    ].join('\n');
    return { text, ext: 'md', mime: 'text/markdown' };
  }

  if (format === 'csv') {
    const quote = (t) => `"${t.replace(/"/g, '""')}"`;
    const head =
      content === 'both' ? ['time', 'source', 'translation'] : ['time', content === 'src' ? 'source' : 'translation'];
    const body = rows.map((r) => {
      const cells = content === 'both' ? [r.src, r.tgt] : lines(r);
      return [formatElapsed(r.time), ...cells.map(quote)].join(',');
    });
    // BOM so that Excel opens it as UTF-8.
    return { text: `﻿${[head.join(','), ...body].join('\r\n')}\r\n`, ext: 'csv', mime: 'text/csv' };
  }

  if (format === 'srt') {
    const blocks = rows.map((r, i) => {
      const next = rows[i + 1]?.time ?? Infinity;
      const end = Math.max(r.time + 500, Math.min(next, r.time + 8000));
      return `${i + 1}\n${srtTime(r.time)} --> ${srtTime(end)}\n${lines(r).join('\n')}\n`;
    });
    return { text: blocks.join('\n'), ext: 'srt', mime: 'application/x-subrip' };
  }

  // Plain text: the timestamp on the first line, the translation aligned underneath.
  const indent = ' '.repeat('[00:00:00] '.length);
  const body = rows.map((r) => {
    const [first, ...rest] = lines(r);
    return [`[${formatElapsed(r.time)}] ${first}`, ...rest.map((t) => `${indent}→ ${t}`)].join('\n');
  });
  const text = [title, meta.join(L.separator), '', body.join(content === 'both' ? '\n\n' : '\n'), ''].join('\n');
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
