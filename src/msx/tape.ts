/**
 * Cassette tapes as .cas files. A .cas is the bytes the BIOS would read off
 * the tape, with each block (a file header or the data that follows it)
 * starting with an 8-byte marker at an offset that is a multiple of 8,
 * padded before it as needed:
 *
 *   1F A6 DE BA CC 13 7D 74
 *
 * A file's first block is 10 type bytes and a 6-character name:
 * D0 x 10 binary (BLOAD"CAS:",R), D3 x 10 tokenized BASIC (CLOAD),
 * EA x 10 ASCII text (RUN"CAS:" or LOAD"CAS:").
 *
 * The machine does not play the tape as sound: it catches the BIOS's tape
 * routines (TAPION, TAPIN, TAPOON, TAPOUT ...) and answers them from here,
 * as fMSX and openMSX do. Programs with their own turbo loaders, which read
 * the cassette input bit directly, do not load this way.
 */

export const CAS_MARKER = [0x1f, 0xa6, 0xde, 0xba, 0xcc, 0x13, 0x7d, 0x74];

export type TapeKind = 'binary' | 'basic' | 'ascii';

export class Tape {
  /** Where the next read or write happens. */
  pos = 0;
  /** Whether anything was recorded since it was inserted. */
  changed = false;
  private bytes: Uint8Array;
  private size: number;

  constructor(data: Uint8Array = new Uint8Array(0), readonly name = 'tape.cas') {
    this.bytes = data.slice();
    this.size = data.length;
  }

  get data(): Uint8Array {
    return this.bytes.subarray(0, this.size);
  }

  get length(): number {
    return this.size;
  }

  rewind(): void {
    this.pos = 0;
  }

  /** TAPION: moves past the next block marker; false at the end of the tape. */
  findBlock(): boolean {
    for (let p = (this.pos + 7) & ~7; p + 8 <= this.size; p += 8) {
      if (CAS_MARKER.every((b, i) => this.bytes[p + i] === b)) {
        this.pos = p + 8;
        return true;
      }
    }
    this.pos = this.size;
    return false;
  }

  /** TAPIN: the next byte, or -1 at the end of the tape. */
  readByte(): number {
    return this.pos < this.size ? this.bytes[this.pos++] : -1;
  }

  /** TAPOON: pads to a multiple of 8 and writes a block marker. */
  startBlock(): void {
    while (this.pos & 7) this.writeByte(0);
    for (const b of CAS_MARKER) this.writeByte(b);
  }

  /** TAPOUT: records a byte here; whatever came after it is gone, as on tape. */
  writeByte(value: number): void {
    if (this.pos >= this.bytes.length) {
      const grown = new Uint8Array(Math.max(1024, this.bytes.length * 2));
      grown.set(this.bytes.subarray(0, this.size));
      this.bytes = grown;
    }
    this.bytes[this.pos++] = value & 0xff;
    this.size = this.pos;
    this.changed = true;
  }

  /** The kind and name of the first file on the tape. */
  first(): { kind: TapeKind; name: string } | null {
    const t = new Tape(this.data);
    if (!t.findBlock()) return null;
    const head = [...t.data.subarray(t.pos, t.pos + 16)];
    if (head.length < 16) return null;
    const kinds: Record<number, TapeKind> = { 0xd0: 'binary', 0xd3: 'basic', 0xea: 'ascii' };
    const kind = kinds[head[0]];
    if (!kind || head.slice(0, 10).some((b) => b !== head[0])) return null;
    return { kind, name: String.fromCharCode(...head.slice(10)).trimEnd() };
  }
}

/** What to type in MSX BASIC to load and start a tape's first file. */
export function loadCommand(kind: TapeKind): string {
  switch (kind) {
    case 'binary': return 'BLOAD"CAS:",R\r';
    case 'basic': return 'CLOAD\rRUN\r';
    case 'ascii': return 'RUN"CAS:"\r';
  }
}

/**
 * A tape holding one BASIC program as text, as MSX BASIC's SAVE"CAS:" makes
 * it (and RUN"CAS:" or LOAD"CAS:" reads it): a header block (EAh x 10 and a
 * 6-character name), then the lines, CR LF after each, in blocks of 256
 * bytes, the last padded with 1Ah.
 */
export function asciiCas(name: string, text: string): Uint8Array {
  const out: number[] = [];
  const marker = () => { while (out.length & 7) out.push(0); out.push(...CAS_MARKER); };
  marker();
  out.push(...Array(10).fill(0xea));
  const n = name.toUpperCase().replace(/[^\x20-\x7e]/g, '').slice(0, 6).padEnd(6, ' ');
  for (const ch of n) out.push(ch.charCodeAt(0));
  const body = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n').replace(/\n/g, '\r\n');
  const bytes = [...body].map((ch) => (ch.charCodeAt(0) < 0x100 ? ch.charCodeAt(0) : 0x3f));
  bytes.push(0x1a);
  while (bytes.length % 256) bytes.push(0x1a);
  for (let i = 0; i < bytes.length; i += 256) {
    marker();
    out.push(...bytes.slice(i, i + 256));
  }
  return Uint8Array.from(out);
}

/**
 * A .tsx tape (TZX with MSX blocks, as made by makeTSX) as a .cas: the data
 * of each Kansas City block (ID 4Bh) after a marker. The other blocks (info,
 * pauses, ZX Spectrum speed blocks) carry nothing the BIOS reads and are
 * skipped. Throws if the file is not a TZX or holds no MSX data.
 */
export function tsxToCas(tsx: Uint8Array): Uint8Array<ArrayBuffer> {
  const sig = 'ZXTape!\x1a';
  if (tsx.length < 10 || [...sig].some((c, i) => tsx[i] !== c.charCodeAt(0))) throw new Error('not a .tsx tape');
  const w = (p: number) => tsx[p] | (tsx[p + 1] << 8);
  const t = (p: number) => w(p) | (tsx[p + 2] << 16);
  const d = (p: number) => (w(p) | (w(p + 2) << 16)) >>> 0;
  /** Length of a block's body after its ID byte, by TZX 1.20 (and 4Bh from TSX). */
  const size = (id: number, p: number): number => {
    switch (id) {
      case 0x10: return 4 + w(p + 2);
      case 0x11: return 18 + t(p + 15);
      case 0x12: return 4;
      case 0x13: return 1 + 2 * tsx[p];
      case 0x14: return 10 + t(p + 7);
      case 0x15: return 8 + t(p + 5);
      case 0x18: case 0x19: case 0x4b: return 4 + d(p);
      case 0x20: case 0x23: case 0x24: return 2;
      case 0x21: case 0x30: return 1 + tsx[p];
      case 0x22: case 0x25: case 0x27: return 0;
      case 0x26: return 2 + 2 * w(p);
      case 0x28: case 0x32: return 2 + w(p);
      case 0x2a: return 4;
      case 0x2b: return 5;
      case 0x31: return 2 + tsx[p + 1];
      case 0x33: return 1 + 3 * tsx[p];
      case 0x35: return 20 + d(p + 16);
      case 0x5a: return 9;
      default: return 4 + d(p); // TZX: unknown blocks start with a 4-byte length
    }
  };
  const out: number[] = [];
  let p = 10;
  while (p < tsx.length) {
    const id = tsx[p++];
    const n = size(id, p);
    if (id === 0x4b) {
      // length (4), pause (2), pilot, pulses, bit 0, bit 1 (2 each), two config bytes, then the data
      const data = tsx.subarray(p + 16, p + 4 + d(p));
      while (out.length & 7) out.push(0);
      out.push(...CAS_MARKER, ...data);
    }
    p += n;
  }
  if (!out.length) throw new Error('no MSX data on this .tsx');
  return Uint8Array.from(out);
}
