// The design rule from CLAUDE.md, enforced: colors come from the token block at the top of
// styles.css, and icons are SVG, not Unicode symbols.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
const END = '/* ======================= end of design tokens ======================= */';
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('styles.css has no literal colors outside the token block', async () => {
  const css = await read('styles.css');
  assert.ok(css.includes(END), 'the token block end marker is missing');
  const rest = withoutComments(css.slice(css.indexOf(END) + END.length));
  const literals = rest.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\([^)]*\)/g) ?? [];
  // The caption overlay's translucent backdrop is the one documented exception: Primer dark
  // bgColor-default at the opacity chosen in the settings. (The match ends at the first ")".)
  const unexpected = literals.filter(
    (value) => value.replace(/\s/g, '') !== 'rgba(13,17,23,var(--caption-bg-alpha,0.9)',
  );
  assert.deepEqual(unexpected, []);
});

test('every custom property used in styles.css is defined', async () => {
  const css = withoutComments(await read('styles.css'));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // Set from JavaScript at runtime (the user's text size, the caption overlay's opacity).
  defined.add('--fs');
  defined.add('--caption-bg-alpha');
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...used].filter((name) => !defined.has(name)),
    [],
  );
});

test('the page uses no Unicode symbols as icons', async () => {
  const html = await read('index.html');
  const symbols = html.match(/[←-⇿⌀-⏿─-➿⤀-⯿＋]/g) ?? [];
  assert.deepEqual(symbols, []);
});
