// Secret storage of the API key: the desktop store (app/secrets.js, tested without Electron) and
// the page's side (src/secrets.js).

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createSecretStore, isSecretName } from '../app/secrets.js';
import { KEY_STORAGE, loadApiKey, saveApiKey } from '../src/secrets.js';

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rt-secrets-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
const fileFor = () => join(dir, `secrets-${++n}.json`);
// Stands in for safeStorage: reversible, but not the plaintext.
const fakeEncryption = (overrides = {}) => ({
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decrypt: (bytes) => {
    const s = bytes.toString();
    if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
    return [...s.slice(4)].reverse().join('');
  },
  ...overrides,
});

test('a saved API key reads back, and the file holds only ciphertext', async () => {
  const file = fileFor();
  const store = createSecretStore({ file, encryption: fakeEncryption() });
  assert.deepEqual(await store.get('apiKey'), { value: '', available: true });
  assert.deepEqual(await store.set('apiKey', 'AIza-secret'), { persisted: true });
  assert.deepEqual(await store.get('apiKey'), { value: 'AIza-secret', available: true });
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('AIza-secret'));
  assert.equal(Buffer.from(JSON.parse(raw).apiKey, 'base64').toString(), 'enc:terces-azIA');
  // A new store on the same file (the next launch) sees it too.
  assert.equal((await createSecretStore({ file, encryption: fakeEncryption() }).get('apiKey')).value, 'AIza-secret');
});

test('the secrets file is readable by the owner only and no temporary file is left behind', async (t) => {
  if (process.platform === 'win32') return t.skip('file modes do not apply on Windows');
  const file = fileFor();
  await createSecretStore({ file, encryption: fakeEncryption() }).set('apiKey', 'k');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('saving an empty key deletes it', async () => {
  const file = fileFor();
  const store = createSecretStore({ file, encryption: fakeEncryption() });
  await store.set('apiKey', 'k');
  assert.deepEqual(await store.set('apiKey', ''), { persisted: true });
  assert.deepEqual(await store.get('apiKey'), { value: '', available: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {});
});

test('only known secret names are accepted', async () => {
  const file = fileFor();
  const store = createSecretStore({ file, encryption: fakeEncryption() });
  assert.equal(isSecretName('apiKey'), true);
  for (const name of ['other', '__proto__', 'constructor', '', undefined, 1]) {
    assert.equal(isSecretName(name), false);
    await assert.rejects(async () => store.get(name), /unknown secret/);
    await assert.rejects(async () => store.set(name, 'x'), /unknown secret/);
  }
  await assert.rejects(async () => store.set('apiKey', 42), /must be a string/);
  await assert.rejects(readFile(file), { code: 'ENOENT' }, 'nothing was written');
});

test('a corrupt secrets file reads as no key, and saving replaces it', async () => {
  for (const content of ['{not json', '[1,2]', 'null', '{"apiKey": 5}']) {
    const file = fileFor();
    await writeFile(file, content);
    const store = createSecretStore({ file, encryption: fakeEncryption() });
    assert.deepEqual(await store.get('apiKey'), { value: '', available: true }, content);
    await store.set('apiKey', 'fresh');
    assert.equal((await store.get('apiKey')).value, 'fresh');
  }
});

test('a key that cannot be decrypted reads as no key', async () => {
  const file = fileFor();
  await writeFile(file, JSON.stringify({ apiKey: Buffer.from('from another machine').toString('base64') }));
  const store = createSecretStore({ file, encryption: fakeEncryption() });
  assert.deepEqual(await store.get('apiKey'), { value: '', available: true });
});

test('without OS encryption nothing is written and the key is reported as not persisted', async () => {
  const file = fileFor();
  let encrypted = 0;
  const encryption = fakeEncryption({
    isAvailable: () => false,
    encrypt: () => {
      encrypted++;
      return Buffer.from('x');
    },
  });
  const store = createSecretStore({ file, encryption });
  assert.deepEqual(await store.set('apiKey', 'k'), { persisted: false });
  assert.deepEqual(await store.set('apiKey', ''), { persisted: false });
  assert.equal(encrypted, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('with no saved key, starting the app does not touch the system keychain', async () => {
  let asked = 0;
  const touch = () => {
    asked++;
    return true;
  };
  const encryption = fakeEncryption({ isAvailable: touch, decrypt: touch, encrypt: touch });
  const store = createSecretStore({ file: fileFor(), encryption });
  assert.deepEqual(await store.get('apiKey'), { value: '', available: true });
  assert.equal(asked, 0);
});

test('a saved key that can no longer be decrypted is reported as unavailable', async () => {
  const file = fileFor();
  await createSecretStore({ file, encryption: fakeEncryption() }).set('apiKey', 'k');
  const store = createSecretStore({ file, encryption: fakeEncryption({ isAvailable: () => false }) });
  assert.deepEqual(await store.get('apiKey'), { value: '', available: false });
});

test('a failed write or encryption reports the key as not persisted instead of throwing', async () => {
  const store = createSecretStore({ file: join(dir, 'missing-dir', 'secrets.json'), encryption: fakeEncryption() });
  assert.deepEqual(await store.set('apiKey', 'k'), { persisted: false });
  const broken = createSecretStore({
    file: fileFor(),
    encryption: fakeEncryption({
      encrypt: () => {
        throw new Error('keychain locked');
      },
    }),
  });
  assert.deepEqual(await broken.set('apiKey', 'k'), { persisted: false });
  assert.deepEqual(await broken.set('apiKey', 'k2'), { persisted: false }, 'later saves still run');
});

test('saves made one after another keep the last value', async () => {
  const store = createSecretStore({ file: fileFor(), encryption: fakeEncryption() });
  await Promise.all([store.set('apiKey', 'a'), store.set('apiKey', 'b'), store.set('apiKey', 'c')]);
  assert.equal((await store.get('apiKey')).value, 'c');
});

// ---------- the page's side ----------

// What window.secretStore looks like to the page, backed by an in-memory map.
function fakeSecretStore({ available = true } = {}) {
  const values = new Map();
  return {
    values,
    get: async (name) => ({ value: available ? (values.get(name) ?? '') : '', available }),
    set: async (name, value) => {
      if (!available) return { persisted: false };
      if (value) values.set(name, value);
      else values.delete(name);
      return { persisted: true };
    },
  };
}

test('in a browser the key is kept for the page only, including one found in old settings', async () => {
  assert.deepEqual(await loadApiKey(undefined, undefined), { key: '', storage: KEY_STORAGE.page });
  assert.deepEqual(await loadApiKey(undefined, ' old-key '), { key: 'old-key', storage: KEY_STORAGE.page });
  assert.equal(await saveApiKey(undefined, 'k'), KEY_STORAGE.page);
});

test('in the desktop app the key comes from the encrypted store', async () => {
  const store = fakeSecretStore();
  assert.deepEqual(await loadApiKey(store, undefined), { key: '', storage: KEY_STORAGE.device });
  assert.equal(await saveApiKey(store, 'k'), KEY_STORAGE.device);
  assert.deepEqual(await loadApiKey(store, undefined), { key: 'k', storage: KEY_STORAGE.device });
});

test('a key from old settings is moved into the encrypted store', async () => {
  const store = fakeSecretStore();
  store.values.set('apiKey', 'older');
  assert.deepEqual(await loadApiKey(store, 'legacy'), { key: 'legacy', storage: KEY_STORAGE.device });
  assert.equal(store.values.get('apiKey'), 'legacy');
});

test('when the desktop app cannot encrypt, the user is told the key is not saved', async () => {
  const store = fakeSecretStore({ available: false });
  assert.deepEqual(await loadApiKey(store, undefined), { key: '', storage: KEY_STORAGE.none });
  assert.deepEqual(await loadApiKey(store, 'legacy'), { key: 'legacy', storage: KEY_STORAGE.none });
  assert.equal(await saveApiKey(store, 'k'), KEY_STORAGE.none);
  const failing = { get: () => Promise.reject(new Error('ipc')), set: () => Promise.reject(new Error('ipc')) };
  assert.deepEqual(await loadApiKey(failing, undefined), { key: '', storage: KEY_STORAGE.none });
  assert.equal(await saveApiKey(failing, 'k'), KEY_STORAGE.none);
});
