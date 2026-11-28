import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressKey } from '../../../../src/ui/rebuild-panel.js';

test('the progress says which part is sent or transcribed, then which line is translated', () => {
  assert.equal(progressKey({ step: 'upload', part: 1, parts: 2 }), 'speakers.uploading');
  assert.equal(progressKey({ step: 'analyze', part: 1, parts: 2 }), 'rebuild.transcribing');
  assert.equal(progressKey({ step: 'punctuate', done: 1, total: 3 }), 'rebuild.punctuating');
  assert.equal(progressKey({ step: 'translate', done: 3, total: 9 }), 'rebuild.translating');
});
