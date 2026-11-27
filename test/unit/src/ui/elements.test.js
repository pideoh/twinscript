import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readElements, SESSION_CONTROLS } from '../../../../src/ui/elements.js';

const html = await readFile(new URL('../../../../index.html', import.meta.url), 'utf8');
const pageIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// A stand-in for the page's document: an element is its id.
const page = { getElementById: (id) => (pageIds.has(id) ? { id } : null) };

test('every element the app reaches is on the page, under its own id', () => {
  const els = readElements(page);
  const missing = Object.entries(els)
    .filter(([, el]) => el === null)
    .map(([key]) => key);
  assert.deepEqual(missing, []);
  for (const [key, el] of Object.entries(els)) assert.equal(el.id, key);
});

test('the controls held until a session is shown are elements the app reaches', () => {
  const els = readElements(page);
  assert.ok(SESSION_CONTROLS.length > 0);
  for (const id of SESSION_CONTROLS) assert.ok(els[id], id);
});

test('an element missing from the page reads as null rather than failing', () => {
  const els = readElements({ getElementById: () => null });
  assert.ok(Object.keys(els).length > 0);
  assert.ok(Object.values(els).every((el) => el === null));
});
