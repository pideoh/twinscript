// Persistence in IndexedDB: sessions (with their segments) and recorded audio chunks.

const DB_NAME = 'realtime-translate';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const audio = db.createObjectStore('audio', { autoIncrement: true });
      audio.createIndex('recording', ['sessionId', 'recId']);
      audio.createIndex('session', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function write(stores, fn) {
  const tx = (await open()).transaction(stores, 'readwrite');
  fn(tx);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const store = {
  // Newest first.
  async listSessions() {
    const all = await done((await open()).transaction('sessions').objectStore('sessions').getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  saveSession(session) {
    return write('sessions', (tx) => tx.objectStore('sessions').put(session));
  },

  deleteSession(id) {
    return write(['sessions', 'audio'], (tx) => {
      tx.objectStore('sessions').delete(id);
      const audio = tx.objectStore('audio');
      audio.index('session').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        audio.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  },

  addAudioChunk(sessionId, recId, blob) {
    return write('audio', (tx) => tx.objectStore('audio').add({ sessionId, recId, blob }));
  },

  // Chunks of one recording, in the order they were recorded.
  async getAudioChunks(sessionId, recId) {
    const index = (await open()).transaction('audio').objectStore('audio').index('recording');
    return (await done(index.getAll(IDBKeyRange.only([sessionId, recId])))).map((row) => row.blob);
  },

  // Ask the browser not to evict our data under storage pressure.
  requestPersistence() {
    navigator.storage?.persist?.().catch(() => {});
  },
};
