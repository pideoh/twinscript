// Browser tests: speech in a language that is none of the selected ones. It is translated into
// all of them by default, or into the one chosen in settings, with two languages as with three.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linesDone, mockGemini, mockTargets, saved, setup, tagged } from './helpers.js';

const { openApp } = setup();

const HINDI = 'और यह है छोटे सिंक्रोनस मोटर।';
const JAPANESE = 'それでは会議を始めます。';

// Waits until `count` rows are finished and every translation in them is complete.
const done = (page, count) =>
  page.waitForFunction((n) => {
    const segs = [...document.querySelectorAll('.seg:not(.live)')];
    return (
      segs.length === n &&
      segs.every((s) => {
        const lines = [...s.querySelectorAll('.tgt-line .tgt-text')];
        const texts = lines.length ? lines.map((l) => l.textContent) : [s.querySelector('.tgt').textContent];
        return !s.querySelector('.pending') && texts.every((t) => t.startsWith('['));
      })
    );
  }, count);
const storedSessions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const req = open.result.transaction('sessions').objectStore('sessions').getAll();
          req.onsuccess = () => resolve(req.result);
        };
      }),
  );
const options = (page) =>
  page.locator('#otherInto option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
// Closes the settings with Save and waits until the app has taken the values (the dialog's close
// event comes a little after the click).
async function saveSettings(page) {
  const closed = page.evaluate(
    () =>
      new Promise((resolve) =>
        document.getElementById('settings').addEventListener('close', () => setTimeout(resolve), { once: true }),
      ),
  );
  await page.click('#settings button[value=ok]');
  await closed;
}

test('with two languages, speech written in neither is translated into both, each on a tagged line', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimInterval: 0.5 });
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#otherInto'), 'all', 'all selected languages by default');
  assert.deepEqual(await options(page), [
    ['all', '選んだすべての言語'],
    ['A', '日本語のみ'],
    ['B', '英語のみ'],
  ]);
  assert.equal(await page.textContent('#otherIntoField .form-label'), '選んだ言語以外が話されたときの訳し先');
  await saveSettings(page);

  await mockGemini(page, [
    [2, 'interim', 'और यह है छोटे'],
    [20, 'final', HINDI],
    [24, 'final', JAPANESE],
  ]);
  const identify = await mockTargets(page);
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg.live .tgt-line.pending').length === 2);
  const live = await page
    .locator('.seg.live .tgt-line')
    .evaluateAll((ls) => ls.map((l) => l.querySelector('.lang-tag').textContent));
  assert.deepEqual(live, ['JA', 'EN'], 'the sentence in progress too');
  await done(page, 2);
  await page.click('#toggle');

  assert.deepEqual(await tagged(page), [
    {
      src: HINDI,
      lines: [
        ['JA', `[Japanese] ${HINDI}`],
        ['EN', `[English] ${HINDI}`],
      ],
    },
    { src: JAPANESE, lines: [] },
  ]);
  assert.equal(await page.locator('.seg .tgt').nth(1).textContent(), `[English] ${JAPANESE}`, 'one untagged line');
  assert.equal(identify.length, 0, 'two languages never ask the model which language it is');

  await saved(page);
  const [stored] = await storedSessions(page);
  assert.ok(!('langC' in stored));
  assert.equal(stored.segments[0].lang, 'other');
  assert.deepEqual(stored.segments[0].tgts, [
    { lang: 'ja-JP', text: `[Japanese] ${HINDI}` },
    { lang: 'en-US', text: `[English] ${HINDI}` },
  ]);
  assert.equal(stored.segments[0].tgt, `[Japanese] ${HINDI}\n[English] ${HINDI}`);
  assert.deepEqual(Object.keys(stored.segments[1]).sort(), ['at', 'elapsed', 'id', 'src', 'tgt']);
  assert.deepEqual(errors, []);
  await close();
});

test('with two languages, choosing one of them sends other speech into that one only', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  await page.click('#openSettings');
  await page.selectOption('#otherInto', 'B');
  await saveSettings(page);
  await mockGemini(page, [[3, 'final', HINDI]]);
  await mockTargets(page);
  await page.click('#toggle');
  await done(page, 1);
  await page.click('#toggle');
  assert.deepEqual(await tagged(page), [{ src: HINDI, lines: [] }]);
  assert.equal(await page.textContent('.seg .tgt'), `[English] ${HINDI}`);
  assert.deepEqual(errors, []);
  await close();
});

test('a choice of one language stored by an earlier version keeps working as before', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false, otherInto: 'A' });
  await mockGemini(page, [[3, 'final', HINDI]]);
  await mockTargets(page);
  await page.click('#toggle');
  await done(page, 1);
  await page.click('#toggle');
  assert.equal(await page.locator('.tgt-line').count(), 0);
  assert.equal(await page.textContent('.seg .tgt'), `[Japanese] ${HINDI}`);
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#otherInto'), 'A');
  assert.deepEqual(errors, []);
  await close();
});

test('with three languages, choosing one of them sends a fourth language into that one only', async () => {
  const { page, errors, close } = await openApp('', {
    apiKey: 'test-key',
    interimTranslate: false,
    langC: 'cmn-Hans-CN',
  });
  await page.click('#openSettings');
  assert.deepEqual(
    (await options(page)).map(([value]) => value),
    ['all', 'A', 'B', 'C'],
  );
  await page.selectOption('#otherInto', 'C');
  await saveSettings(page);
  await mockGemini(page, [
    [3, 'final', HINDI],
    [5, 'final', JAPANESE],
  ]);
  await mockTargets(page);
  await page.click('#toggle');
  await linesDone(page, [1, 2]);
  await page.click('#toggle');
  assert.deepEqual(await tagged(page), [
    { src: HINDI, lines: [['ZH', `[Simplified Chinese] ${HINDI}`]] },
    {
      src: JAPANESE,
      lines: [
        ['EN', `[English] ${JAPANESE}`],
        ['ZH', `[Simplified Chinese] ${JAPANESE}`],
      ],
    },
  ]);
  assert.deepEqual(errors, []);
  await close();
});

test('the choice follows its language when languages change places, and is all once its language is removed', async () => {
  const { page, errors, close } = await openApp('', { langC: 'ko-KR' });
  const choice = async () => {
    await page.click('#openSettings');
    const value = await page.inputValue('#otherInto');
    const text = await page.locator('#otherInto option:checked').textContent();
    await saveSettings(page);
    return [value, text];
  };
  await page.click('#openSettings');
  await page.selectOption('#otherInto', 'C');
  await saveSettings(page);
  assert.deepEqual(await choice(), ['C', '韓国語のみ']);

  await page.selectOption('#langA', 'ko-KR'); // the third takes Japanese
  assert.deepEqual([await page.inputValue('#langA'), await page.inputValue('#langC')], ['ko-KR', 'ja-JP']);
  assert.deepEqual(await choice(), ['A', '韓国語のみ']);
  await page.click('#swap');
  assert.deepEqual(await choice(), ['B', '韓国語のみ']);

  await page.click('#openSettings');
  await page.selectOption('#otherInto', 'C');
  await saveSettings(page);
  await page.selectOption('#langC', '');
  assert.deepEqual(await choice(), ['all', '選んだすべての言語']);
  assert.equal(await page.locator('#otherInto option').count(), 3, 'no third language to choose');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')));
  assert.equal(stored.otherInto, 'all');
  assert.deepEqual(errors, []);
  await close();
});
