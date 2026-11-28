// Browser tests: the three bands of the screen. The header is this session (its name, what is done
// with it, then the app's usage and settings), the tabs and their panel are its views, the bottom
// bar is listening (what is listened to, in a popover, the caption window, the status and Start).
// Each band is the same on every tab; the bar stays on one line at every width.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseListening,
  listening,
  mockGemini,
  mockLineTranslation,
  mockSpeakers,
  rebuildAnswer,
  saved,
  seedNamedSession,
  seedRecordedSession,
  setup,
  showTab,
  translated,
} from './helpers.js';

const { openApp } = setup();
const TABS = ['transcript', 'summary', 'questions'];
const inHeader = (page, id) => page.evaluate((id) => !!document.getElementById(id).closest('header.bar'), id);
const inBar = (page, id) => page.evaluate((id) => !!document.getElementById(id).closest('.dock'), id);
const focused = (page) => page.evaluate(() => document.activeElement?.id);

// A recorded session whose transcript was rebuilt: every session action is offered.
async function everyAction(page) {
  await seedNamedSession(page);
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await mockLineTranslation(page);
  await page.click('#rebuild');
  await page.waitForSelector('#rebuildDialog[open]');
  await page.click('#rebuildConfirm');
  await page.waitForSelector('#restoreTranscript:not([hidden])');
}

test("the session's actions are in the header on every tab, after its name; usage and settings come last", async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await everyAction(page);
  const order = [
    'sessionName',
    'editSpeakers',
    'labelSpeakers',
    'rebuild',
    'restoreTranscript',
    'export',
    'openUsage',
    'openSettings',
  ];
  for (const tab of TABS) {
    await showTab(page, tab);
    for (const id of order) {
      assert.ok(await page.isVisible(`#${id}`), `${id} is shown with the ${tab} tab`);
      assert.ok(await inHeader(page, id), `${id} is in the header`);
    }
    const xs = await Promise.all(order.map(async (id) => (await page.locator(`#${id}`).boundingBox()).x));
    assert.deepEqual(
      xs,
      [...xs].sort((a, b) => a - b),
      'in this order',
    );
  }
  assert.equal(
    await page.locator('.tab-row, [role="tablist"] button:not([role="tab"])').count(),
    0,
    'the tab row holds only the tabs',
  );
  assert.deepEqual(errors, []);
  await close();
});

test('the name of the session is the heading of the main region; it follows renaming, a new session and its first line', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  assert.equal(await page.textContent('#sessionName'), 'Weekly sync');
  assert.equal(await page.getAttribute('#sessionName', 'title'), 'Weekly sync');
  assert.equal(await page.evaluate(() => document.getElementById('sessionName').localName), 'h2');
  assert.equal(await page.getAttribute('main', 'aria-labelledby'), 'sessionName');

  await page.locator('#sessionList .session.current .act').first().click();
  await page.fill(
    '#sessionList .renaming input',
    'Budget review with the whole team, and the schedule for next quarter',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('sessionName').textContent.startsWith('Budget review'));
  const box = await page.locator('#sessionName').boundingBox();
  const fits = await page.evaluate(() => {
    const el = document.getElementById('sessionName');
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
  assert.ok(box.height <= 40, 'one line');
  assert.ok(fits.scroll >= fits.client, 'cut, not wrapped');

  await page.click('#newSession');
  await page.waitForFunction(() => !document.getElementById('sessionName').textContent.startsWith('Budget'));
  const shown = await page.textContent('#sessionName');
  assert.match(shown, /\d/, 'a new session is named by when it was made, as the sidebar will name it');

  await mockGemini(page, [[3, 'final', 'The first thing said.']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  await saved(page);
  await page.waitForFunction(() => document.getElementById('sessionName').textContent === 'The first thing said.');
  assert.equal(await page.locator('#sessionList .session.current .name').textContent(), 'The first thing said.');
  assert.deepEqual(errors, []);
  await close();
});

test('the bottom bar is the same on every tab: listening starts from the Summary tab and stops from the Questions tab', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockGemini(page, [[3, 'final', 'Said while the summary was open.']]);
  for (const id of [
    'listenChoices',
    'langA',
    'langB',
    'langC',
    'swap',
    'source',
    'pip',
    'statusText',
    'clock',
    'toggle',
  ]) {
    assert.ok(await inBar(page, id), `${id} is in the bottom bar`);
  }
  await showTab(page, 'summary');
  assert.ok(await page.isVisible('#listenChoices'));
  await page.click('#toggle');
  await listening(page);
  assert.ok(await page.isDisabled('#listenChoices'), 'what is listened to cannot change while listening');
  assert.match(await page.textContent('#listenChoices'), /日本語 ⇄ 英語 ・ マイク/, 'and it still says it');
  const [now, bar] = await Promise.all([page.locator('#now').boundingBox(), page.locator('.dock').boundingBox()]);
  assert.ok(Math.abs(now.y + now.height - bar.y) <= 1, 'the sentence being spoken is directly above the bar');
  await showTab(page, 'questions');
  assert.ok(await page.isVisible('#toggle'));
  await page.click('#toggle');
  await page.waitForFunction(() => !document.body.classList.contains('running'));
  assert.ok(await page.isEnabled('#listenChoices'));
  assert.deepEqual(errors, []);
  await close();
});

test('the button of the bar says what is listened to and opens the choices; Escape or a click outside closes them', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  assert.equal(await page.textContent('#listenChoices'), '日本語 ⇄ 英語 ・ マイク');
  assert.equal(await page.getAttribute('#listenChoices', 'aria-controls'), 'listenPopover');
  assert.equal(await page.getAttribute('#listenChoices', 'aria-expanded'), 'false');
  assert.ok(await page.isHidden('#listenPopover'));

  await page.click('#listenChoices');
  assert.equal(await page.getAttribute('#listenChoices', 'aria-expanded'), 'true');
  assert.ok(await page.isVisible('#listenPopover #langA'));
  assert.equal(await focused(page), 'langA', 'focus goes to the first choice');
  await page.keyboard.press('Escape');
  assert.ok(await page.isHidden('#listenPopover'));
  assert.equal(await page.getAttribute('#listenChoices', 'aria-expanded'), 'false');
  assert.equal(await focused(page), 'listenChoices', 'and back to the button');

  await page.click('#listenChoices');
  await page.click('#tabSummary');
  assert.ok(await page.isHidden('#listenPopover'), 'a click outside closes it');

  await chooseListening(page, '#langC', 'cmn-Hans-CN');
  assert.equal(
    await page.textContent('#listenChoices'),
    '日本語、英語、簡体中国語 ・ マイク',
    'three languages are all named',
  );
  await chooseListening(page, '#langC', '');
  await page.click('#listenChoices');
  await page.click('#swap');
  assert.equal(await page.textContent('#listenChoices'), '英語 ⇄ 日本語 ・ マイク', 'the swap shows at once');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await close();
});

test('the summary follows the display language and the languages of a session that is opened', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', uiLang: 'en' });
  assert.equal(await page.textContent('#listenChoices'), 'Japanese ⇄ English · Microphone');
  await seedRecordedSession(page, { extra: { langA: 'en-US', langB: 'ko-KR' } });
  await page.waitForFunction(() => document.getElementById('listenChoices').textContent.startsWith('English ⇄ Korean'));
  assert.deepEqual(errors, []);
  await close();
});

// Boxes of the controls of a band, and the band's.
const boxes = (page, band) =>
  page.evaluate((band) => {
    const root = document.querySelector(band);
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || el.className, x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height };
    };
    const parts = [...root.querySelectorAll('button, select, h2, .state-label, .clock, .meter, [role="status"]')]
      .filter((el) => shown(el) && !el.closest('[hidden]') && !el.closest('.visually-hidden'))
      .filter((el) => el.getBoundingClientRect().width > 2)
      .map(box);
    return {
      band: box(root),
      parts,
      viewport: document.documentElement.clientWidth,
      scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  }, band);
const overlaps = (a, b) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5;

async function assertBandsFit(page, what) {
  for (const band of ['header.bar', '.dock', '#tabs']) {
    const { parts, viewport, scrolls } = await boxes(page, band);
    assert.ok(!scrolls, `${what}: the page does not scroll sideways`);
    for (const [i, a] of parts.entries()) {
      assert.ok(a.x >= 0 && a.right <= viewport + 0.5, `${what}: ${a.id} in ${band} is in the window`);
      for (const b of parts.slice(i + 1))
        assert.ok(!overlaps(a, b), `${what}: ${a.id} and ${b.id} in ${band} do not overlap`);
    }
  }
  // The bar: one row, with Start in full.
  const { band, parts } = await boxes(page, '.dock');
  const start = parts.find((p) => p.id === 'toggle');
  assert.ok(start, `${what}: Start is shown`);
  for (const p of parts) assert.ok(p.y < start.bottom && p.bottom > start.y, `${what}: ${p.id} is on the row of Start`);
  assert.ok(band.height <= start.height + 20, `${what}: the bar is one row (${band.height}px)`);
}

for (const uiLang of ['ja', 'en', 'zh-Hans']) {
  test(`at 360, 390, 900 and 1280 px nothing overlaps or is clipped, the bar is one row and Start is visible (${uiLang})`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key', uiLang });
    await everyAction(page);
    for (const width of [1280, 900, 390, 360]) {
      await page.setViewportSize({ width, height: width < 400 ? 740 : 800 });
      await page.waitForTimeout(300); // the sidebar slides into its drawer
      await assertBandsFit(page, `${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    const header = await boxes(page, 'header.bar');
    assert.ok(header.band.height <= 50, 'at 1280px the header is one line');
    // While listening, too.
    await mockGemini(page, [[3, 'interim', 'Still speaking']]);
    await page.click('#toggle');
    await page.waitForSelector('#dot.on');
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 740 });
      await page.waitForTimeout(300);
      await assertBandsFit(page, `${width}px, listening`);
    }
    await page.click('#toggle');
    assert.deepEqual(errors, []);
    await close();
  });
}

test('Tab follows the bands in the order they are shown: header, tabs, panel, bottom bar', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await seedRecordedSession(page);
  await page.locator('#sessionList .session.current .act').last().focus();
  const bandOf = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (el.closest('header.bar')) return 'header';
      if (el.closest('[role="tablist"]')) return 'tabs';
      if (el.closest('[role="tabpanel"]')) return 'panel';
      if (el.closest('.dock')) return 'bar';
      return 'other';
    });
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const band = await bandOf();
    if (seen.at(-1) !== band) seen.push(band);
    if ((await focused(page)) === 'toggle') break;
  }
  assert.deepEqual(seen, ['header', 'tabs', 'panel', 'bar']);
  assert.deepEqual(errors, []);
  await close();
});
