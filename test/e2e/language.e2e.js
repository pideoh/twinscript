// Browser tests: display language (the browser language, switching it in settings and it being kept) and the
// third language after a swap.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reload, saved, setup } from './helpers.js';

const { openApp } = setup();

const optionText = (page, select, value) => page.locator(`${select} option[value="${value}"]`).textContent();

test('the UI follows the browser language: English by default', async () => {
  const { page, errors, close } = await openApp('', { uiLang: 'auto' });
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#toggle'), 'Start translating');
  assert.equal(await page.textContent('#statusText'), 'Stopped');
  assert.equal(await page.textContent('#empty p'), 'Choose two languages and press "Start translating".');
  assert.equal(await page.getAttribute('#openSettings', 'title'), 'Settings');
  assert.equal(await optionText(page, '#langA', 'ja-JP'), 'Japanese');
  assert.equal(await optionText(page, '#langA', 'cmn-Hans-CN'), 'Simplified Chinese');
  assert.equal(await optionText(page, '#source', 'mic'), 'Microphone');
  await page.click('#toggle'); // no API key yet
  assert.equal(await page.textContent('#toast'), 'Set your Gemini API key first');
  assert.equal(await page.inputValue('#uiLang'), 'auto');
  assert.deepEqual(await page.locator('#uiLang option').allTextContents(), ['Auto', 'English', '日本語', '简体中文']);
  assert.deepEqual(errors, []);
  await close();
});

test('the UI follows the browser language: Simplified Chinese for zh-CN', async () => {
  const { page, errors, close } = await openApp('', { uiLang: 'auto' }, undefined, { locale: 'zh-CN' });
  assert.equal(await page.getAttribute('html', 'lang'), 'zh-Hans');
  assert.equal(await page.textContent('#toggle'), '开始翻译');
  assert.equal(await page.textContent('#statusText'), '已停止');
  assert.equal(await page.getAttribute('#export', 'aria-label'), '下载');
  assert.equal(await page.getAttribute('#glossary', 'placeholder'), '例如：专有名词、产品名称、会议主题等');
  assert.equal(await optionText(page, '#langA', 'en-US'), '英语');
  assert.equal(await optionText(page, '#langA', 'cmn-Hans-CN'), '简体中文');
  assert.equal(await optionText(page, '#langA', 'cmn-Hant-TW'), '繁体中文');
  assert.deepEqual(errors, []);
  await close();
});

test('changing the display language in settings updates the screen at once and is kept', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live)').length >= 1);
  assert.equal(await page.textContent('#toggle'), '停止');
  assert.equal(await page.textContent('#statusText'), '聞き取り中');

  await page.click('#openSettings');
  assert.equal(await page.inputValue('#uiLang'), 'ja');
  await page.locator('#captionItems').fill('1');
  assert.equal(await page.textContent('#captionItemsOut'), '1 文');
  await page.selectOption('#uiLang', 'en');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#settings h2'), 'Settings');
  assert.equal(await page.textContent('#captionItemsOut'), '1 sentence');
  assert.equal(await optionText(page, '#otherInto', 'A'), 'Japanese only');
  assert.equal(await optionText(page, '#uiLang', 'auto'), 'Auto');
  assert.equal(await page.textContent('#toggle'), 'Stop', 'the button keeps its running state');
  assert.equal(await page.textContent('#statusText'), 'Listening');
  assert.equal(await optionText(page, '#langB', 'en-US'), 'English');
  await page.click('#settings button[value=ok]');
  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), 'Stopped');
  await saved(page);
  assert.equal(await page.getAttribute('#sessionList .act >> nth=0', 'title'), 'Rename');

  await page.click('#openSettings');
  await page.selectOption('#uiLang', 'zh-Hans');
  assert.equal(
    await page.getAttribute('#sessionList .act >> nth=1', 'aria-label'),
    '删除',
    'the session list is redrawn',
  );
  await page.click('#settings button[value=ok]');

  await reload(page);
  assert.equal(await page.textContent('#toggle'), '开始翻译');
  assert.equal(await page.textContent('#settings h2'), '设置');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rt-settings')));
  assert.equal(stored.uiLang, 'zh-Hans');
  assert.deepEqual(errors, []);
  await close();
});

test('a third language keeps going to the same language after the two are swapped', async () => {
  const { page, errors, close } = await openApp('', { otherInto: 'A' });
  await page.click('#swap');
  assert.equal(await page.inputValue('#langA'), 'en-US');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#otherInto'), 'B');
  assert.match(await optionText(page, '#otherInto', 'B'), /日本語/);
  assert.deepEqual(errors, []);
  await close();
});
