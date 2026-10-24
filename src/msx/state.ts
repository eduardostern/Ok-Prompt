/**
 * Save states: a chip's plain data, copied out and put back. Every chip
 * keeps its state in fields of numbers, flags, typed arrays (memories,
 * registers), arrays of those and small plain records, so `grab` copies
 * exactly those and leaves the rest (callbacks, links to other parts, ROMs
 * held elsewhere) to the machine. `put` writes typed arrays back in place,
 * since other parts may hold them (the V9938's VRAM is the command
 * engine's too). What comes out is structured-clonable, for IndexedDB.
 */

export type ChipState = Record<string, unknown>;

const isView = (v: unknown): v is ArrayBufferView & { slice(): unknown; length: number } =>
  ArrayBuffer.isView(v) && !(v instanceof DataView);

/** A copy of plain data, or undefined for anything else (objects of classes, functions). */
function copy(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (isView(v)) return v.slice();
  if (Array.isArray(v)) {
    const out = v.map(copy);
    return out.includes(undefined) ? undefined : out;
  }
  if (Object.getPrototypeOf(v) === Object.prototype) {
    const out: ChipState = {};
    for (const [k, x] of Object.entries(v)) {
      const c = copy(x);
      if (c === undefined) return undefined;
      out[k] = c;
    }
    return out;
  }
  return undefined;
}

/** The plain-data fields of `o`, copied, but for `skip`. */
export function grab(o: object, skip: string[] = []): ChipState {
  const out: ChipState = {};
  for (const [k, v] of Object.entries(o)) {
    if (skip.includes(k)) continue;
    const c = copy(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Writes a grabbed state back into `o`: typed arrays in place (same length), the rest assigned. */
export function put(o: object, state: ChipState): void {
  const target = o as Record<string, unknown>;
  for (const [k, v] of Object.entries(state)) {
    const cur = target[k];
    if (isView(cur) && isView(v) && cur.length === v.length) {
      (cur as unknown as Uint8Array).set(v as unknown as Uint8Array);
    } else if (Array.isArray(cur) && Array.isArray(v) && cur.length === v.length && cur.some(isView)) {
      v.forEach((x, i) => {
        if (isView(cur[i]) && isView(x)) (cur[i] as Uint8Array).set(x as unknown as Uint8Array);
        else cur[i] = copy(x);
      });
    } else {
      target[k] = copy(v);
    }
  }
}
