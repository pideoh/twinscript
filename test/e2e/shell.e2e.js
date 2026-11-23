// Browser tests: the page as a whole (demo mode, icons and banners, the content security policy).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rows, setup } from './helpers.js';

const { openApp } = setup();

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
  // Each translation is led by the code of its language, as with three languages.
  await page.waitForFunction(() => document.querySelectorAll('#log .seg:not(.live) .tgt[data-lang="JA"]').length > 0);
  const codes = await page
    .locator('#log .seg:not(.live) .tgt')
    .evaluateAll((ts) => ts.slice(0, 3).map((t) => t.dataset.lang));
  assert.deepEqual(codes, ['EN', 'EN', 'JA']);
  const spoken = await page
    .locator('#log .seg:not(.live) .src')
    .evaluateAll((ss) => ss.slice(0, 3).map((x) => x.dataset.lang));
  assert.deepEqual(spoken, ['JA', 'JA', 'EN'], 'and each source by the code of the language spoken');
  await page.click('#toggle');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
  await close();
});

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
