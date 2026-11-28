// Browser tests: the languages of an audio file, chosen in the import dialog. Every Gemini endpoint
// is mocked (the Files and Interactions routes, translation that says the language it was asked for).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseAudioFile,
  fileRead,
  importChoice,
  linesDone,
  listeningChoice,
  mockSpeakers,
  mockTargets,
  REBUILT_LINES,
  rebuildAnswer,
  rows,
  setup,
  storedSessions,
  tagged,
  wavFile,
} from './helpers.js';

const { openApp } = setup();

const dialog = (page) => page.locator('#importDialog');
const imported = (page) =>
  page.waitForFunction(() => document.getElementById('toast').textContent.includes('読み込みました'));

test('the dialog starts from the languages chosen for listening, keeps two different languages and a third that differs from both, and leaves the listening choice and the saved settings alone', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', langA: 'en-US', langB: 'ja-JP' });
  const before = await listeningChoice(page);

  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  assert.deepEqual(await importChoice(page), { A: 'en-US', B: 'ja-JP', C: '' });
  // Named for assistive technology, in the display language.
  const group = dialog(page).getByRole('group', { name: '言語' });
  for (const name of ['言語1', '言語2', '言語3'])
    assert.ok(await group.getByRole('combobox', { name }).isVisible(), name);
  assert.ok(await group.getByRole('button', { name: '言語を入れ替え' }).isVisible());
  // The same languages as the listening choice; the third can be left out.
  const offered = (id) => page.locator(`#${id} option`).allTextContents();
  assert.equal((await offered('importLangA')).length, 14);
  assert.deepEqual(await offered('importLangB'), await offered('importLangA'));
  assert.deepEqual(await offered('importLangC'), ['+ 言語を追加', ...(await offered('importLangA'))]);

  // Another first language; then the second one set to it: they trade places, never the same twice.
  await page.selectOption('#importLangA', 'ko-KR');
  assert.deepEqual(await importChoice(page), { A: 'ko-KR', B: 'ja-JP', C: '' });
  await page.selectOption('#importLangB', 'ko-KR');
  assert.deepEqual(await importChoice(page), { A: 'ja-JP', B: 'ko-KR', C: '' });
  await page.click('#importSwap');
  assert.deepEqual(await importChoice(page), { A: 'ko-KR', B: 'ja-JP', C: '' });
  assert.ok(await page.isVisible('#importDialog'), 'the swap button does not close the dialog');

  // A third language; one equal to the first two takes its place there, and that one gets another.
  await page.selectOption('#importLangC', 'de-DE');
  assert.deepEqual(await importChoice(page), { A: 'ko-KR', B: 'ja-JP', C: 'de-DE' });
  await page.selectOption('#importLangA', 'de-DE');
  assert.deepEqual(await importChoice(page), { A: 'de-DE', B: 'ja-JP', C: 'ko-KR' });
  await page.selectOption('#importLangC', 'ja-JP');
  const three = await importChoice(page);
  assert.equal(three.C, 'ja-JP');
  assert.equal(new Set([three.A, three.B, three.C]).size, 3, 'three different languages');
  await page.selectOption('#importLangC', '');
  assert.equal((await importChoice(page)).C, '');

  assert.deepEqual(await listeningChoice(page), before, 'the listening choice and the saved settings are as they were');

  // Opened again: from the listening choice once more.
  await page.click('#importCancel');
  await page.waitForFunction(() => !document.getElementById('importDialog').open);
  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  assert.deepEqual(await importChoice(page), { A: 'en-US', B: 'ja-JP', C: '' });
  assert.deepEqual(await listeningChoice(page), before);
  assert.deepEqual(errors, []);
  await close();
});

test('a file imported in other languages makes a session in them, translated into the right language; the listening choice stays until the session is shown', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  await mockTargets(page);
  const before = await listeningChoice(page);

  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  assert.deepEqual(await importChoice(page), { A: 'ja-JP', B: 'en-US', C: '' });
  await page.selectOption('#importLangA', 'ko-KR');
  assert.deepEqual(await listeningChoice(page), before);
  await page.click('#importConfirm');
  await imported(page);

  // The English lines go into Korean, not into Japanese as the listening choice would have them.
  assert.deepEqual(
    (await rows(page)).map((r) => r.tgt),
    REBUILT_LINES.map((l) => `[Korean] ${l.text}`),
  );
  const [stored] = await storedSessions(page);
  assert.deepEqual([stored.langA, stored.langB, stored.langC], ['ko-KR', 'en-US', undefined]);
  assert.deepEqual(
    stored.segments.map((s) => s.tgt),
    REBUILT_LINES.map((l) => `[Korean] ${l.text}`),
  );
  // The session is shown as any session is opened: with its own languages.
  assert.deepEqual((await listeningChoice(page)).selects, ['ko-KR', 'en-US', '']);
  assert.deepEqual(errors, []);
  await close();
});

test("a third language chosen in the dialog is the session's, and every line is translated into the other two", async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
  await mockSpeakers(page, { analyze: () => ({ body: rebuildAnswer() }) });
  // English and German share a writing system: the model is asked which one a line is in.
  await mockTargets(page, 'English');

  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  await page.selectOption('#importLangC', 'de-DE');
  await page.click('#importConfirm');
  await imported(page);
  await linesDone(
    page,
    REBUILT_LINES.map(() => 2),
  );
  assert.deepEqual(
    (await tagged(page)).map((r) => r.lines),
    REBUILT_LINES.map((l) => [
      ['JA', `[Japanese] ${l.text}`],
      ['DE', `[German] ${l.text}`],
    ]),
  );
  const [stored] = await storedSessions(page);
  assert.deepEqual([stored.langA, stored.langB, stored.langC], ['ja-JP', 'en-US', 'de-DE']);
  assert.deepEqual(errors, []);
  await close();
});

test('the languages cannot change while the import runs, and can again after it fails', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key' });
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
  const controls = ['#importLangA', '#importLangB', '#importLangC', '#importSwap'];

  await chooseAudioFile(page, wavFile());
  await fileRead(page);
  for (const c of controls) assert.ok(await page.isEnabled(c), c);
  await page.selectOption('#importLangB', 'fr-FR');
  await page.click('#importConfirm');
  await page.waitForFunction(() => document.getElementById('importStatus').textContent.includes('1/1'));
  for (const c of controls) assert.ok(await page.isDisabled(c), `${c} while it runs`);
  release();
  await page.waitForSelector('#importError:not([hidden])');
  for (const c of controls) assert.ok(await page.isEnabled(c), `${c} after it failed`);
  assert.deepEqual(await importChoice(page), { A: 'ja-JP', B: 'fr-FR', C: '' }, 'the choice is kept for another try');
  assert.deepEqual(errors, []);
  await close();
});

for (const uiLang of ['ja', 'en', 'zh-Hans']) {
  test(`the dialog with three languages fits at 390 px in ${uiLang}`, async () => {
    const { page, errors, close } = await openApp('', { apiKey: 'test-key', uiLang });
    await chooseAudioFile(page, wavFile());
    await fileRead(page);
    await page.selectOption('#importLangA', 'cmn-Hant-TW');
    await page.selectOption('#importLangC', 'id-ID');
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.evaluate(() => {
      const box = document.getElementById('importDialog').getBoundingClientRect();
      const body = document.querySelector('#importDialog .dialog-body');
      const controls = ['importLangA', 'importSwap', 'importLangB', 'importLangC', 'importCancel', 'importConfirm'];
      return {
        page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        body: body.scrollWidth <= body.clientWidth,
        outside: controls.filter((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.left < box.left || r.right > box.right || r.height < 32;
        }),
        row: ['importLangA', 'importSwap', 'importLangB'].map((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.top + r.height / 2;
        }),
      };
    });
    assert.ok(layout.page, 'no horizontal scroll on the page');
    assert.ok(layout.body, 'no horizontal scroll in the dialog');
    assert.deepEqual(layout.outside, [], 'every control inside the dialog and at least 32 px tall');
    assert.equal(new Set(layout.row.map(Math.round)).size, 1, 'the first two languages and the swap on one row');
    assert.deepEqual(errors, []);
    await close();
  });
}
