// IndexedDB の薄いラッパー。ファイルとメタ情報 (同期位置など) を保存する
const DB_NAME = 'txtedit';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files', { keyPath: 'id' });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  allFiles: () => tx('files', 'readonly', (s) => s.getAll()),
  putFile: (f) => tx('files', 'readwrite', (s) => s.put(f)),
  deleteFile: (id) => tx('files', 'readwrite', (s) => s.delete(id)),
  getMeta: (k) => tx('meta', 'readonly', (s) => s.get(k)),
  setMeta: (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k)),
  async clear() {
    await tx('files', 'readwrite', (s) => s.clear());
    await tx('meta', 'readwrite', (s) => s.clear());
  },
};
