// A small in-memory stand-in for IndexedDB, enough to run src/storage/store.js under node:test:
// open with an upgrade, object stores with a key path or auto-increment keys, indexes, get / getAll /
// put / add / delete by key or range, cursors, and transactions that complete once their requests
// are done. Writes apply at once (an aborted transaction is not rolled back) and values are
// copied in and out with structuredClone, as the real thing does. Not a full implementation:
// anything store.js does not use is left out.

const rank = (k) => (Array.isArray(k) ? 3 : typeof k === 'string' ? 2 : 1);

/** Compares two keys the way IndexedDB orders them: numbers, then strings, then arrays. */
export function compareKeys(a, b) {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (!Array.isArray(a)) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareKeys(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

class KeyRange {
  constructor(lower, upper) {
    this.lower = lower;
    this.upper = upper;
  }
  static bound(lower, upper) {
    return new KeyRange(lower, upper);
  }
  static only(value) {
    return new KeyRange(value, value);
  }
  includes(key) {
    return compareKeys(this.lower, key) <= 0 && compareKeys(key, this.upper) <= 0;
  }
}

const matches = (query, key) =>
  query === undefined || query === null
    ? true
    : query instanceof KeyRange
      ? query.includes(key)
      : !compareKeys(query, key);
const keyAt = (value, path) => (Array.isArray(path) ? path.map((p) => value[p]) : value[path]);

export function createFakeIndexedDB() {
  const databases = new Map(); // name -> { version, stores: Map(name -> { keyPath, autoIncrement, next, rows: Map, indexes }) }

  // A request whose result is computed and delivered in a later task, while the transaction waits.
  function request(tx, compute) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    tx.pending++;
    setTimeout(() => {
      try {
        req.result = compute();
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
      tx.settle();
    });
    return req;
  }

  function sortedRows(store) {
    return [...store.rows.entries()].sort(([a], [b]) => compareKeys(a, b));
  }

  function objectStore(tx, store) {
    const put = (value, mustBeNew) => {
      if (tx.mode === 'readonly') throw new Error('ReadOnlyError');
      const copy = structuredClone(value);
      let key = store.keyPath ? keyAt(copy, store.keyPath) : store.next++;
      if (store.keyPath && (key === undefined || (Array.isArray(key) && key.includes(undefined))))
        throw new Error('DataError: no key');
      key = structuredClone(key);
      const id = JSON.stringify(key);
      if (mustBeNew && store.rows.has(id)) throw new Error('ConstraintError');
      store.rows.set(id, { key, value: copy });
      return key;
    };
    const cursorOver = (rows, onEach) => {
      const req = { onsuccess: null, onerror: null, result: undefined };
      let i = 0;
      const step = () =>
        (request(tx, () => {
          const row = rows[i++];
          req.result = row ? onEach(row, step) : null;
          return req.result;
        }).onsuccess = () => req.onsuccess?.({ target: req }));
      step();
      return req;
    };
    return {
      put: (value) => request(tx, () => put(value, false)),
      add: (value) => request(tx, () => put(value, true)),
      get: (key) => request(tx, () => structuredClone(store.rows.get(JSON.stringify(key))?.value)),
      getAll: (query) =>
        request(tx, () =>
          sortedRows(store)
            .filter(([, row]) => matches(query, row.key))
            .map(([, row]) => structuredClone(row.value)),
        ),
      delete: (query) =>
        request(tx, () => {
          if (tx.mode === 'readonly') throw new Error('ReadOnlyError');
          for (const [id, row] of [...store.rows]) if (matches(query, row.key)) store.rows.delete(id);
        }),
      createIndex(name, keyPath) {
        store.indexes.set(name, keyPath);
      },
      index(name) {
        const path = store.indexes.get(name);
        const rowsFor = (query) =>
          sortedRows(store)
            .map(([id, row]) => ({ id, row, indexKey: keyAt(row.value, path) }))
            .filter((r) => matches(query, r.indexKey))
            .sort((a, b) => compareKeys(a.indexKey, b.indexKey));
        return {
          getAll: (query) => request(tx, () => rowsFor(query).map((r) => structuredClone(r.row.value))),
          openKeyCursor: (query) =>
            cursorOver(rowsFor(query), (r, step) => ({ key: r.indexKey, primaryKey: r.row.key, continue: step })),
        };
      },
      openCursor: () =>
        cursorOver(
          sortedRows(store).map(([, row]) => row),
          (row, step) => ({
            key: row.key,
            value: structuredClone(row.value),
            update: (value) => request(tx, () => put(value, false)),
            continue: step,
          }),
        ),
    };
  }

  function transaction(db, names, mode = 'readonly') {
    const list = [].concat(names);
    const tx = {
      mode,
      pending: 0,
      done: false,
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
      objectStore(name) {
        if (!list.includes(name) && mode !== 'versionchange') throw new Error(`NotFoundError: ${name} not in scope`);
        const store = db.stores.get(name);
        if (!store) throw new Error(`NotFoundError: no store ${name}`);
        return objectStore(tx, store);
      },
      settle() {
        if (--tx.pending > 0) return;
        setTimeout(() => {
          if (tx.pending || tx.done) return;
          tx.done = true;
          tx.oncomplete?.();
        });
      },
    };
    for (const name of list) if (!db.stores.has(name)) throw new Error(`NotFoundError: no store ${name}`);
    // A transaction with no request completes too.
    tx.pending++;
    setTimeout(() => tx.settle());
    return tx;
  }

  function connection(db) {
    return {
      get version() {
        return db.version;
      },
      get objectStoreNames() {
        const names = [...db.stores.keys()].sort();
        return Object.assign(names, { contains: (n) => db.stores.has(n) });
      },
      onversionchange: null,
      close() {},
      createObjectStore(name, { keyPath = null, autoIncrement = false } = {}) {
        if (db.stores.has(name)) throw new Error(`ConstraintError: ${name} exists`);
        const store = { keyPath, autoIncrement, next: 1, rows: new Map(), indexes: new Map() };
        db.stores.set(name, store);
        return objectStore(db.upgrading, store);
      },
      transaction: (names, mode) => transaction(db, names, mode),
    };
  }

  const indexedDB = {
    open(name, version) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null };
      setTimeout(() => {
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const target = version ?? Math.max(db.version, 1);
        if (target < db.version) {
          req.error = new Error('VersionError');
          return req.onerror?.({ target: req });
        }
        const conn = connection(db);
        req.result = conn;
        if (target === db.version) return req.onsuccess?.({ target: req });
        const oldVersion = db.version;
        db.version = target;
        const tx = transaction(db, [], 'versionchange');
        db.upgrading = tx;
        req.transaction = tx;
        tx.oncomplete = () => {
          db.upgrading = null;
          req.transaction = null;
          req.onsuccess?.({ target: req });
        };
        req.onupgradeneeded?.({ target: req, oldVersion, newVersion: target });
      });
      return req;
    },
  };

  return { indexedDB, IDBKeyRange: KeyRange };
}
