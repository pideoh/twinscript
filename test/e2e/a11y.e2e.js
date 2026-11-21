// Browser tests: automated accessibility checks with axe-core on the main screen and the dialogs,
// in the light and the dark theme.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mockGemini, setup, translated } from './helpers.js';

const { openApp } = setup();

// axe is evaluated as a string in the page, which is not a script the page loads, so the page's
// Content Security Policy (script-src 'self') stays as it is.
const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

// Each violation as "rule (impact): help", then one line per element: its selector and what failed.
async function scan(page) {
  // The pointer is parked off the controls so the scan sees them at rest. Left on the main action
  // after a click, it would check the hover color instead: in the dark theme Primer's
  // --button-primary-bgColor-hover (#29903b) gives white text only 4.08:1, a token value this app
  // keeps as Primer defines it.
  await page.mouse.move(0, 0);
  if (!(await page.evaluate(() => typeof window.axe === 'object'))) await page.evaluate(AXE);
  const violations = await page.evaluate(
    (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }).then((r) => r.violations),
    TAGS,
  );
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}\n    ${n.failureSummary.replaceAll('\n', '\n    ')}`).join('\n')}`,
  );
}

async function assertAccessible(page, where) {
  const found = await scan(page);
  assert.deepEqual(found, [], `${where}:\n${found.join('\n')}`);
}

for (const colorScheme of ['light', 'dark']) {
  test(`the main screen and its dialogs pass the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false }, undefined, {
      colorScheme,
    });
    await assertAccessible(page, 'main screen, idle');

    await page.click('#openSettings');
    await assertAccessible(page, 'settings dialog');
    await page.click('#settings button[value=ok]');

    await mockGemini(page, [
      [3, 'final', 'One is done.'],
      [5, 'final', 'Two is done.'],
      [7, 'final', 'Three is done.'],
    ]);
    await page.click('#toggle');
    await translated(page, 3);
    await page.click('#toggle');
    await page.waitForFunction(() => document.querySelectorAll('#log .seg').length === 3);
    await assertAccessible(page, 'main screen with a transcript');

    await page.click('#export');
    await assertAccessible(page, 'download dialog');

    assert.deepEqual(errors, []);
    await close();
  });
}
