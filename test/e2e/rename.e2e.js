// Browser tests: renaming a saved session in its row of the sidebar, with the mouse and with the
// keyboard, what the header and the saved session show afterwards, and where the keyboard focus is
// when the list is made anew.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listening,
  mockSpeech,
  mockTranslation,
  reload,
  saved,
  seedRecordedSession,
  sessionNames,
  setup,
  storedSessions,
} from './helpers.js';

const { openApp } = setup();

const FIELD = '#sessionList .renaming input';
const row = (page, n = 0) => page.locator('#sessionList .session').nth(n);
const pencil = (page, n = 0) => row(page, n).locator('.act').first();
const header = (page) => page.textContent('#sessionName');
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el.tagName, label: el.getAttribute('aria-label'), value: el.tagName === 'INPUT' ? el.value : null };
  });

// A page with one saved session, "Weekly sync", on screen.
async function withSession(options) {
  const app = await openApp('', { apiKey: 'test-key' }, undefined, options);
  await seedRecordedSession(app.page);
  await app.page.waitForSelector('#sessionList .session');
  return app;
}

test('a session is renamed in its row with Enter, and the header and the saved session follow', async () => {
  const { page, errors, close } = await withSession();
  const height = (await row(page).boundingBox()).height;
  await pencil(page).click();

  assert.deepEqual(await focused(page), { tag: 'INPUT', label: 'セッション名', value: 'Weekly sync' });
  assert.equal(
    await page.evaluate(() => document.activeElement.selectionEnd - document.activeElement.selectionStart),
    11,
  );
  assert.equal((await row(page).boundingBox()).height, height, 'the row keeps its height');
  await page.keyboard.type('  Budget review ');
  await page.keyboard.press('Enter');

  assert.equal(await page.locator(FIELD).count(), 0);
  assert.deepEqual(await sessionNames(page), ['Budget review']);
  assert.equal(await header(page), 'Budget review');
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null });
  await saved(page);
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null }, 'after the save too');
  assert.deepEqual(
    (await storedSessions(page)).map((s) => [s.title, s.customTitle]),
    [['Budget review', true]],
  );
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(await sessionNames(page), ['Budget review']);
  assert.deepEqual(errors, []);
  await close();
});

test('leaving the field keeps the name typed, and focus stays where it went', async () => {
  const { page, errors, close } = await withSession();
  await pencil(page).click();
  await page.fill(FIELD, 'Planning');
  await page.click('#openSettings');
  assert.deepEqual(await sessionNames(page), ['Planning']);
  assert.equal(await header(page), 'Planning');
  assert.ok(await page.locator('#settings[open]').count(), 'the click that left the field still opened the settings');
  assert.deepEqual(errors, []);
  await close();
});

test('Escape leaves the name as it was, and an empty or unchanged name keeps it', async () => {
  const { page, errors, close } = await withSession();
  await pencil(page).click();
  await page.fill(FIELD, 'Something else');
  await page.keyboard.press('Escape');
  assert.deepEqual(await sessionNames(page), ['Weekly sync']);
  assert.equal(await header(page), 'Weekly sync');
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null });
  await saved(page);
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null }, 'after the save too');

  await pencil(page).click();
  await page.fill(FIELD, '   ');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sessionNames(page), ['Weekly sync']);

  await pencil(page).click();
  await page.keyboard.press('Enter');
  assert.deepEqual(await sessionNames(page), ['Weekly sync']);
  assert.deepEqual(errors, []);
  await close();
});

test('a session is renamed with the keyboard alone', async () => {
  const { page, errors, close } = await withSession();
  await page.focus('#sessionList .session .open');
  await page.keyboard.press('Tab');
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Retro');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sessionNames(page), ['Retro']);
  assert.equal(await header(page), 'Retro');
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null });
  await saved(page);
  assert.deepEqual(await focused(page), { tag: 'BUTTON', label: '名前を変更', value: null }, 'after the save too');
  assert.deepEqual(errors, []);
  await close();
});

test('a long name stays inside the sidebar while it is typed and after', async () => {
  const { page, errors, close } = await withSession();
  const long = 'A very long name for a meeting that goes on and on without a break anywhere at all';
  const overflow = () =>
    page.evaluate(() => {
      const list = document.getElementById('sessionList');
      return list.scrollWidth - list.clientWidth;
    });
  await pencil(page).click();
  await page.fill(FIELD, long);
  assert.equal(await overflow(), 0);
  await page.keyboard.press('Enter');
  assert.deepEqual(await sessionNames(page), [long]);
  assert.equal(await overflow(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('a session saved while a name is typed does not take away what is typed', async () => {
  const { page, errors, close } = await withSession();
  await page.click('#newSession');
  const { say } = await mockSpeech(page);
  await mockTranslation(page, ({ text }) => `訳:${text}`);
  await page.click('#toggle');
  await listening(page);

  await pencil(page).click();
  await page.keyboard.type('Budget re');
  await say('final', 'Hello there.');
  // The new session is saved and the list made anew, with the new session above the one edited.
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 2);
  assert.deepEqual(await focused(page), { tag: 'INPUT', label: 'セッション名', value: 'Budget re' });
  assert.equal(await page.locator('#sessionList .session').nth(1).locator('input').count(), 1);
  await page.keyboard.type('view');
  await page.keyboard.press('Enter');
  assert.deepEqual(await sessionNames(page), ['Hello there.', 'Budget review']);
  assert.equal(await header(page), 'Hello there.', 'the header shows the session on screen');

  await page.click('#toggle');
  await saved(page);
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.deepEqual(await sessionNames(page), ['Hello there.', 'Budget review']);
  assert.deepEqual(errors, []);
  await close();
});

test("a row's button keeps the focus when another session is saved and the list is made anew", async () => {
  const { page, errors, close } = await withSession();
  await page.click('#newSession');
  const { say } = await mockSpeech(page);
  await mockTranslation(page, ({ text }) => `訳:${text}`);
  await page.click('#toggle');
  await listening(page);
  // Which button has the focus, and the name of the session whose row holds it.
  const focusedIn = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return {
        label: el.getAttribute('aria-label'),
        session: el.closest('.session')?.querySelector('.name').textContent,
      };
    });
  // Waits until the row the focus is in has been taken out of the page by a redraw.
  const redrawn = async (speak) => {
    await page.evaluate(() => {
      window.focusedRow = document.activeElement.closest('.session');
    });
    await speak();
    await page.waitForFunction(() => !window.focusedRow.isConnected);
  };

  await row(page).locator('.act').nth(1).focus();
  await redrawn(() => say('final', 'Hello there.'));
  assert.deepEqual(await focusedIn(), { label: '削除', session: 'Weekly sync' });

  await pencil(page, 1).focus();
  await redrawn(() => say('final', 'And more.'));
  assert.deepEqual(await focusedIn(), { label: '名前を変更', session: 'Weekly sync' });

  await page.click('#toggle');
  assert.deepEqual(errors, []);
  await close();
});
