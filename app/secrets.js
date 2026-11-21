// Secrets of the desktop app (the Gemini API key), encrypted by the operating system through
// Electron's safeStorage (Keychain on macOS, DPAPI on Windows) and kept as base64 ciphertext in a
// JSON file under userData. No Electron imports: main.js passes safeStorage in, so this can be
// unit-tested with node:test.
import * as nodeFs from 'node:fs/promises';

// The only names the page may read or write.
export const SECRET_NAMES = Object.freeze(['apiKey']);

export const isSecretName = (name) => typeof name === 'string' && SECRET_NAMES.includes(name);

// file: path of the JSON file. encryption: { isAvailable(), encrypt(string) -> Buffer,
// decrypt(Buffer) -> string } (safeStorage's isEncryptionAvailable / encryptString / decryptString).
// fs: readFile / writeFile / rename (node:fs/promises by default).
//
// get(name) -> { value, available }: value is '' when nothing usable is stored (no file, a corrupt
//   file, a failed decryption, or encryption unavailable). Never throws for those. With nothing
//   stored the system is not asked, and available is true; set() reports the real state.
// set(name, value) -> { persisted }: an empty value deletes the entry. When encryption is not
//   available nothing is written to disk and persisted is false.
// Both throw only for a name outside SECRET_NAMES or a value that is not a string.
export function createSecretStore({ file, encryption, fs = nodeFs }) {
  let queue = Promise.resolve(); // writes run one after another, so none is lost

  const available = () => {
    try {
      return !!encryption.isAvailable();
    } catch {
      return false;
    }
  };

  async function readAll() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {}; // missing or corrupt: nothing stored
    }
  }

  async function writeAll(data) {
    // Written next to the target and renamed over it, so a crash never leaves half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  function check(name) {
    if (!isSecretName(name)) throw new Error('unknown secret');
  }

  async function get(name) {
    check(name);
    // The file is read first: asking the system about encryption opens the Keychain on macOS,
    // which can prompt, so it only happens once there is something to decrypt.
    const stored = (await readAll())[name];
    if (typeof stored !== 'string' || !stored) return { value: '', available: true };
    if (!available()) return { value: '', available: false };
    try {
      return { value: String(encryption.decrypt(Buffer.from(stored, 'base64'))), available: true };
    } catch {
      return { value: '', available: true }; // e.g. encrypted by another user or machine
    }
  }

  function set(name, value) {
    check(name);
    if (typeof value !== 'string') throw new Error('secret must be a string');
    if (!available()) return Promise.resolve({ persisted: false });
    const run = queue.then(async () => {
      const data = await readAll();
      if (value) data[name] = Buffer.from(encryption.encrypt(value)).toString('base64');
      else delete data[name];
      await writeAll(data);
      return { persisted: true };
    });
    queue = run.catch(() => {});
    return run.catch(() => ({ persisted: false }));
  }

  return { get, set };
}
