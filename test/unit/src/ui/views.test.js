import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewAfter } from '../../../../src/ui/views.js';

const TWO = ['transcript', 'summary'];
const THREE = ['transcript', 'summary', 'ask'];
const key = (k) => ({ type: 'key', key: k });

test('opening a session or starting a run shows the transcript, whichever tab was open', () => {
  for (const current of TWO) {
    assert.equal(viewAfter(TWO, current, { type: 'opened' }), 'transcript');
    assert.equal(viewAfter(TWO, current, { type: 'started' }), 'transcript');
  }
});

test('pressing a tab shows it, also while another one is open; an unknown tab changes nothing', () => {
  assert.equal(viewAfter(TWO, 'transcript', { type: 'pressed', name: 'summary' }), 'summary');
  assert.equal(viewAfter(TWO, 'summary', { type: 'pressed', name: 'transcript' }), 'transcript');
  assert.equal(viewAfter(TWO, 'summary', { type: 'pressed', name: 'summary' }), 'summary');
  assert.equal(viewAfter(TWO, 'summary', { type: 'pressed', name: 'nope' }), null);
});

test('Right and Left move to the next and the previous tab, wrapping around at either end', () => {
  assert.equal(viewAfter(THREE, 'transcript', key('ArrowRight')), 'summary');
  assert.equal(viewAfter(THREE, 'summary', key('ArrowRight')), 'ask');
  assert.equal(viewAfter(THREE, 'ask', key('ArrowRight')), 'transcript');
  assert.equal(viewAfter(THREE, 'ask', key('ArrowLeft')), 'summary');
  assert.equal(viewAfter(THREE, 'transcript', key('ArrowLeft')), 'ask');
});

test('Home and End go to the first and the last tab', () => {
  assert.equal(viewAfter(THREE, 'summary', key('Home')), 'transcript');
  assert.equal(viewAfter(THREE, 'summary', key('End')), 'ask');
  assert.equal(viewAfter(TWO, 'transcript', key('End')), 'summary');
});

test('other keys, and up and down, are left to the page', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a'])
    assert.equal(viewAfter(TWO, 'summary', key(k)), null);
});

test('a shown tab that is not in the list counts as the first; no tabs at all show nothing', () => {
  assert.equal(viewAfter(TWO, 'gone', key('ArrowRight')), 'summary');
  assert.equal(viewAfter([], 'transcript', { type: 'opened' }), null);
  assert.equal(viewAfter(TWO, 'transcript', { type: 'other' }), null);
});
