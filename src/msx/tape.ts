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
 * Two ways in. The machine catches the BIOS's tape routines (TAPION,
 * TAPIN, TAPOON, TAPOUT ...) and answers them from the bytes, at once, as
 * fMSX does. Programs with their own loaders read the cassette input bit
 * instead: while the motor runs, the tape plays its signal (tape-signal.ts),
 * a .tsx with its own timing. Both share one place on the tape, so a game
 * can load its loader through the BIOS and the rest by itself.
 */

import { casSignal, parseTsx, Signal } from './tape-signal';

export const CAS_MARKER = [0x1f, 0xa6, 0xde, 0xba, 0xcc, 0x13, 0x7d, 0x74];

export type TapeKind = 'binary' | 'basic' | 'ascii';

export interface TapeState {
  name: string;
  file: Uint8Array;
  pos: number;
  changed: boolean;
  time: number;
  lastCycle: number;
  byTime: boolean;
}

export class Tape {
  /** Where the next read or write happens, in the .cas bytes. */
  pos = 0;
  /** Whether anything was recorded since it was inserted. */
  changed = false;
  private bytes: Uint8Array;
  private size: number;
  /** The .tsx it came from, while nothing was recorded over it. */
  private tsx: Uint8Array | null = null;
  private played: Signal | null = null;
  /**
   * Tape time (CPU cycles) for the signal, and the CPU cycle it was last
   * brought up to. `byTime` says which cursor is current: the signal's
   * (a loader reading the input bit) or `pos` (the BIOS tape routines).
   */
  private time = 0;
  private lastCycle = 0;
  private byTime = false;

  /** A .cas, or a .tsx (kept for its timing). */
  constructor(data: Uint8Array = new Uint8Array(0), readonly name = 'tape.cas') {
    if (isTsx(data)) {
      const { cas, signal } = parseTsx(data);
      this.tsx = data.slice();
      this.played = signal;
      data = cas;
    }
    this.bytes = data.slice();
    this.size = data.length;
  }

  /** The tape as .cas bytes. */
  get data(): Uint8Array {
    return this.bytes.subarray(0, this.size);
  }

  get length(): number {
    return this.size;
  }

  /** The tape as a file to download: the .tsx as it came, or a .cas once recorded on. */
  file(): { name: string; data: Uint8Array } {
    if (this.tsx) return { name: this.name, data: this.tsx };
    return { name: this.name.replace(/\.tsx$/i, '.cas'), data: this.data };
  }

  /** How far through the tape it is, 0 to 1. */
  get progress(): number {
    if (this.byTime) return Math.min(1, this.time / Math.max(1, this.signal.end));
    return this.size ? this.pos / this.size : 0;
  }

  rewind(): void {
    this.pos = 0;
    this.time = 0;
    this.byTime = false;
  }

  /** The pulses of this tape (a .cas gets the BIOS's 1200-baud timing). */
  get signal(): Signal {
    return (this.played ??= casSignal(this.data));
  }

  /** Runs the tape up to CPU cycle `cycles`; it moves only while the motor is on. */
  advance(cycles: number, motor: boolean): void {
    if (motor && this.byTime) this.time += cycles - this.lastCycle;
    this.lastCycle = cycles;
  }

  /** The machine's frame ended: its cycle count starts again from 0. */
  rebase(by: number): void {
    this.lastCycle -= by;
  }

  /** The level on the cassette input (PSG R14 bit 7) at CPU cycle `cycles`. */
  level(cycles: number, motor: boolean): number {
    if (!this.byTime) {
      // The BIOS routines read up to `pos`: play on from there.
      this.time = this.signal.timeOfPos(this.pos);
      this.byTime = true;
      this.lastCycle = cycles;
    }
    this.advance(cycles, motor);
    return this.signal.level(this.time);
  }

  /** Before the BIOS routines: `pos` catches up with what the signal played. */
  private toBytes(): void {
    if (!this.byTime) return;
    this.pos = this.signal.posOfTime(this.time, this.size);
    this.byTime = false;
  }

  /** TAPION: moves past the next block marker; false at the end of the tape. */
  findBlock(): boolean {
    this.toBytes();
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
    this.toBytes();
    return this.pos < this.size ? this.bytes[this.pos++] : -1;
  }

  /** TAPOON: pads to a multiple of 8 and writes a block marker. */
  startBlock(): void {
    this.toBytes();
    while (this.pos & 7) this.writeByte(0);
    for (const b of CAS_MARKER) this.writeByte(b);
  }

  /** TAPOUT: records a byte here; whatever came after it is gone, as on tape. */
  writeByte(value: number): void {
    this.toBytes();
    if (this.pos >= this.bytes.length) {
      const grown = new Uint8Array(Math.max(1024, this.bytes.length * 2));
      grown.set(this.bytes.subarray(0, this.size));
      this.bytes = grown;
    }
    this.bytes[this.pos++] = value & 0xff;
    this.size = this.pos;
    this.changed = true;
    // Recorded over: the tape is a .cas now, played at the BIOS's speed.
    this.tsx = null;
    this.played = null;
  }

  /** For save states: the tape and where it is. */
  saveState(): TapeState {
    const f = this.file();
    return {
      name: this.name, file: f.data.slice(), pos: this.pos, changed: this.changed,
      time: this.time, lastCycle: this.lastCycle, byTime: this.byTime,
    };
  }

  static fromState(s: TapeState): Tape {
    const t = new Tape(s.file, s.name);
    t.pos = s.pos;
    t.changed = s.changed;
    t.time = s.time;
    t.lastCycle = s.lastCycle;
    t.byTime = s.byTime;
    return t;
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
 * The .cas inside a .tsx tape (TZX with MSX blocks, as made by makeTSX): the
 * data of each MSX block (ID 4Bh) after a marker. Throws if the file is not
 * a TZX or holds no MSX data.
 */
export function tsxToCas(tsx: Uint8Array): Uint8Array<ArrayBuffer> {
  const { cas } = parseTsx(tsx);
  if (!cas.length) throw new Error('no MSX data on this .tsx');
  return cas;
}

/** Whether these bytes are a .tsx (TZX) file. */
export function isTsx(data: Uint8Array): boolean {
  return [...'ZXTape!'].every((c, i) => data[i] === c.charCodeAt(0));
}
