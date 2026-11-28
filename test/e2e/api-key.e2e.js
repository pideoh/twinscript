// Browser tests: asking for the API key and where it is kept (browser memory, the desktop encrypted store,
// keys from older versions, encryption unavailable).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserOnly, reload, saved, setup } from './helpers.js';

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

test(
  'in a browser the API key entered in settings stays in memory and never reaches storage',
  browserOnly('the desktop app keeps the key in its encrypted store'),
  async () => {
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
  },
);

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
  // Stands in for app/preload.js's window.secretStore (in the desktop app, behind the real one).
  const fakeSecretStore = () => {
    const values = { apiKey: '' };
    window.secretCalls = [];
    window.__e2eStandIn('secretStore', {
      get: async (name) => ({ value: values[name], available: true }),
      set: async (name, value) => {
        window.secretCalls.push([name, value]);
        values[name] = value;
        return { persisted: true };
      },
    });
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
    window.__e2eStandIn('secretStore', {
      get: async () => ({ value: '', available: false }),
      set: async () => ({ persisted: false }),
    });
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
