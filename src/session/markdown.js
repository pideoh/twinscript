// A small Markdown reader for summaries written by the model. DOM-free.
//
// Supported: ATX headings (#), paragraphs, bullet and numbered lists (nested by indentation),
// tables with a delimiter row, block quotes, fenced code blocks, horizontal rules, and inline
// **bold**, *italic*, `code` and [links](url). Everything else, raw HTML included, is text.
// Links are shown as their text followed by the address; only an http(s) address becomes an
// anchor, and it opens outside the app (target="_blank").
//
// parseMarkdown(text) returns a tree; toHtml(tree) turns it into HTML in which every piece of the
// input is escaped. The output only ever contains the tags and attributes written below.

const MAX_INPUT = 200_000; // characters read; the rest is dropped
const MAX_NESTING = 4; // lists, quotes and inline emphasis deeper than this are flattened
const MAX_COLUMNS = 20;

// ---------- inline ----------

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isSpace = (c) => c === undefined || /\s/.test(c);

// An http(s) address as written, or null.
export function safeUrl(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^<(.*)>$/, '$1');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused
  if (!text || /[\s\u0000-\u001f\u007f]/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

// Inline nodes: { type: 'text', text } | { type: 'code', text } | { type: 'strong' | 'em', children }
// | { type: 'link', children, url, href } where href is null unless the url is http(s).
export function parseInline(text, depth = 0) {
  const nodes = [];
  let plain = '';
  const flush = () => {
    if (plain) nodes.push({ type: 'text', text: plain });
    plain = '';
  };
  // A delimiter that has no closing match after some position has none after any later one, so a
  // failed search is remembered: long runs of unmatched markers stay linear.
  const missing = new Map();
  const find = (needle, from) => {
    if ((missing.get(needle) ?? Infinity) <= from) return -1;
    const at = text.indexOf(needle, from);
    if (at < 0) missing.set(needle, from);
    return at;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = find(fence, i + run);
      if (end >= 0) {
        flush();
        nodes.push({ type: 'code', text: text.slice(i + run, end).replace(/^ (.+) $/, '$1') });
        i = end + run;
      } else {
        plain += fence;
        i += run;
      }
      continue;
    }
    if ((c === '*' || c === '_') && depth < MAX_NESTING) {
      const strong = text[i + 1] === c;
      const marker = strong ? c + c : c;
      const start = i + marker.length;
      // Opens only before text, and "_" not inside a word (snake_case stays as it is).
      const opens = !isSpace(text[start]) && !(c === '_' && /\w/.test(text[i - 1] ?? ''));
      const end = opens ? find(marker, start + 1) : -1;
      const inner = end >= 0 ? text.slice(start, end) : '';
      const closes = end >= 0 && !isSpace(text[end - 1]) && !(c === '_' && /\w/.test(text[end + marker.length] ?? ''));
      if (closes && inner) {
        flush();
        nodes.push({ type: strong ? 'strong' : 'em', children: parseInline(inner, depth + 1) });
        i = end + marker.length;
      } else {
        plain += marker;
        i += marker.length;
      }
      continue;
    }
    if (c === '[' && depth < MAX_NESTING) {
      const mid = find('](', i + 1);
      const close = mid >= 0 ? find(')', mid + 2) : -1;
      const label = mid >= 0 ? text.slice(i + 1, mid) : '';
      if (close >= 0 && label && !label.includes('[') && !label.includes(']')) {
        flush();
        const url = text.slice(mid + 2, close).trim();
        nodes.push({ type: 'link', children: parseInline(label, depth + 1), url, href: safeUrl(url) });
        i = close + 1;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return nodes;
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (line) => !line.trim();
const width = (indent) => indent.replace(/\t/g, '    ').length;

// Cells of a table row, split at "|" that is neither escaped nor inside `code`.
function cells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const out = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cell += c;
    } else if (c === '|' && !code) {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out.slice(0, MAX_COLUMNS);
}

const startsBlock = (line, next) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  ITEM.test(line) ||
  QUOTE.test(line) ||
  (line.includes('|') && next !== undefined && DELIMITER_ROW.test(next) && next.includes('-'));

// Reads the list that starts at lines[i]; returns [node, next index].
function readList(lines, i, depth) {
  const first = ITEM.exec(lines[i]);
  const indent = width(first[1]);
  const ordered = /\d/.test(first[2]);
  const list = { type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m) {
      if (blank(lines[i])) {
        // A blank line ends the list unless an item of this list follows.
        let j = i + 1;
        while (j < lines.length && blank(lines[j])) j++;
        const next = ITEM.exec(lines[j] ?? '');
        if (next && width(next[1]) >= indent) {
          i = j;
          continue;
        }
        break;
      }
      // A line that starts no other block continues the item above.
      if (startsBlock(lines[i], lines[i + 1]) || !list.items.length) break;
      list.items.at(-1).text += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    const level = width(m[1]);
    if (level < indent) break;
    if (level > indent && list.items.length) {
      if (depth + 1 < MAX_NESTING) {
        const [sub, next] = readList(lines, i, depth + 1);
        list.items.at(-1).lists.push(sub);
        i = next;
      } else {
        list.items.push({ text: m[3], lists: [] }); // too deep: kept at this level
        i++;
      }
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break; // a different kind of list starts here
    list.items.push({ text: m[3], lists: [] });
    i++;
  }
  for (const item of list.items) {
    item.children = parseInline(item.text.trim());
    delete item.text;
  }
  return [list, i];
}

// Blocks: { type: 'heading', level, children } | { type: 'paragraph', children }
// | { type: 'list', ordered, start, items: [{ children, lists }] }
// | { type: 'table', align: ('left' | 'center' | 'right' | null)[], head: inline[][], rows: inline[][][] }
// | { type: 'quote', children: blocks } | { type: 'code', text } | { type: 'rule' }
export function parseMarkdown(source, depth = 0) {
  const lines = String(source ?? '')
    .slice(0, MAX_INPUT)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      const closing = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      i++;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or past the end when it was never closed
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      i++;
      if (!heading[2]?.trim()) continue; // an empty heading says nothing
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && !blank(lines[i])) {
        const m = QUOTE.exec(lines[i]);
        inner.push(m ? m[1] : lines[i]);
        i++;
      }
      blocks.push(
        depth + 1 < MAX_NESTING
          ? { type: 'quote', children: parseMarkdown(inner.join('\n'), depth + 1) }
          : { type: 'paragraph', children: parseInline(inner.join(' ')) },
      );
      continue;
    }
    if (ITEM.test(line)) {
      const [list, next] = readList(lines, i, depth);
      blocks.push(list);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1])
        .slice(0, head.length)
        .map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const row = cells(lines[i]).slice(0, head.length);
        while (row.length < head.length) row.push('');
        rows.push(row.map((c) => parseInline(c)));
        i++;
      }
      blocks.push({ type: 'table', align, head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && (!para.length || !startsBlock(lines[i], lines[i + 1])))
      para.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', children: parseInline(para.join(' ')) });
  }
  return blocks;
}

// ---------- HTML ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function inlineHtml(nodes) {
  return nodes
    .map((n) => {
      if (n.type === 'text') return escapeHtml(n.text);
      if (n.type === 'code') return `<code>${escapeHtml(n.text)}</code>`;
      if (n.type === 'strong') return `<strong>${inlineHtml(n.children)}</strong>`;
      if (n.type === 'em') return `<em>${inlineHtml(n.children)}</em>`;
      // A link: its text, then where it points, so the address is always visible.
      const address = n.href
        ? `<a href="${escapeHtml(n.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.url)}</a>`
        : escapeHtml(n.url);
      return `${inlineHtml(n.children)}${n.url ? ` (${address})` : ''}`;
    })
    .join('');
}

// headingLevel: the HTML level the document's top heading level becomes. Levels are made
// consecutive (a "####" right under a "#" becomes the next level down), as screen readers expect.
export function toHtml(blocks, { headingLevel = 1 } = {}) {
  const top = Math.min(7, ...collectHeadings(blocks));
  let previous = headingLevel - 1;
  const render = (list) =>
    list
      .map((b) => {
        switch (b.type) {
          case 'heading': {
            const level = Math.min(6, Math.max(headingLevel, Math.min(previous + 1, headingLevel + b.level - top)));
            previous = level;
            return `<h${level}>${inlineHtml(b.children)}</h${level}>`;
          }
          case 'paragraph':
            return `<p>${inlineHtml(b.children)}</p>`;
          case 'rule':
            return '<hr>';
          case 'code':
            return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
          case 'quote':
            return `<blockquote>${render(b.children)}</blockquote>`;
          case 'list': {
            const tag = b.ordered ? 'ol' : 'ul';
            const start = b.ordered && b.start !== 1 ? ` start="${Number(b.start) || 1}"` : '';
            const items = b.items.map((item) => `<li>${inlineHtml(item.children)}${render(item.lists)}</li>`);
            return `<${tag}${start}>${items.join('')}</${tag}>`;
          }
          case 'table': {
            const cls = (i) => (b.align[i] ? ` class="align-${b.align[i]}"` : '');
            const head = b.head.map((c, i) => `<th scope="col"${cls(i)}>${inlineHtml(c)}</th>`).join('');
            const rows = b.rows.map(
              (r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`,
            );
            return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
          }
          default:
            return '';
        }
      })
      .join('');
  return render(blocks);
}

function collectHeadings(blocks) {
  return blocks.flatMap((b) =>
    b.type === 'heading' ? [b.level] : b.type === 'quote' ? collectHeadings(b.children) : [],
  );
}

export const markdownToHtml = (text, options) => toHtml(parseMarkdown(text), options);

// Moves the ATX headings of `text` so that its top level becomes `top` (none deeper than 6),
// leaving code blocks alone. Used to put a summary under the headings of an exported file.
export function nestHeadings(text, top) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const HASHES = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
  let fence = null;
  const outside = lines.map((line) => {
    const f = FENCE.exec(line);
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()))) {
      fence = fence ? null : f[1];
      return false;
    }
    return !fence;
  });
  const levels = lines.flatMap((line, i) => (outside[i] && HASHES.test(line) ? [HASHES.exec(line)[2].length] : []));
  if (!levels.length) return lines.join('\n');
  const by = top - Math.min(...levels);
  return lines
    .map((line, i) =>
      outside[i]
        ? line.replace(HASHES, (_, sp, hashes) => sp + '#'.repeat(Math.max(1, Math.min(6, hashes.length + by))))
        : line,
    )
    .join('\n');
}
