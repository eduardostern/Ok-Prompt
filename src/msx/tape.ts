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
