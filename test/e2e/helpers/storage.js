// Reads saved sessions straight from IndexedDB.

// The saved sessions as read from IndexedDB, each with its segments (kept in their own store,
// one record per segment) put back in order.
export const storedSessions = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('twinscript');
        open.onsuccess = () => {
          const tx = open.result.transaction(['sessions', 'segments']);
          const sessions = tx.objectStore('sessions').getAll();
          const segments = tx.objectStore('segments').getAll();
          tx.oncomplete = () => {
            open.result.close();
            resolve(
              sessions.result.map((s) => ({
                ...s,
                segments: segments.result
                  .filter((x) => x.sessionId === s.id)
                  .map(({ sessionId, pos, ...segment }) => segment),
              })),
            );
          };
        };
      }),
  );
