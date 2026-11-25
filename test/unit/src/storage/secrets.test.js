import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_STORAGE, loadApiKey, saveApiKey } from '../../../../src/storage/secrets.js';
import { withGlobals } from '../../../support/globals.js';

// The desktop bridge (window.secretStore): remembers values, like the main process would.
function fakeSecretStore({ available = true, failWith } = {}) {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    async get(name) {
      calls.push(['get', name]);
      if (failWith) throw failWith;
      return { value: values.get(name) ?? null, available };
    },
    async set(name, value) {
      calls.push(['set', name, value]);
      if (failWith) throw failWith;
      if (value) values.set(name, value);
      else values.delete(name);
      return { persisted: available };
    },
  };
}

test('in the desktop app the key is stored through the secret store and read back from it', async () => {
  const store = fakeSecretStore();
  assert.equal(await saveApiKey(store, 'AIza-1'), KEY_STORAGE.device);
  assert.deepEqual(await loadApiKey(store), { key: 'AIza-1', storage: KEY_STORAGE.device });
  assert.deepEqual(store.calls[0], ['set', 'apiKey', 'AIza-1']);
});

test('saving an empty key deletes the stored one', async () => {
  const store = fakeSecretStore();
  await saveApiKey(store, 'AIza-1');
  await saveApiKey(store, '');
  assert.equal(store.values.has('apiKey'), false);
  assert.deepEqual(await loadApiKey(store), { key: '', storage: KEY_STORAGE.device });
});

test('when the desktop app cannot encrypt, the key works for now and the user is told it is not saved', async () => {
  const store = fakeSecretStore({ available: false });
  assert.equal(await saveApiKey(store, 'AIza-1'), KEY_STORAGE.none);
  assert.equal((await loadApiKey(store)).storage, KEY_STORAGE.none);
});

test('a failing secret store never throws: nothing is saved and nothing is found', async () => {
  const store = fakeSecretStore({ failWith: new Error('ipc closed') });
  assert.equal(await saveApiKey(store, 'AIza-1'), KEY_STORAGE.none);
  assert.deepEqual(await loadApiKey(store), { key: '', storage: KEY_STORAGE.none });
});

test('a stored value that is not text is ignored when loading', async () => {
  const store = { get: async () => ({ value: 42, available: true }) };
  assert.deepEqual(await loadApiKey(store), { key: '', storage: KEY_STORAGE.device });
});

test('a key left in the old settings is moved into the secret store', async () => {
  const store = fakeSecretStore();
  const loaded = await loadApiKey(store, '  AIza-old  ');
  assert.deepEqual(loaded, { key: 'AIza-old', storage: KEY_STORAGE.device });
  assert.equal(store.values.get('apiKey'), 'AIza-old', 'trimmed, and stored');
});

test('an old key is still usable when the secret store fails to take it', async () => {
  const store = fakeSecretStore({ failWith: new Error('boom') });
  assert.deepEqual(await loadApiKey(store, 'AIza-old'), { key: 'AIza-old', storage: KEY_STORAGE.none });
});

test('a blank or non-text old key is ignored in favour of the stored one', async () => {
  const store = fakeSecretStore();
  store.values.set('apiKey', 'AIza-stored');
  for (const legacy of ['   ', undefined, null, 7]) {
    assert.equal((await loadApiKey(store, legacy)).key, 'AIza-stored');
  }
});

test('in a browser the key lives in the page only', async () => {
  assert.equal(await saveApiKey(undefined, 'AIza-1'), KEY_STORAGE.page);
  assert.deepEqual(await loadApiKey(undefined, undefined), { key: '', storage: KEY_STORAGE.page });
  assert.deepEqual(await loadApiKey(null, ' AIza-old '), { key: 'AIza-old', storage: KEY_STORAGE.page });
});

test('the key is never written to localStorage, with or without the secret store', async () => {
  const writes = [];
  const localStorage = {
    setItem: (...a) => writes.push(a),
    getItem: () => null,
    removeItem: () => {},
  };
  const stores = [
    fakeSecretStore(),
    fakeSecretStore({ available: false }),
    fakeSecretStore({ failWith: new Error('x') }),
    undefined,
  ];
  await withGlobals({ localStorage }, async () => {
    for (const store of stores) {
      await saveApiKey(store, 'AIza-secret');
      await loadApiKey(store, 'AIza-legacy');
    }
  });
  assert.deepEqual(writes, []);
});
