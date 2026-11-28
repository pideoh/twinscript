// Browser tests: PC audio (the desktop app on macOS without its own sound, on Windows the plain system loopback, a
// browser tab or screen, the permission guidance, the silent-audio warning, auto gain).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserOnly, fakeDisplayMedia, listening, mockGemini, setup } from './helpers.js';

const { openApp } = setup();

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
  await listening(page);
  await page.waitForTimeout(10_000);
  assert.ok(await page.locator('#toast').isHidden());
  await page.click('#toggle');
  await close();
});

test('the desktop app on macOS streams PC audio without picking up its own sound', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeDisplayMedia, arg: { desktopApp: 'mac' } },
  );
  const seen = { chunks: 0, peak: 0, bytes: 0 };
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      const pcm = Buffer.from(msg.realtimeInput.audio.data, 'base64');
      seen.chunks++;
      seen.bytes = pcm.length;
      for (let i = 0; i < pcm.length; i += 2) seen.peak = Math.max(seen.peak, Math.abs(pcm.readInt16LE(i)));
    });
  });
  await page.click('#toggle');
  await listening(page);
  await page.waitForTimeout(1500);
  assert.ok(seen.chunks >= 5, `audio chunks should be streamed, got ${seen.chunks}`);
  assert.equal(seen.bytes, 3200, '100 ms of 16 kHz 16-bit mono');
  assert.ok(seen.peak > 0x7fff * 0.3, `the tone should come through, peak ${seen.peak}`);
  await page.click('#toggle');
  const calls = await page.evaluate(() => window.displayMediaCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].audio.restrictOwnAudio, true);
  assert.ok(await page.locator('#toast').isHidden(), 'no silent-audio warning');
  assert.deepEqual(errors, []);
  await close();
});

test('the desktop app on Windows asks for the whole system sound, from every app', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'both', record: false },
    { script: fakeDisplayMedia, arg: { desktopApp: 'win' } },
  );
  await mockGemini(page, []);
  await page.click('#toggle');
  await listening(page);
  await page.click('#toggle');
  const calls = await page.evaluate(() => window.displayMediaCalls);
  assert.deepEqual(calls, [
    {
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
    },
  ]);
  assert.deepEqual(errors, []);
  await close();
});

test(
  'in a browser, sharing PC audio keeps the shared tab or screen sound as it is',
  browserOnly('the desktop app answers getDisplayMedia with its own system audio'),
  async () => {
    const { page, errors, close } = await openApp(
      '',
      { apiKey: 'test-key', source: 'system', record: false },
      { script: fakeDisplayMedia, arg: {} },
    );
    await mockGemini(page, []);
    await page.click('#toggle');
    await listening(page);
    await page.click('#toggle');
    const calls = await page.evaluate(() => window.displayMediaCalls);
    assert.deepEqual(calls, [
      {
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
      },
    ]);
    assert.deepEqual(errors, []);
    await close();
  },
);

const PERMISSION_PATH = '画面収録とシステムオーディオ録音 →「システムオーディオ録音のみ」で Twinscript を許可';

test('the desktop app on macOS explains the System Audio Recording permission when PC audio ends, and stops', async () => {
  const { page, errors, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeDisplayMedia, arg: { desktopApp: 'mac', endAfterMs: 500 } },
  );
  await mockGemini(page, []);
  await page.click('#toggle');
  await page.waitForFunction((path) => document.getElementById('toast').textContent.includes(path), PERMISSION_PATH);
  assert.match(await page.textContent('#toast'), /macOS 14\.2 以降が必要です/);
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'critical');
  assert.equal(await page.textContent('#toggle'), '翻訳開始');
  assert.equal(await page.textContent('#statusText'), '停止中');
  assert.deepEqual(errors, []);
  await close();
});

test(
  'PC audio that ends in a browser or the Windows app just says the audio input ended',
  browserOnly('it stands in for a browser, which the desktop app on macOS is not'),
  async () => {
    for (const desktopApp of [undefined, 'win']) {
      const { page, errors, close } = await openApp(
        '',
        { apiKey: 'test-key', source: 'system', record: false },
        { script: fakeDisplayMedia, arg: { desktopApp, endAfterMs: 500 } },
      );
      await mockGemini(page, []);
      await page.click('#toggle');
      await page.waitForFunction(() => document.getElementById('toast').textContent === '音声入力が終了しました');
      assert.equal(await page.textContent('#statusText'), '停止中');
      assert.deepEqual(errors, []);
      await close();
    }
  },
);

test('the desktop app on macOS points to the System Audio Recording permission when no PC audio arrives', async () => {
  const { page, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeDisplayMedia, arg: { desktopApp: 'mac', amplitude: 0 } },
  );
  await mockGemini(page, []);
  await page.click('#toggle');
  await listening(page);
  await page.waitForFunction((path) => document.getElementById('toast').textContent.includes(path), PERMISSION_PATH, {
    timeout: 15_000,
  });
  assert.match(await page.textContent('#toast'), /^PC音声が届いていません/);
  assert.equal(await page.getAttribute('#toast', 'data-variant'), 'warning');
  assert.equal(await page.textContent('#statusText'), '聞き取り中', 'a warning, the session goes on');
  await page.click('#toggle');
  await close();
});

test('very quiet PC audio is brought up to a usable level before it is transcribed', async () => {
  const { page, close } = await openApp(
    '',
    { apiKey: 'test-key', source: 'system', record: false },
    { script: fakeDisplayMedia, arg: { amplitude: 0.005 } },
  ); // about -46 dBFS
  const peaks = [];
  await page.routeWebSocket(/generativelanguage/, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw);
      if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      if (!msg.realtimeInput?.audio) return;
      const pcm = Buffer.from(msg.realtimeInput.audio.data, 'base64');
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      peaks.push(peak / 0x7fff);
    });
  });
  await page.click('#toggle');
  await listening(page);
  await page.waitForTimeout(5000);
  const settled = peaks.at(-1);
  assert.ok(settled > 0.1 && settled < 0.3, `0.005 in should come out near 0.15–0.2, got ${settled}`);
  await page.click('#toggle');
  await close();
});

test('PC audio that delivers nothing is reported instead of failing silently', async () => {
  const { page, close } = await openApp('', { apiKey: 'test-key', source: 'system', record: false });
  await mockGemini(page, []);
  // Stand in for a screen share whose audio track exists but never carries a sample.
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
  });
  await page.click('#toggle');
  await listening(page);
  assert.ok(await page.locator('#toast').isHidden(), 'no warning right away');
  await page.waitForFunction(
    () => document.getElementById('toast').textContent.includes('PC音声が届いていません'),
    null,
    { timeout: 15_000 },
  );
  await page.click('#toggle');
  await close();
});
