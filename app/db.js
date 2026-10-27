// Persistent storage (IndexedDB) for subscriptions and their cached films.
//
// 'feeds' holds one record per subscription, keyed by feed URL:
//   { url, name, path, kind, items, fetchedAt, attemptedAt, error }
// 'history' holds one record per watched film, keyed by film link:
//   { link, movie: { title, link, description }, watchedAt }
// 'meta' holds small key/value settings.

const DB_NAME = 'rssflicks';

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('feeds')) db.createObjectStore('feeds', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'link' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAllFeeds = () => run('feeds', 'readonly', (s) => s.getAll());
export const putFeed = (feed) => run('feeds', 'readwrite', (s) => s.put(feed));
export const deleteFeed = (url) => run('feeds', 'readwrite', (s) => s.delete(url));
export const getAllHistory = () => run('history', 'readonly', (s) => s.getAll());
export const putHistory = (entry) => run('history', 'readwrite', (s) => s.put(entry));
export const deleteHistory = (link) => run('history', 'readwrite', (s) => s.delete(link));
export const clearHistory = () => run('history', 'readwrite', (s) => s.clear());
export const getMeta = (key) => run('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put(value, key));

// Asks the browser not to evict the data under storage pressure.
export async function requestPersistence() {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Best effort only.
  }
}
