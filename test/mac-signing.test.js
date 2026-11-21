import assert from 'node:assert/strict';
import { test } from 'node:test';
import afterSign, { signingPlan } from '../scripts/sign-mac.js';
import { checkRequirement } from '../scripts/verify-mac-signature.js';

const ID = 'io.github.pideoh.twinscript';

test('the helper in Resources is signed before the app that seals it', () => {
  const plan = signingPlan({
    appPath: '/out/Twinscript.app',
    identity: 'ABC123',
    helperIdentifier: `${ID}.system-audio`,
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].at(-1), '/out/Twinscript.app/Contents/Resources/system-audio');
  assert.ok(plan[0].includes(`${ID}.system-audio`));
  assert.equal(plan[1].at(-1), '/out/Twinscript.app');
  assert.ok(plan[1].includes('--deep'));
  for (const args of plan) assert.deepEqual(args.slice(0, 4), ['--force', '--timestamp=none', '--sign', 'ABC123']);
});

test('the hook does nothing without a certificate or on other platforms', async () => {
  const saved = process.env.MAC_SIGN_IDENTITY;
  delete process.env.MAC_SIGN_IDENTITY;
  try {
    await afterSign({
      electronPlatformName: 'darwin',
      appOutDir: '/nonexistent',
      packager: { appInfo: { id: ID, productFilename: 'Twinscript' } },
    });
    process.env.MAC_SIGN_IDENTITY = 'X';
    await afterSign({
      electronPlatformName: 'win32',
      appOutDir: '/nonexistent',
      packager: { appInfo: { id: ID, productFilename: 'Twinscript' } },
    });
  } finally {
    if (saved === undefined) delete process.env.MAC_SIGN_IDENTITY;
    else process.env.MAC_SIGN_IDENTITY = saved;
  }
});

test('a certificate-based requirement is accepted', () => {
  const out = `Executable=/x/Twinscript.app/Contents/MacOS/Twinscript\ndesignated => identifier "${ID}" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"\n`;
  assert.deepEqual(checkRequirement(out, ID), {
    ok: true,
    requirement: `identifier "${ID}" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"`,
  });
});

test('an ad hoc requirement is rejected because it changes with every build', () => {
  const result = checkRequirement('designated => cdhash H"aabbccddeeff00112233445566778899aabbccdd"\n', ID);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ad hoc/);
});

test('another identifier, another form or no requirement is rejected', () => {
  const hash = 'H"0123456789abcdef0123456789abcdef01234567"';
  assert.equal(
    checkRequirement(`designated => identifier "com.other.app" and certificate leaf = ${hash}\n`, ID).ok,
    false,
  );
  assert.equal(checkRequirement(`designated => identifier "${ID}" and anchor apple generic\n`, ID).ok, false);
  assert.equal(
    checkRequirement(`designated => identifier "io.github.pideoh.twinscriptX" and certificate leaf = ${hash}\n`, ID).ok,
    false,
  );
  assert.equal(checkRequirement('Executable=/x\n', ID).ok, false);
});
