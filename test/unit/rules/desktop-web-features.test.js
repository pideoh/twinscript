// The interface runs both in a browser and in the desktop app (Electron), so the page uses no web
// feature that the desktop app does not have or that behaves there in a way the page cannot rely on
// (principle 7 in docs/principles.md: a rule that matters is a check). Each banned feature has the
// source that says so and what to use instead.
//
// A scanner of source text, not a parser (test/support/source-text.js says what it cannot read): it
// finds a call or a name written in the code, not one built at run time. Comments are ignored; for
// an event name, strings are read too, since that is where the name is written.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codeOnly, stripComments } from '../../support/source-text.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// what: what is banned; in: 'code' (identifiers, outside strings) or 'text' (strings included);
// pattern; why, source: the reason and where it is stated; instead: what to use.
const BANNED = [
  {
    what: 'window.prompt()',
    in: 'code',
    pattern: /(?<![\w$.])prompt\s*\(|\b(?:window|globalThis|self)\s*\.\s*prompt\b/,
    why: 'Electron does not implement window.prompt(): in the desktop app no question is shown, so nothing can be typed. The Electron documentation does not list it; its maintainers say so in the issue.',
    source: 'https://github.com/electron/electron/issues/472',
    instead: 'ask in the page: a field in place (as src/ui/sidebar.js renames a session) or a <dialog>',
  },
  {
    what: 'a beforeunload handler',
    in: 'text',
    pattern: /beforeunload/,
    why: 'In Electron, a beforeunload handler that returns anything but undefined (or sets event.returnValue) cancels closing the window silently, and the handler also runs on reload: no "Leave site?" question is shown, so the window does not close.',
    source: 'https://www.electronjs.org/docs/latest/api/browser-window#event-close',
    instead:
      'keep the work safe without asking (save as it changes, as src/session/session-save.js does), or ask in the main process (app/) with the dialog module',
  },
  {
    what: 'document.requestStorageAccessFor()',
    in: 'code',
    pattern: /\brequestStorageAccessFor\b/,
    why: 'Disabled by default since Electron 45 and removed in Electron 46.',
    source:
      'https://www.electronjs.org/docs/latest/breaking-changes#default-changed-documentrequeststorageaccessfor-is-disabled',
    instead: 'nothing: the app is served from its own origin and needs no storage access of another site',
  },
];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

// Every script the page runs, and the page.
async function pageFiles() {
  const scripts = (await walk(join(ROOT, 'src'))).filter((f) => /\.m?js$/.test(f));
  return [...scripts, join(ROOT, 'index.html')].sort();
}

// The text a rule reads: comments removed; for 'code', string contents too.
function readable(file, source, where) {
  if (file.endsWith('.html')) {
    const html = source.replace(/<!--[\s\S]*?-->/g, ' ');
    // In the page, code is in its tags and attributes, not in the text between them.
    return where === 'code' ? html.replace(/>[^<]*</g, '><') : html;
  }
  return where === 'code' ? codeOnly(source) : stripComments(source);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function findings(file, source) {
  const out = [];
  for (const rule of BANNED) {
    const text = readable(file, source, rule.in);
    const match = rule.pattern.exec(text);
    if (match) out.push({ rule, line: lineOf(text, match.index), found: match[0] });
  }
  return out;
}

test('every banned feature says why, where that is stated and what to use instead', () => {
  for (const rule of BANNED) {
    for (const field of ['what', 'why', 'source', 'instead'])
      assert.ok(rule[field], `${rule.what}: ${field} is missing`);
    assert.match(rule.source, /^https:\/\/(www\.electronjs\.org\/docs\/|github\.com\/electron\/electron\/)/);
  }
});

test('the checks find the banned features and leave what works alone', () => {
  const found = (code, file = 'x.js') => findings(file, code).map((f) => f.rule.what);
  assert.deepEqual(found('const name = prompt(t("x"), title);'), ['window.prompt()']);
  assert.deepEqual(found('window.prompt("x")'), ['window.prompt()']);
  assert.deepEqual(found('globalThis . prompt'), ['window.prompt()']);
  assert.deepEqual(found("addEventListener('beforeunload', warn);"), ['a beforeunload handler']);
  assert.deepEqual(found('window.onbeforeunload = warn;'), ['a beforeunload handler']);
  assert.deepEqual(found('document.requestStorageAccessFor(origin)'), ['document.requestStorageAccessFor()']);
  assert.deepEqual(found('<body onbeforeunload="return 1">', 'page.html'), ['a beforeunload handler']);
  // What works in the desktop app, and names that only look alike.
  assert.deepEqual(
    found(
      [
        'if (confirm(t("session.deleteConfirm"))) alert("x");',
        "input.setAttribute('aria-label', t('session.renamePrompt'));",
        'const reply = await model.prompt(question);',
        'function buildPrompt(text) {}',
        'const text = "Write a prompt(short) here";',
        '// prompt() and beforeunload are named in this comment only',
        "addEventListener('pagehide', save);",
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(found('<p>Type a prompt(here)</p><!-- onbeforeunload -->', 'page.html'), []);
});

test('the page uses no web feature that the desktop app does not have', async () => {
  const files = await pageFiles();
  assert.ok(
    files.some((f) => f.endsWith(`${sep}index.html`)) && files.length > 50,
    'all of src/ and index.html are read',
  );
  const problems = [];
  for (const file of files) {
    for (const { rule, line, found } of findings(file, await readFile(file, 'utf8'))) {
      const at = `${relative(ROOT, file).split(sep).join('/')}:${line}`;
      problems.push(`${at}: ${found.trim()}: ${rule.what}. ${rule.why} (${rule.source}) Use instead: ${rule.instead}.`);
    }
  }
  assert.deepEqual(problems, []);
});
