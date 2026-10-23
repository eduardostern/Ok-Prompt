/**
 * Keeps the inserted cartridges in IndexedDB (ROMs are too big for
 * localStorage), so a reload finds the game still in its slot.
 */

const DB = 'ok-prompt';
const STORE = 'cartridges';

export interface StoredCart {
  name: string;
  data: Uint8Array;
  mapper?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // private mode or blocked storage: the slot just starts empty
  }
}

export const saveCart = (slot: number, cart: StoredCart | null) =>
  run<unknown>('readwrite', (s) => (cart ? s.put(cart, slot) : s.delete(slot)) as IDBRequest<unknown>);

export const loadCart = (slot: number) => run<StoredCart>('readonly', (s) => s.get(slot));
