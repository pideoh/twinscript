// Browser tests: API key prompt, demo mode, UI language, CSP, icons and banners.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockGemini, reload, rows, saved, setup } from './helpers.js';

const { openApp } = setup();

test('asks for the API key before starting', async () => {
  const { page, errors, close } = await openApp();
  await page.click('#toggle');
  assert.ok(await page.locator('dialog#settings').evaluate((d) => d.open));
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.deepEqual(errors, []);
  await close();
});

// Everything the page keeps in web storage, as one string.
const webStorage = (page) =>
  page.evaluate(() =>
    [localStorage, sessionStorage].flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`)).join('\n'),
  );

test('in a browser the API key entered in settings stays in memory and never reaches storage', async () => {
  const { page, errors, close } = await openApp();
  await page.click('#openSettings');
  assert.equal(await page.textContent('#apiKeyStorage'), 'キーはこのページを閉じるまでの間だけ保持されます。');
  await page.fill('#apiKey', 'AIza-entered-key');
  await page.click('#settings button[value=ok]');
  await saved(page);
  assert.ok(!(await webStorage(page)).includes('AIza-entered-key'));
  assert.ok(!(await webStorage(page)).includes('apiKey'));
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#apiKey'), 'AIza-entered-key', 'kept for the life of the page');
  await page.click('#settings button[value=ok]');

  await reload(page);
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#apiKey'), '', 'gone once the page is closed');
  assert.deepEqual(errors, []);
  await close();
});

test('an API key stored by an older version is moved out of storage', async () => {
  const { page, errors, close } = await openApp('', { apiKey: 'AIza-legacy-key', glossary: 'Twinscript' });
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('rt-settings')));
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.glossary, 'Twinscript', 'the other settings are kept');
  assert.ok(!(await webStorage(page)).includes('AIza-legacy-key'));
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#apiKey'), 'AIza-legacy-key');
  assert.deepEqual(errors, []);
  await close();
});

test('in the desktop app the API key goes to the encrypted store, including one from older versions', async () => {
  // Stands in for app/preload.js's window.secretStore.
  const fakeSecretStore = () => {
    const values = { apiKey: '' };
    window.secretCalls = [];
    window.secretStore = {
      get: async (name) => ({ value: values[name], available: true }),
      set: async (name, value) => {
        window.secretCalls.push([name, value]);
        values[name] = value;
        return { persisted: true };
      },
    };
  };
  const { page, errors, close } = await openApp('', { apiKey: 'AIza-legacy-key' }, { script: fakeSecretStore });
  assert.deepEqual(await page.evaluate(() => window.secretCalls), [['apiKey', 'AIza-legacy-key']]);
  assert.ok(!(await webStorage(page)).includes('AIza-legacy-key'));
  await page.click('#openSettings');
  assert.equal(await page.textContent('#apiKeyStorage'), 'キーはこの端末に暗号化して保存されます。');
  await page.fill('#apiKey', 'AIza-new-key');
  await page.click('#settings button[value=ok]');
  await page.waitForFunction(() => window.secretCalls.length === 2);
  assert.deepEqual(await page.evaluate(() => window.secretCalls[1]), ['apiKey', 'AIza-new-key']);
  await saved(page);
  assert.ok(!(await webStorage(page)).includes('AIza-new-key'));
  assert.deepEqual(errors, []);
  await close();
});

test('when the desktop app cannot encrypt, settings say the key will be asked for again', async () => {
  const noEncryption = () => {
    window.secretStore = {
      get: async () => ({ value: '', available: false }),
      set: async () => ({ persisted: false }),
    };
  };
  const { page, errors, close } = await openApp('', { uiLang: 'en' }, { script: noEncryption });
  await page.click('#openSettings');
  assert.equal(
    await page.textContent('#apiKeyStorage'),
    'The key cannot be saved on this device; you will be asked for it again next time.',
  );
  await page.fill('#apiKey', 'AIza-unsaved-key');
  await page.click('#settings button[value=ok]');
  await saved(page);
  assert.ok(!(await webStorage(page)).includes('AIza-unsaved-key'));
  assert.deepEqual(errors, []);
  await close();
});

test('demo mode shows one long utterance as separate translated sentences', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('.seg:not(.live)').length >= 3);
  const done = (await rows(page)).filter((r) => !r.live);
  assert.equal(done[0].src, 'それでは本日の定例会議を始めます。');
  assert.equal(done[1].src, 'まず先週の進捗について共有をお願いします。');
  await page.waitForFunction(
    () => document.querySelector('.seg .tgt').textContent === "Let's begin today's regular meeting.",
  );
  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
  await close();
});

test('PC audio that is playing raises no warning', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false });
  await mockGemini(page, []);
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
  await page.click('#toggle');
  await page.waitForFunction(() => document.getElementById('statusText').textContent === '聞き取り中');
  await page.waitForTimeout(10_000);
  assert.ok(await page.locator('#toast').isHidden());
  await page.click('#toggle');
  await close();
});

// ---------- UI language ----------
test('icons are decorative Octicons and messages are inline banners with a variant', async () => {
  const { page, errors, close } = await openApp('?mock=1', { uiLang: 'en' });
  // Every icon-only button shows an SVG hidden from assistive tech and is named by its label.
  const iconButtons = await page.locator('button.icon-btn').evaluateAll((bs) =>
    bs.map((b) => ({
      label: b.getAttribute('aria-label'),
      text: b.textContent.trim(),
      svg: b.querySelector('svg')?.getAttribute('aria-hidden'),
    })),
  );
  assert.ok(iconButtons.length >= 6);
  for (const b of iconButtons) assert.deepEqual([!!b.label, b.text, b.svg], [true, '', 'true'], JSON.stringify(b));
  assert.equal(await page.textContent('#newSession'), 'New session');
  assert.equal(await page.textContent('#jump'), 'Latest');
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'info', 'the demo notice is informational');
  await page.click('#toggle');
  await page.waitForFunction(() => document.querySelectorAll('#sessionList .session').length === 1);
  const actions = await page
    .locator('#sessionList .act')
    .evaluateAll((bs) => bs.map((b) => [b.title, b.textContent, !!b.querySelector('svg')]));
  assert.deepEqual(actions, [
    ['Rename', '', true],
    ['Delete', '', true],
  ]);
  await page.locator('#sessionList .open').click({ force: true });
  await page.waitForFunction(() => document.getElementById('toast').dataset.variant === 'warning');
  assert.equal(await page.textContent('#toast'), 'Stop translating before switching sessions');
  assert.deepEqual(errors, []);
  await close();
});

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
  assert.equal(await optionText(page, '#otherInto', 'A'), 'Japanese (left language)');
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
  const { page, errors, close } = await openApp();
  await page.click('#swap');
  assert.equal(await page.inputValue('#langA'), 'en-US');
  await page.click('#openSettings');
  assert.equal(await page.inputValue('#otherInto'), 'B');
  assert.match(await optionText(page, '#otherInto', 'B'), /日本語/);
  assert.deepEqual(errors, []);
  await close();
});

test('the content security policy blocks requests to anywhere but the Gemini API', async () => {
  const { page, errors, close } = await openApp('?mock=1');
  const outcome = await page.evaluate(async () => {
    const tryFetch = (url) =>
      fetch(url).then(
        () => 'allowed',
        () => 'blocked',
      );
    const tryScript = () =>
      new Promise((resolve) => {
        const el = document.createElement('script');
        el.src = 'https://example.com/x.js';
        el.onload = () => resolve('allowed');
        el.onerror = () => resolve('blocked');
        document.head.append(el);
      });
    const inline = document.createElement('script');
    inline.textContent = 'window.inlineRan = true';
    document.head.append(inline);
    return {
      elsewhere: await tryFetch('https://example.com/collect'),
      script: await tryScript(),
      inline: !!window.inlineRan,
    };
  });
  assert.deepEqual(outcome, { elsewhere: 'blocked', script: 'blocked', inline: false });
  assert.ok(errors.filter((e) => /Content Security Policy/i.test(e)).length >= 3, 'each attempt is reported');
  await close();
});
