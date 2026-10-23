/**
 * Keeps ROMs in IndexedDB (they are too big for localStorage), so a reload
 * finds everything where it was. One object store, three kinds of key:
 *
 *   1, 2            the cartridge in each slot
 *   "shelf:<name>"  every cartridge ever loaded, to pick again later
 *   "bios"          the player's own system ROM (C-BIOS needs no entry)
 */

const DB = 'ok-prompt';
const STORE = 'cartridges';
const SHELF = 'shelf:';

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
    return undefined; // private mode or blocked storage: nothing is remembered
  }
}

const put = (key: IDBValidKey, value: StoredCart | null) =>
  run<unknown>('readwrite', (s) => (value ? s.put(value, key) : s.delete(key)) as IDBRequest<unknown>);

export const saveCart = (slot: number, cart: StoredCart | null) => put(slot, cart);
export const loadCart = (slot: number) => run<StoredCart>('readonly', (s) => s.get(slot));

export const saveBios = (bios: StoredCart | null) => put('bios', bios);
export const loadBios = () => run<StoredCart>('readonly', (s) => s.get('bios'));

export const shelve = (cart: StoredCart) => put(SHELF + cart.name, cart);
export const unshelve = (name: string) => put(SHELF + name, null);
export const loadShelf = async (): Promise<StoredCart[]> => {
  const all = await run<StoredCart[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(SHELF, SHELF + '￿')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};
