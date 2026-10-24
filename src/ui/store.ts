/**
 * Keeps ROMs in IndexedDB (they are too big for localStorage), so a reload
 * finds everything where it was. One object store, three kinds of key:
 *
 *   1, 2            the cartridge in each slot
 *   "shelf:<name>"  every cartridge ever loaded, to pick again later
 *   "bios:<name>"   the player's own system ROMs (C-BIOS needs no entry)
 *   "tape"          the cassette in the tape deck, with what was recorded
 *   "diskrom:<name>" the player's own disk ROMs
 *   "disk"          the disk in the drive, with what was written
 *   "sram:<name>"   a cartridge's battery-backed RAM (its saved games)
 */

const DB = 'ok-prompt';
const STORE = 'cartridges';
const SHELF = 'shelf:';

export interface StoredCart {
  name: string;
  data: Uint8Array;
  mapper?: string;
  /** For an MSX2 BIOS: its SUB-ROM. */
  sub?: Uint8Array;
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

const BIOS = 'bios:';
export const saveBios = (bios: StoredCart) => put(BIOS + bios.name, bios);
export const removeBios = (name: string) => put(BIOS + name, null);
/** Every BIOS kept, the single one of earlier versions (key "bios") moved in. */
export const loadAllBios = async (): Promise<StoredCart[]> => {
  const old = await run<StoredCart>('readonly', (s) => s.get('bios'));
  if (old) {
    await saveBios(old);
    await put('bios', null);
  }
  const all = await run<StoredCart[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(BIOS, BIOS + '\uffff')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};

export const saveTape = (tape: StoredCart | null) => put('tape', tape);
export const loadTape = () => run<StoredCart>('readonly', (s) => s.get('tape'));

export const shelve = (cart: StoredCart) => put(SHELF + cart.name, cart);
export const unshelve = (name: string) => put(SHELF + name, null);
export const loadShelf = async (): Promise<StoredCart[]> => {
  const all = await run<StoredCart[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(SHELF, SHELF + '￿')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};

const DISKROM = 'diskrom:';
export const saveDiskRom = (rom: StoredCart) => put(DISKROM + rom.name, rom);
export const removeDiskRom = (name: string) => put(DISKROM + name, null);
export const loadAllDiskRoms = async (): Promise<StoredCart[]> => {
  const all = await run<StoredCart[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(DISKROM, DISKROM + '\uffff')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};

export const saveDisk = (disk: StoredCart | null) => put('disk', disk);
export const loadDisk = () => run<StoredCart>('readonly', (s) => s.get('disk'));

const SRAM = 'sram:';
export const saveSram = (name: string, data: Uint8Array) => put(SRAM + name, { name, data });
export const loadSram = async (name: string) => (await run<StoredCart>('readonly', (s) => s.get(SRAM + name)))?.data;
