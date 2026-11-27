// Browser tests: the tabs of the main area (Transcript, Summary, Questions), by mouse and by keyboard, which
// one is shown after opening a session and after starting, and what each tab holds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listening, mockGemini, seedRecordedSession, setup, shownTab, showTab, translated } from './helpers.js';

const { openApp } = setup();

// For each tab: its name, whether it is selected, its tabindex, and whether its panel is shown.
const tabState = (page) =>
  page.locator('[role="tab"]').evaluateAll((tabs) =>
    tabs.map((tab) => ({
      name: tab.dataset.view,
      selected: tab.getAttribute('aria-selected'),
      tabindex: tab.getAttribute('tabindex'),
      panel: !document.getElementById(tab.getAttribute('aria-controls')).hidden,
    })),
  );
const focused = (page) => page.evaluate(() => document.activeElement?.id);

async function finishedSession(page, text) {
  await mockGemini(page, [[3, 'final', text]]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
}

test('the tabs switch the panel by mouse; the caption zone and the main button stay outside them', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  assert.deepEqual(await page.locator('[role="tab"]').allTextContents(), ['文字起こし', '要約', '質問']);
  assert.equal(await page.getAttribute('[role="tablist"]', 'aria-label'), 'セッションの内容');
  assert.deepEqual(await tabState(page), [
    { name: 'transcript', selected: 'true', tabindex: '0', panel: true },
    { name: 'summary', selected: 'false', tabindex: '-1', panel: false },
    { name: 'questions', selected: 'false', tabindex: '-1', panel: false },
  ]);
  for (const tab of await page.locator('[role="tab"]').all()) {
    assert.ok((await tab.boundingBox()).height >= 32, 'a tab is at least 32px tall');
  }
  for (const panel of await page.locator('[role="tabpanel"]').all()) {
    const labelledBy = await panel.getAttribute('aria-labelledby');
    assert.equal(await page.getAttribute(`#${labelledBy}`, 'aria-controls'), await panel.getAttribute('id'));
  }

  await page.click('[role="tab"][data-view="summary"]');
  assert.deepEqual(await tabState(page), [
    { name: 'transcript', selected: 'false', tabindex: '-1', panel: false },
    { name: 'summary', selected: 'true', tabindex: '0', panel: true },
    { name: 'questions', selected: 'false', tabindex: '-1', panel: false },
  ]);
  assert.ok(await page.isVisible('.dock #toggle'), 'the main button is outside the tabs');
  assert.ok(await page.isVisible('header.bar'));
  await page.click('[role="tab"][data-view="transcript"]');
  assert.equal(await shownTab(page), 'transcript');
  assert.ok(await page.isVisible('#log'));
  assert.deepEqual(errors, []);
  await close();
});

test('the arrow keys, Home and End move between the tabs and select; Tab goes on to the panel', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await page.focus('[role="tab"][data-view="transcript"]');

  await page.keyboard.press('ArrowRight');
  assert.equal(await shownTab(page), 'summary');
  assert.equal(await focused(page), 'tabSummary');
  await page.keyboard.press('ArrowRight');
  assert.equal(await shownTab(page), 'questions');
  assert.equal(await focused(page), 'tabQuestions');
  await page.keyboard.press('ArrowRight');
  assert.equal(await shownTab(page), 'transcript', 'wraps around after the last tab');
  assert.equal(await focused(page), 'tabTranscript');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await shownTab(page), 'questions', 'and before the first');
  await page.keyboard.press('Home');
  assert.equal(await shownTab(page), 'transcript');
  await page.keyboard.press('End');
  assert.equal(await shownTab(page), 'questions');
  assert.equal(await focused(page), 'tabQuestions');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await shownTab(page), 'summary');
  assert.equal(await focused(page), 'tabSummary');

  // The next stop after the selected tab is its panel, not another tab.
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'summaryPanel');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focused(page), 'tabSummary', 'and back to the selected tab, the only stop in the list');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(outline, 'solid', 'a focused tab has a visible outline');
  assert.deepEqual(errors, []);
  await close();
});

test('starting shows the transcript; while listening the summary can be opened and left again', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await finishedSession(page, 'First part.');
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#summarize'));

  await mockGemini(page, [[3, 'final', 'Second part.']]);
  await page.click('#toggle');
  assert.equal(await shownTab(page), 'transcript', 'starting shows the transcript');
  await listening(page);
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#now'), 'the sentence being spoken stays in view');
  assert.equal(await page.getAttribute('#summarize', 'aria-disabled'), 'true', 'no summary while listening');
  await showTab(page, 'transcript');
  await translated(page, 2);
  await page.click('#toggle');
  assert.equal(await shownTab(page), 'transcript');
  assert.deepEqual(errors, []);
  await close();
});

test('opening a session or a new one shows its transcript', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await finishedSession(page, 'Kept for later.');
  await showTab(page, 'summary');
  await page.click('#newSession');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length === 0);
  assert.equal(await shownTab(page), 'transcript', 'a new session');

  await showTab(page, 'summary');
  await page.locator('#sessionList .session', { hasText: 'Kept for later.' }).locator('.open').click();
  await page.waitForFunction(() => document.querySelectorAll('#log .seg').length === 1);
  assert.equal(await shownTab(page), 'transcript', 'a saved session');
  assert.deepEqual(errors, []);
  await close();
});

test('the speaker tools sit above the transcript, in the Transcript tab', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  assert.ok(await page.isVisible('#transcriptPanel #speakerTools #labelSpeakers'));
  const tools = await page.locator('#speakerTools').boundingBox();
  const log = await page.locator('#log').boundingBox();
  assert.ok(tools.y + tools.height <= log.y, 'above the transcript');
  await showTab(page, 'summary');
  assert.ok(await page.isHidden('#labelSpeakers'), 'not in the Summary tab');
  assert.deepEqual(errors, []);
  await close();
});

test('with nothing to summarize, the Summary tab says so in place of the summary', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  assert.equal(await page.locator('[role="tab"]').count(), 3, 'the tabs are there before anything is said');
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#summaryEmpty'));
  assert.equal(await page.textContent('#summaryEmpty'), '文字起こしがまだありません');
  assert.ok(await page.isHidden('#summary'));

  await showTab(page, 'transcript');
  await finishedSession(page, 'Now there is something.');
  await showTab(page, 'summary');
  assert.ok(await page.isHidden('#summaryEmpty'));
  assert.ok(await page.isVisible('#summarize'));
  assert.deepEqual(errors, []);
  await close();
});

test('back in the transcript, lines added meanwhile are in view, or the reader is where they left it', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  const lines = Array.from({ length: 60 }, (_, i) => ({ elapsed: i * 1000, src: `Line ${i}.`, tgt: `行 ${i}` }));
  await seedRecordedSession(page, { lines });
  const below = () =>
    page.evaluate(() => {
      const log = document.getElementById('log');
      return log.scrollHeight - log.scrollTop - log.clientHeight;
    });

  // Scrolled up to re-read: it comes back there, with the way to the newest line.
  await page.evaluate(() => {
    document.getElementById('log').scrollTop = 0;
  });
  await page.waitForSelector('#jump:not([hidden])');
  await showTab(page, 'summary');
  await showTab(page, 'transcript');
  assert.equal(await page.evaluate(() => document.getElementById('log').scrollTop), 0);
  assert.ok(await page.isVisible('#jump'));
  await page.click('#jump');
  await page.waitForSelector('#jump', { state: 'hidden' });

  // At the newest line while listening: the lines said while the summary was open are in view.
  await mockGemini(
    page,
    Array.from({ length: 8 }, (_, i) => [3 + i * 3, 'final', `New ${i}.`]),
  );
  await page.click('#toggle');
  await listening(page);
  await showTab(page, 'summary');
  await page.waitForFunction(() => document.querySelectorAll('#log .seg:not(.live)').length >= 63);
  await showTab(page, 'transcript');
  assert.ok((await below()) < 120, 'at the newest line');
  assert.ok(await page.isHidden('#jump'));
  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});
