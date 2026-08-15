/**
 * Minimal typed IndexedDB wrapper for handing a capture from the popup to the
 * editor tab. IndexedDB is used instead of chrome.storage.session because
 * session storage caps at 10MB and full-page PNG data URLs can exceed that.
 *
 * One object store, `pending-edits`, keyed by an id that travels in the
 * editor's URL query string.
 */

import type { PendingEditPayload } from '../types/editor';

const DB_NAME = 'snapscribe';
const DB_VERSION = 1;
const STORE = 'pending-edits';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Store a capture for the editor to pick up. */
export async function savePendingEdit(payload: PendingEditPayload): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save pending edit'));
    });
  } finally {
    db.close();
  }
}

/** Read and delete a pending edit in one step — each payload is single-use. */
export async function takePendingEdit(id: string): Promise<PendingEditPayload | undefined> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const payload = await requestToPromise(
      store.get(id) as IDBRequest<PendingEditPayload | undefined>,
    );
    if (payload) store.delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to read pending edit'));
    });
    return payload;
  } finally {
    db.close();
  }
}

/** Clear any orphaned pending edits (e.g. when the editor tab was closed). */
export async function clearPendingEdits(): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear pending edits'));
    });
  } finally {
    db.close();
  }
}
