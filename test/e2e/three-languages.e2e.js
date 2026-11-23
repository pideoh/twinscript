// Browser tests: an optional third language. Every sentence is translated into the other two
// selected languages (a fourth language into all three), one tagged line per translation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linesDone, mockGemini, mockTargets, reload, rows, saved, setup, tagged, translated } from './helpers.js';

const { openApp } = setup();

test('with a third language every sentence is translated into the other two, a fourth language into all three', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false });
  assert.equal(await page.locator('#langC option[value=""]').textContent(), '+ 言語を追加');
  assert.equal(await page.inputValue('#langC'), '', 'two languages unless one is added');
  await page.selectOption('#langC', 'cmn-Hans-CN');

  await mockGemini(page, [
    [3, 'final', 'それでは会議を始めます。'],
    [5, 'final', "Let's begin the meeting now."],
    [7, 'final', '我们这一代人要为未来思考'],
    [9, 'final', 'और यह है छोटे सिंक्रोनस मोटर।'],
    [11, 'final', '東京都知事'],
  ]);
  const identify = await mockTargets(page, 'Japanese');
  await page.click('#toggle');
  assert.ok(await page.locator('#langC').isDisabled(), 'fixed while listening');
  await linesDone(page, [2, 2, 2, 3, 2]);
  await page.click('#toggle');

  const expected = [
    {
      src: 'それでは会議を始めます。',
      lines: [
        ['en', '[English] それでは会議を始めます。'],
        ['zh-Hans', '[Simplified Chinese] それでは会議を始めます。'],
      ],
    },
    {
      src: "Let's begin the meeting now.",
      lines: [
        ['ja', "[Japanese] Let's begin the meeting now."],
        ['zh-Hans', "[Simplified Chinese] Let's begin the meeting now."],
      ],
    },
    {
      src: '我们这一代人要为未来思考',
      lines: [
        ['ja', '[Japanese] 我们这一代人要为未来思考'],
        ['en', '[English] 我们这一代人要为未来思考'],
      ],
    },
    {
      src: 'और यह है छोटे सिंक्रोनस मोटर।',
      lines: [
        ['ja', '[Japanese] और यह है छोटे सिंक्रोनस मोटर।'],
        ['en', '[English] और यह है छोटे सिंक्रोनस मोटर।'],
        ['zh-Hans', '[Simplified Chinese] और यह है छोटे सिंक्रोनस मोटर।'],
      ],
    },
    {
      src: '東京都知事',
      lines: [
        ['en', '[English] 東京都知事'],
        ['zh-Hans', '[Simplified Chinese] 東京都知事'],
      ],
    },
  ];
  assert.deepEqual(await tagged(page), expected);
  assert.deepEqual(
    identify.map((r) => r.text),
    ['東京都知事'],
    'the model is asked only when the writing system does not tell',
  );
  assert.deepEqual(identify[0].request.generationConfig.responseJsonSchema.properties.language.enum, [
    'Japanese',
    'English',
    'Simplified Chinese',
    'other',
  ]);

  // Stored: the translations are also kept joined, so downloads read as before.
  await saved(page);
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const req = open.result.transaction('sessions').objectStore('sessions').getAll();
          req.onsuccess = () => resolve(req.result);
        };
      }),
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].langC, 'cmn-Hans-CN');
  assert.deepEqual(stored[0].segments[0].tgts, [
    { lang: 'en-US', text: '[English] それでは会議を始めます。' },
    { lang: 'cmn-Hans-CN', text: '[Simplified Chinese] それでは会議を始めます。' },
  ]);
  assert.equal(stored[0].segments[0].lang, 'ja-JP');
  assert.equal(stored[0].segments[3].lang, 'other');
  assert.equal(
    stored[0].segments[0].tgt,
    '[English] それでは会議を始めます。\n[Simplified Chinese] それでは会議を始めます。',
  );

  // The session reopens with its third language.
  await page.click('#newSession');
  await page.selectOption('#langC', '');
  await reload(page);
  await page.waitForSelector('#sessionList .session');
  assert.equal(await page.inputValue('#langC'), '', 'an untouched new session is not saved');
  await page.locator('#sessionList .open').first().click();
  assert.equal(await page.inputValue('#langC'), 'cmn-Hans-CN');
  assert.deepEqual(await tagged(page), expected);
  assert.deepEqual(errors, []);
  await close();
});

test('turning the third language off returns to two languages as before', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'test-key', interimTranslate: false, langC: 'ko-KR' });
  assert.equal(await page.inputValue('#langC'), 'ko-KR');
  await page.selectOption('#langC', '');
  const gemini = await mockGemini(page, [[3, 'final', 'それでは会議を始めます。']]);
  await page.click('#toggle');
  await translated(page, 1);
  await page.click('#toggle');
  assert.deepEqual(await rows(page), [
    { live: false, src: 'それでは会議を始めます。', tgt: '訳:それでは会議を始めます。' },
  ]);
  assert.equal(await page.locator('.tgt-line, .lang-tag, .tgt.multi').count(), 0, 'no tags');

  await saved(page);
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const req = open.result.transaction('sessions').objectStore('sessions').getAll();
          req.onsuccess = () => resolve(req.result);
        };
      }),
  );
  assert.ok(!('langC' in stored[0]), 'a two-language session keeps its shape');
  assert.deepEqual(Object.keys(stored[0].segments[0]).sort(), ['at', 'elapsed', 'id', 'src', 'tgt']);

  // A new session with a third language; going back to the old one turns it off again.
  await page.click('#newSession');
  await page.selectOption('#langC', 'ko-KR');
  gemini.restart();
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live) .tgt-line').length === 2);
  await page.click('#toggle');
  await saved(page);
  await page.locator('#sessionList .open').nth(1).click();
  assert.equal(await page.inputValue('#langC'), '');
  await page.locator('#sessionList .open').nth(0).click();
  assert.equal(await page.inputValue('#langC'), 'ko-KR');
  assert.deepEqual(errors, []);
  await close();
});

test('the third language never equals the other two', async () => {
  const { page, close } = await openApp('', {});
  await page.selectOption('#langC', 'en-US');
  assert.deepEqual(
    [await page.inputValue('#langA'), await page.inputValue('#langB'), await page.inputValue('#langC')],
    ['ja-JP', 'cmn-Hans-CN', 'en-US'],
    'the language it was taken from gets the first one not in use',
  );
  await page.selectOption('#langA', 'en-US');
  assert.deepEqual(
    [await page.inputValue('#langA'), await page.inputValue('#langB'), await page.inputValue('#langC')],
    ['en-US', 'cmn-Hans-CN', 'ja-JP'],
    'the third takes the language the first one had',
  );
  await page.selectOption('#langC', 'cmn-Hans-CN');
  assert.deepEqual(
    [await page.inputValue('#langA'), await page.inputValue('#langB'), await page.inputValue('#langC')],
    ['en-US', 'ja-JP', 'cmn-Hans-CN'],
    'the second takes the language the third one had',
  );
  await page.click('#swap');
  assert.deepEqual(
    [await page.inputValue('#langA'), await page.inputValue('#langB'), await page.inputValue('#langC')],
    ['ja-JP', 'en-US', 'cmn-Hans-CN'],
    'swap changes the first two only',
  );
  await close();
});

test('with a third language the settings keep the choice for other languages and turn off reading aloud', async () => {
  const { page, close } = await openApp('', {});
  await page.click('#openSettings');
  assert.ok(await page.locator('#otherInto').isVisible());
  assert.ok(await page.locator('#readAloudUnavailableThree').isHidden());
  const twoLanguages = [await page.inputValue('#captionContent'), await page.inputValue('#captionItems')];
  assert.deepEqual(twoLanguages, ['both', '3']);
  await page.click('#settings button[value=ok]');

  await page.selectOption('#langC', 'cmn-Hans-CN');
  await page.click('#openSettings');
  assert.ok(await page.locator('#otherInto').isVisible());
  assert.ok(await page.locator('#readAloudField').isVisible(), 'Chrome can speak');
  assert.ok(await page.locator('#readAloud').isDisabled());
  assert.ok(await page.locator('#readAloudUnavailableThree').isVisible());
  assert.ok(await page.locator('#readAloudUnavailable').isHidden());
  assert.deepEqual(
    [await page.inputValue('#captionContent'), await page.inputValue('#captionItems')],
    ['tgt', '3'],
    'the caption zone shows translations only and keeps as many sentences as with two languages',
  );
  await page.selectOption('#captionContent', 'both');
  await page.click('#settings button[value=ok]');
  assert.ok(!(await page.locator('#now').evaluate((n) => n.classList.contains('tgt-only'))));

  await page.selectOption('#langC', '');
  await page.click('#openSettings');
  assert.ok(await page.locator('#otherInto').isVisible());
  assert.deepEqual(
    [await page.inputValue('#captionContent'), await page.inputValue('#captionItems')],
    twoLanguages,
    'two languages keep their own caption settings',
  );
  await page.click('#settings button[value=ok]');
  await page.selectOption('#langC', 'cmn-Hans-CN');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#captionContent'), 'both', 'the choice made with three languages is kept');
  await close();
});

test('with a third language the sentence in progress is translated when its writing system tells', async () => {
  const { page, errors, close } = await openApp('', {
    apiKey: 'test-key',
    langC: 'cmn-Hans-CN',
    interimInterval: 0.5,
  });
  await mockGemini(page, [
    [2, 'interim', 'それでは会議を'],
    [20, 'final', 'それでは会議を始めます。'],
  ]);
  const identify = await mockTargets(page);
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg.live .tgt-line.pending').length === 2);
  const live = await page
    .locator('.seg.live .tgt-line')
    .evaluateAll((ls) => ls.map((l) => l.querySelector('.lang-tag').textContent));
  assert.deepEqual(live, ['en', 'zh-Hans']);
  // In the caption zone, translations only: the source is hidden once a translation is there.
  assert.ok(await page.locator('#now .seg.live .src').isHidden());
  await linesDone(page, [2]);
  await page.click('#toggle');
  assert.equal(identify.length, 0);
  assert.deepEqual(errors, []);
  await close();
});
