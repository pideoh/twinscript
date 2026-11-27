// Browser tests: automated accessibility checks with axe-core on the main screen and the dialogs,
// in the light and the dark theme.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  chooseAudioFile,
  fileRead,
  mockGemini,
  mockLineTranslation,
  mockQuestions,
  mockSpeakers,
  mockSummary,
  rebuildAnswer,
  seededAnswer,
  seedRecordedSession,
  setup,
  showTab,
  translated,
  updatesBridge,
  wavFile,
} from './helpers.js';

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
    await showTab(page, 'summary');
    await assertAccessible(page, 'Summary tab, nothing to summarize yet');
    await showTab(page, 'questions');
    await assertAccessible(page, 'Questions tab, nothing to ask about yet');
    await showTab(page, 'transcript');

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

    // The usage dialog with what the session used, and a translation model without a price.
    await page.click('#openUsage');
    await page.waitForSelector('#usageDialog[open]');
    await assertAccessible(page, 'usage dialog');
    await page.click('#usageDialog .dialog-footer button');

    // The Summary tab with a rendered summary (headings, lists, a table, a link) and its history.
    await showTab(page, 'summary');
    await mockSummary(page, () => ({
      body: [
        '## Overview',
        '',
        'All **three** items are *done*; see [the notes](https://example.com/notes) and `v2`.',
        '',
        '## Action items',
        '',
        '| Task | Owner | Due |',
        '| --- | --- | --- |',
        '| Write the report | Ana | Friday |',
        '',
        '1. First',
        '2. Second',
        '   - nested',
        '',
        '> A quote',
      ].join('\n'),
    }));
    await page.click('#summarize');
    await page.waitForFunction(() => document.querySelector('#summaryContent table'));
    await page.selectOption('#summaryTemplate', 'preset:minutes');
    await page.click('#summarize');
    await page.waitForFunction(() => document.querySelectorAll('#summaryHistory option').length === 2);
    await assertAccessible(page, 'Summary tab with summaries');

    // The Questions tab with an answer (Markdown, a cited time as a link) and a failed question.
    await showTab(page, 'questions');
    const answers = [
      { body: 'All **three** are done [00:00:00].\n\n- See `v2` and [the notes](https://example.com/notes).' },
      { status: 500, body: { error: { message: 'Internal error' } } },
    ];
    await mockQuestions(page, () => answers.shift());
    await page.fill('#question', 'What is done?');
    await page.click('#ask');
    await page.waitForSelector('#questionsList .time-link');
    await page.fill('#question', 'Who did it?');
    await page.click('#ask');
    await page.waitForSelector('#questionsList .turn-error');
    await assertAccessible(page, 'Questions tab with turns');

    // The summary templates in the settings dialog, with the editor open.
    await page.click('#openSettings');
    await page.click('#templateNew');
    await page.fill('#templateName', 'Board');
    await page.fill('#templatePrompt', '## Resolutions');
    await page.click('#templateSave');
    await page.waitForSelector('#templateStatus:not([hidden])');
    await page.click('#templateList button[aria-label="「Board」を編集"]');
    await page.fill('#templatePrompt', '');
    await page.click('#templateSave');
    await page.waitForSelector('#templateError:not([hidden])');
    await assertAccessible(page, 'template editor');
    await page.click('#templateCancel');

    // The prices for estimates, with a model that has no price and a value that is not a price.
    await page.fill('#translateModel', 'my-model');
    await page.dispatchEvent('#translateModel', 'change');
    await page.fill('#priceFields input[data-model="my-model"][data-field="input"]', 'abc');
    await page.waitForSelector('#pricesError:not([hidden])');
    await assertAccessible(page, 'prices for estimates');
    await page.fill('#translateModel', 'gemini-3.5-flash-lite');
    await page.click('#settings button[value=ok]');

    await page.click('#export');
    await assertAccessible(page, 'download dialog');

    assert.deepEqual(errors, []);
    await close();
  });

  test(`speaker labels, their progress and their editor pass the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key' }, undefined, { colorScheme });
    await seedRecordedSession(page);
    page.on('dialog', (dialog) => dialog.accept());
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    await mockSpeakers(page, {
      analyze: async () => {
        await held;
        return { body: seededAnswer() };
      },
    });
    await assertAccessible(page, 'a recorded session, before labelling');
    await page.click('#labelSpeakers');
    await page.waitForSelector('#cancelSpeakers:not([hidden])');
    await assertAccessible(page, 'speaker labelling in progress');
    release();
    await page.waitForSelector('#editSpeakers:not([hidden])');
    // One line without a speaker, whose slot is a button too.
    await page.click('#log .seg >> nth=0 >> .speaker');
    await page.selectOption('#speakerLineSelect', '');
    await assertAccessible(page, 'speaker editor, opened from a line');
    await page.click('#speakerSave');
    await page.waitForSelector('#log .seg .speaker.none');
    await assertAccessible(page, 'transcript with speaker labels');
    await page.click('#editSpeakers');
    await page.waitForSelector('#speakerDialog[open]');
    await assertAccessible(page, 'speaker editor');
    assert.deepEqual(errors, []);
    await close();
  });

  test(`rebuilding a transcript, its confirmation, its progress and restoring pass the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key' }, undefined, { colorScheme });
    await seedRecordedSession(page);
    page.on('dialog', (dialog) => dialog.accept());
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    await mockSpeakers(page, {
      analyze: async () => {
        await held;
        return { body: rebuildAnswer() };
      },
    });
    await mockLineTranslation(page);
    await assertAccessible(page, 'a recorded session, with the action to rebuild its transcript');
    await page.click('#rebuild');
    await page.waitForSelector('#rebuildDialog[open]');
    await assertAccessible(page, 'the confirmation of a rebuild');
    await page.click('#rebuildConfirm');
    await page.waitForSelector('#cancelRebuild:not([hidden])');
    await assertAccessible(page, 'a rebuild in progress');
    release();
    await page.waitForSelector('#restoreTranscript:not([hidden])');
    await assertAccessible(page, 'a rebuilt transcript, with the action to restore the one made while listening');
    assert.deepEqual(errors, []);
    await close();
  });

  test(`importing an audio file, its dialog, its progress and its errors pass the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key' }, undefined, { colorScheme });
    let release;
    const held = new Promise((r) => {
      release = r;
    });
    await mockSpeakers(page, {
      analyze: async () => {
        await held;
        return { status: 403, body: { error: { code: 403, message: 'Permission denied' } } };
      },
    });
    await chooseAudioFile(page, wavFile());
    await fileRead(page);
    await assertAccessible(page, 'the dialog for an audio file');
    await page.click('#importConfirm');
    await page.waitForFunction(() => document.getElementById('importStatus').textContent.includes('1/1'));
    await assertAccessible(page, 'an import in progress');
    release();
    await page.waitForSelector('#importError:not([hidden])');
    await assertAccessible(page, 'an import that failed');
    await page.click('#importCancel');
    await chooseAudioFile(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('#importError:not([hidden])');
    await assertAccessible(page, 'a file that is not audio');
    assert.deepEqual(errors, []);
    await close();
  });

  test(`the desktop app's notice of a newer version and its setting pass the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp('', {}, updatesBridge(), { colorScheme });
    await page.waitForSelector('#updateNotice:not([hidden])');
    await assertAccessible(page, 'main screen with the notice of a newer version');
    await page.click('#openSettings');
    await assertAccessible(page, 'settings dialog in the desktop app');
    await page.click('#settings button[value=ok]');
    assert.deepEqual(errors, []);
    await close();
  });

  test(`a transcript in three languages passes the accessibility checks in the ${colorScheme} theme`, async () => {
    const { page, errors, close } = await openApp(
      '',
      { apiKey: 'test-key', langC: 'cmn-Hans-CN', interimInterval: 0.5 },
      undefined,
      { colorScheme },
    );
    await assertAccessible(page, 'main screen with a third language, idle');

    await page.click('#openSettings');
    await assertAccessible(page, 'settings dialog with a third language');
    await page.click('#settings button[value=ok]');

    await mockGemini(page, [
      [3, 'final', 'One is done.'],
      [5, 'final', 'それでは会議を始めます。'],
      [7, 'interim', '我们这一代人要为'],
    ]);
    await page.click('#toggle');
    // Two finished rows with two translations each, and one in progress in the caption zone.
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.seg:not(.live) .tgt-line').length === 4 &&
        document.querySelectorAll('.seg.live .tgt-line.pending').length === 2,
    );
    await assertAccessible(page, 'caption zone with a third language');
    await page.click('#toggle');
    // The sentence in progress is kept as a finished one when listening stops.
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#log .seg').length === 3 &&
        document.querySelectorAll('#log .tgt-line:not(.pending)').length === 6,
    );
    await assertAccessible(page, 'main screen with a transcript in three languages');

    assert.deepEqual(errors, []);
    await close();
  });
}
