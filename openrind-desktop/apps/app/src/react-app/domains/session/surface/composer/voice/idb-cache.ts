// IndexedDB-backed cache for Transformers.js model files.
//
// Transformers.js normally caches model weights via the Cache Storage API, but
// that API does NOT persist under Electron's opaque `file://` origin used by
// packaged builds — so the ~140MB Whisper weights would re-download on every
// launch. IndexedDB *does* persist under `file://` (and in Web Workers), so we
// implement the small `CacheInterface` (match/put) that Transformers.js expects
// and point env.customCache at it. Result: weights download once, then work
// offline. All entirely on-device — no network proxy, no main-process code.

const DB_NAME = "openrind-desktop-voice-cache";
const STORE = "models";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function readEntry(key: string): Promise<Blob | undefined> {
  return getDb().then(
    (db) =>
      new Promise<Blob | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as Blob | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function writeEntry(key: string, value: Blob): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export const indexedDbModelCache = {
  async match(request: string): Promise<Response | undefined> {
    try {
      const blob = await readEntry(request);
      return blob ? new Response(blob) : undefined;
    } catch {
      return undefined;
    }
  },
  async put(request: string, response: Response): Promise<void> {
    try {
      // clone() so Transformers.js can still read the original response body.
      const blob = await response.clone().blob();
      await writeEntry(request, blob);
    } catch {
      // Caching is best-effort: a failure just means a re-download next time.
    }
  },
};
