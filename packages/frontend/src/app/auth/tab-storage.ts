import type { KeyValueStorage } from './portal-auth-model';

/** In-memory fallback if `sessionStorage` is blocked (privacy mode, sandboxed frames). */
export function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** The tab's `sessionStorage`, or an in-memory store if it is not accessible. */
export function tabStorage(document: Document): KeyValueStorage {
  try {
    const storage = document.defaultView?.sessionStorage;
    if (storage) return storage;
  } catch {
    // Access to sessionStorage can throw (blocked storage); fall through.
  }
  return memoryStorage();
}
