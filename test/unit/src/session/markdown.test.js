import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToHtml, nestHeadings, parseInline, parseMarkdown, safeUrl } from '../../../../src/session/markdown.js';

const html = (md, options) => markdownToHtml(md, options);
// Every tag the renderer may produce; anything else in its output would be a leak.
const ALLOWED_TAGS = new Set(
  'h1 h2 h3 h4 h5 h6 p ul ol li strong em code pre blockquote hr table thead tbody tr th td div a'.split(' '),
);
function assertSafe(out) {
  for (const [, tag] of out.matchAll(/<\/?([a-zA-Z0-9]+)/g))
    assert.ok(ALLOWED_TAGS.has(tag), `unexpected <${tag}> in ${out}`);
  // Attributes only of the renderer's own: href on anchors, target, rel, start, scope, class.
  for (const [, attrs] of out.matchAll(/<[a-z0-9]+((?:\s[^>]*)?)>/g)) {
    for (const [, name] of attrs.matchAll(/\s([a-zA-Z-]+)=/g))
      assert.ok(['href', 'target', 'rel', 'start', 'scope', 'class'].includes(name), `attribute ${name} in ${out}`);
  }
  for (const [, href] of out.matchAll(/href="([^"]*)"/g)) assert.match(href, /^https?:\/\//);
}

test('headings, paragraphs, lists, emphasis, code and tables become their HTML', () => {
  const md = [
    '# Title',
    '',
    'A paragraph with **bold**, *italic*, __also bold__, _also italic_ and `a <tag>`.',
    'Same paragraph.',
    '',
    '- one',
    '- two',
    '  - nested',
    '',
    '3. three',
    '4. four',
    '',
    '| Task | Owner | Due |',
    '| :--- | :---: | ---: |',
    '| Send `x` \\| y | **Ana** | Wed |',
    '| Short row |',
    '',
    '> quoted **text**',
    '',
    '---',
    '',
    '```js',
    'const a = "<b>";',
    '```',
  ].join('\n');
  assert.equal(
    html(md),
    [
      '<h1>Title</h1>',
      '<p>A paragraph with <strong>bold</strong>, <em>italic</em>, <strong>also bold</strong>, <em>also italic</em> and <code>a &lt;tag&gt;</code>. Same paragraph.</p>',
      '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
      '<ol start="3"><li>three</li><li>four</li></ol>',
      '<div class="table-wrap"><table><thead><tr><th scope="col">Task</th><th scope="col" class="align-center">Owner</th><th scope="col" class="align-right">Due</th></tr></thead>',
      '<tbody><tr><td>Send <code>x</code> | y</td><td class="align-center"><strong>Ana</strong></td><td class="align-right">Wed</td></tr>',
      '<tr><td>Short row</td><td class="align-center"></td><td class="align-right"></td></tr></tbody></table></div>',
      '<blockquote><p>quoted <strong>text</strong></p></blockquote>',
      '<hr>',
      '<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>',
    ].join(''),
  );
});

test('heading levels start where the page needs them and never skip one', () => {
  assert.equal(html('## A\n\n#### B\n\n## C', { headingLevel: 3 }), '<h3>A</h3><h4>B</h4><h3>C</h3>');
  assert.equal(html('# A\n\n### B', { headingLevel: 3 }), '<h3>A</h3><h4>B</h4>');
  assert.equal(html('###### deep', { headingLevel: 3 }), '<h3>deep</h3>');
  assert.equal(html('#\n\n#nospace'), '<p>#nospace</p>', 'an empty heading is left out; "#word" is text');
});

test('raw HTML is shown as text, never as markup', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<div onclick=alert(1)>hi</div>',
    '**<b onmouseover="x">bold</b>**',
    '<iframe src="https://example.com"></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '<!-- comment --><style>body{}</style>',
    '| <script>x</script> | b |\n| --- | --- |\n| <img src=x onerror=y> | c |',
    '- <script>\n- </script>',
    '`<script>`',
    '```\n<script>alert(1)</script>\n```',
    '> <script>alert(1)</script>',
    '"><script>alert(1)</script>',
    '\'"><img src=x onerror=alert(1)>',
  ];
  for (const md of cases) {
    const out = html(md);
    assertSafe(out);
    assert.ok(!/<(script|img|iframe|svg|style|div onclick)/i.test(out), `${md} -> ${out}`);
  }
  assert.equal(html('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(
    html('<img src=x onerror="alert(1)">'),
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
    'quotes are escaped, so nothing can break out of an attribute',
  );
});

test('links show their address; only http(s) addresses become anchors', () => {
  assert.equal(
    html('[docs](https://example.com/a?b=1&c="2")'),
    '<p>docs (<a href="https://example.com/a?b=1&amp;c=%222%22" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=&quot;2&quot;</a>)</p>',
  );
  for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example',
    '/relative',
  ]) {
    const out = html(`[click me](${url})`);
    assertSafe(out);
    assert.ok(!out.includes('<a'), `${url} -> ${out}`);
    assert.ok(out.startsWith('<p>click me ('), 'the text, then the address as text');
  }
  assert.equal(safeUrl('<https://example.com>'), 'https://example.com/');
  assert.equal(safeUrl('https://exa mple.com'), null);
  assert.equal(safeUrl('http://example.com\u0000'), null);
  assert.equal(
    html('[**bold** link](http://x.test)'),
    '<p><strong>bold</strong> link (<a href="http://x.test/" target="_blank" rel="noopener noreferrer">http://x.test</a>)</p>',
  );
  assert.equal(html('[not a link] (http://x.test)'), '<p>[not a link] (http://x.test)</p>');
});

test('nested and unclosed constructs end safely as text', () => {
  assert.equal(html('**bold *and italic* inside**'), '<p><strong>bold <em>and italic</em> inside</strong></p>');
  assert.equal(html('**never closed'), '<p>**never closed</p>');
  assert.equal(html('*never closed'), '<p>*never closed</p>');
  assert.equal(html('`never closed'), '<p>`never closed</p>');
  assert.equal(html('[never closed](http://x.test'), '<p>[never closed](http://x.test</p>');
  assert.equal(html('2 * 3 * 4 and snake_case_name'), '<p>2 * 3 * 4 and snake_case_name</p>');
  assert.equal(html('```\nunclosed code\n<b>'), '<pre><code>unclosed code\n&lt;b&gt;</code></pre>');
  assert.equal(html('\\*not italic\\* and \\<b\\>'), '<p>*not italic* and &lt;b&gt;</p>');
  // Deep nesting is flattened rather than recursed into without end.
  const deepQuote = `${'>'.repeat(50)} deep`;
  assertSafe(html(deepQuote));
  const deepList = Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
  const listOut = html(deepList);
  assertSafe(listOut);
  assert.ok((listOut.match(/<ul>/g) || []).length <= 4, 'at most four levels of lists');
  assert.ok(listOut.includes('level 29'), 'nothing is lost');
  const deepEmphasis = `${'**'.repeat(40)}x${'**'.repeat(40)}`;
  assertSafe(html(deepEmphasis));
  assert.equal(parseMarkdown('').length, 0);
  assert.equal(html(null), '');
});

test('very long and pathological lines are rendered quickly', () => {
  const inputs = [
    'a'.repeat(200_000),
    '*'.repeat(100_000),
    '**a'.repeat(30_000),
    '['.repeat(50_000),
    '[a]('.repeat(30_000),
    `${'`'.repeat(50_000)}x`,
    '| a '.repeat(10_000),
    `${'- x\n'.repeat(20_000)}`,
    '_a '.repeat(50_000),
  ];
  for (const input of inputs) {
    const started = performance.now();
    const out = html(input);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${input.slice(0, 10)}… took ${Math.round(ms)} ms`);
    assertSafe(out);
  }
});

test('tables keep at most the header width and a bounded number of columns', () => {
  const wide = `${'| h '.repeat(30)}|\n${'| - '.repeat(30)}|\n${'| c '.repeat(30)}|`;
  const out = html(wide);
  assert.equal((out.match(/<th /g) || []).length, 20);
  const [table] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 | 3 | 4 |');
  assert.equal(table.rows[0].length, 2, 'extra cells are dropped');
});

test('inline parsing yields text nodes for anything it does not support', () => {
  assert.deepEqual(parseInline('~~strike~~ ![img](http://x.test/i.png)'), [
    { type: 'text', text: '~~strike~~ !' },
    {
      type: 'link',
      children: [{ type: 'text', text: 'img' }],
      url: 'http://x.test/i.png',
      href: 'http://x.test/i.png',
    },
  ]);
});

test('exported summaries put their headings under the file’s own, code blocks untouched', () => {
  assert.equal(nestHeadings('## A\n\n### B\n\n```\n## code\n```', 3), '### A\n\n#### B\n\n```\n## code\n```');
  assert.equal(nestHeadings('# A\n###### B', 3), '### A\n###### B', 'never deeper than 6');
  assert.equal(nestHeadings('no headings', 3), 'no headings');
});
