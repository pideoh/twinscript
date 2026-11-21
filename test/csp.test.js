import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
const directives = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));

test('the page declares a content security policy before any script', () => {
  assert.ok(policy, 'no policy found');
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy must come first');
});

test('nothing is allowed by default and no unsafe sources are used', () => {
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['style-src'], ["'self'"]);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(policy));
});

test('the page may only connect to the Gemini API', () => {
  assert.deepEqual(directives['connect-src'], [
    'https://generativelanguage.googleapis.com', 'wss://generativelanguage.googleapis.com',
  ]);
});
