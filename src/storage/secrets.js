// Where the Gemini API key is kept. It is never written to localStorage.
// - Desktop app: window.secretStore (app/preload.js); the main process encrypts it with the
//   operating system's key store. If encryption is unavailable there, it is kept in memory only.
// - Browser (development, browser tests): in memory only, for the life of the page.
// DOM-free: the secret store is passed in.

const NAME = 'apiKey';

// How the key is kept; each has a help text in the settings dialog (settings.apiKey.storage.*).
export const KEY_STORAGE = Object.freeze({
  device: 'device', // encrypted on this device
  page: 'page', // until the page is closed (browser)
  none: 'none', // not saved: encryption unavailable in the desktop app
});

// legacy: an apiKey found in the old settings JSON (or undefined). It is moved into the secret
// store; the caller removes it from the settings JSON. Never throws.
export async function loadApiKey(secretStore, legacy) {
  const legacyKey = typeof legacy === 'string' ? legacy.trim() : '';
  if (!secretStore) return { key: legacyKey, storage: KEY_STORAGE.page };
  if (legacyKey) return { key: legacyKey, storage: await saveApiKey(secretStore, legacyKey) };
  try {
    const { value, available } = await secretStore.get(NAME);
    return { key: typeof value === 'string' ? value : '', storage: available ? KEY_STORAGE.device : KEY_STORAGE.none };
  } catch {
    return { key: '', storage: KEY_STORAGE.none };
  }
}

// Stores the key (an empty key deletes it) and tells how it is kept from now on. Never throws.
export async function saveApiKey(secretStore, key) {
  if (!secretStore) return KEY_STORAGE.page;
  try {
    const { persisted } = await secretStore.set(NAME, key);
    return persisted ? KEY_STORAGE.device : KEY_STORAGE.none;
  } catch {
    return KEY_STORAGE.none;
  }
}
