/**
 * A tape as a signal: the pulses a cassette player would play, timed in MSX
 * CPU cycles. A .tsx brings its own (its blocks give every pulse length, in
 * ZX Spectrum T-states at 3.5 MHz); a .cas gets the timing the MSX BIOS
 * writes at 1200 baud. The level flips at the end of every pulse and is low
 * during pauses. Games with their own loaders read it on PSG register 14,
 * bit 7, while the motor runs (tape.ts, machine.ts).
 *
 * MSX tapes are FSK: a 0 bit is one cycle at 1200 Hz (two pulses), a 1 bit
 * two cycles at 2400 Hz (four pulses), each byte a 0 start bit, eight bits
 * low first and two 1 stop bits, each block after a pilot tone at 2400 Hz.
 */
import { CAS_MARKER } from './tape';

const MSX_CLOCK = 3_579_545;
/** ZX T-states to MSX CPU cycles. */
const ZX = MSX_CLOCK / 3_500_000;
const MS = MSX_CLOCK / 1000;

/** How a data block's bytes become pulses. Lengths in MSX cycles. */
interface Bits {
  len0: number;
  len1: number;
  /** Pulses per 0 bit and per 1 bit. */
  n0: number;
  n1: number;
  start: number;
  startVal: number;
  stop: number;
  stopVal: number;
  msbFirst: boolean;
  /** Bits used in the last byte (ZX blocks), else 8. */
  lastBits: number;
}

interface Base { t0: number; t1: number; level0: number }
type Seg =
  | (Base & { kind: 'pause' })
  | (Base & { kind: 'tone'; len: number })
  | (Base & { kind: 'list'; ends: Float64Array })
  | (Base & { kind: 'direct'; per: number; bytes: Uint8Array; lastBits: number })
  | DataSeg;

interface DataSeg extends Base {
  kind: 'data';
  bytes: Uint8Array;
  bits: Bits;
  /** When each byte starts, and the end (length + 1). */
  starts: Float64Array;
  /** The level as each byte starts. */
  levels: Uint8Array;
  /** Where its bytes are in the .cas (after a marker), or -1 for non-MSX blocks. */
  casPos: number;
  /** When its block began (its pilot). */
  blockT0: number;
}

/** The standard MSX 1200-baud timing, as the BIOS writes. */
const P = MSX_CLOCK / 4800;
export const MSX_1200: Bits = { len0: 2 * P, len1: P, n0: 2, n1: 4, start: 1, startVal: 0, stop: 2, stopVal: 1, msbFirst: false, lastBits: 8 };
/** BIOS pilots: long before a file header, short before the rest. */
const LONG_PILOT = 16000;
const SHORT_PILOT = 4000;

class Builder {
  t = 0;
  level = 0;
  segs: Seg[] = [];

  tone(len: number, count: number): void {
    if (count <= 0 || len <= 0) return;
    this.segs.push({ kind: 'tone', t0: this.t, t1: this.t + len * count, level0: this.level, len });
    this.t += len * count;
    this.level ^= count & 1;
  }

  list(lens: number[]): void {
    if (!lens.length) return;
    const ends = new Float64Array(lens.length);
    let s = 0;
    lens.forEach((l, i) => { s += l; ends[i] = s; });
    this.segs.push({ kind: 'list', t0: this.t, t1: this.t + s, level0: this.level, ends });
    this.t += s;
    this.level ^= lens.length & 1;
  }

  data(bytes: Uint8Array, bits: Bits, casPos: number, blockT0: number): void {
    const n = bytes.length;
    if (!n) return;
    const starts = new Float64Array(n + 1);
    const levels = new Uint8Array(n);
    const t0 = this.t;
    let t = this.t;
    let level = this.level;
    for (let i = 0; i < n; i++) {
      starts[i] = t;
      levels[i] = level;
      const used = i === n - 1 ? bits.lastBits : 8;
      let ones = 0;
      for (let b = 0; b < used; b++) ones += (bytes[i] >> (bits.msbFirst ? 7 - b : b)) & 1;
      const zeros = used - ones;
      const s0 = bits.startVal ? 0 : bits.start;
      const s1 = bits.startVal ? bits.start : 0;
      const p0 = bits.stopVal ? 0 : bits.stop;
      const p1 = bits.stopVal ? bits.stop : 0;
      const c0 = zeros + s0 + p0;
      const c1 = ones + s1 + p1;
      t += c0 * bits.n0 * bits.len0 + c1 * bits.n1 * bits.len1;
      level ^= (c0 * bits.n0 + c1 * bits.n1) & 1;
    }
    starts[n] = t;
    this.segs.push({ kind: 'data', t0, t1: t, level0: this.level, bytes, bits, starts, levels, casPos, blockT0 });
    this.t = t;
    this.level = level;
  }

  direct(per: number, bytes: Uint8Array, lastBits: number): void {
    const count = (bytes.length - 1) * 8 + lastBits;
    if (count <= 0) return;
    this.segs.push({ kind: 'direct', t0: this.t, t1: this.t + count * per, level0: this.level, per, bytes, lastBits });
    this.t += count * per;
    const last = count - 1;
    this.level = (bytes[last >> 3] >> (7 - (last & 7))) & 1;
  }

  pause(ms: number): void {
    if (ms <= 0) return;
    this.segs.push({ kind: 'pause', t0: this.t, t1: this.t + ms * MS, level0: 0 });
    this.t += ms * MS;
    this.level = 0;
  }
}

export class Signal {
  /** The MSX data blocks, in order. */
  private readonly blocks: DataSeg[];
  private at = 0;

  constructor(private readonly segs: Seg[], readonly end: number) {
    this.blocks = segs.filter((s): s is DataSeg => s.kind === 'data' && s.casPos >= 0);
  }

  /** The level at tape time `t` (CPU cycles from the start). */
  level(t: number): number {
    const segs = this.segs;
    if (!segs.length || t >= this.end || t < 0) return 0;
    let i = this.at;
    if (i >= segs.length || segs[i].t0 > t) i = 0;
    while (segs[i].t1 <= t) i++;
    this.at = i;
    const s = segs[i];
    const d = t - s.t0;
    switch (s.kind) {
      case 'pause': return 0;
      case 'tone': return s.level0 ^ (Math.floor(d / s.len) & 1);
      case 'list': return s.level0 ^ (search(s.ends, d) & 1);
      case 'direct': {
        const k = Math.floor(d / s.per);
        return (s.bytes[k >> 3] >> (7 - (k & 7))) & 1;
      }
      case 'data': return dataLevel(s, t);
    }
  }

  /** The tape time of byte `pos` of the .cas (where the next TAPIN would read). */
  timeOfPos(pos: number): number {
    for (const b of this.blocks) {
      if (pos < b.casPos) return b.blockT0;
      if (pos <= b.casPos + b.bytes.length) return b.starts[pos - b.casPos];
    }
    return this.end;
  }

  /** The .cas position matching tape time `t`: the next whole byte, or the marker of a block not yet reached. */
  posOfTime(t: number, size: number): number {
    for (const b of this.blocks) {
      if (t <= b.starts[0]) return b.casPos - CAS_MARKER.length;
      if (t < b.t1) {
        // The byte under way is gone: the next one starting at or after t.
        const k = search(b.starts, t);
        return b.casPos + (b.starts[k - 1] === t ? k - 1 : k);
      }
    }
    return size;
  }
}

/** The first index whose value is above x (for pulse ends: how many have passed). */
function search(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function dataLevel(s: DataSeg, t: number): number {
  const i = Math.min(search(s.starts, t) - 1, s.bytes.length - 1);
  const b = s.bits;
  let d = t - s.starts[i];
  let pulses = 0;
  const byte = s.bytes[i];
  const used = i === s.bytes.length - 1 ? b.lastBits : 8;
  const total = b.start + used + b.stop;
  for (let k = 0; k < total; k++) {
    const bit = k < b.start ? b.startVal
      : k < b.start + used ? (byte >> (b.msbFirst ? 7 - (k - b.start) : k - b.start)) & 1
        : b.stopVal;
    const n = bit ? b.n1 : b.n0;
    const len = bit ? b.len1 : b.len0;
    if (d < n * len) return s.levels[i] ^ ((pulses + Math.floor(d / len)) & 1);
    d -= n * len;
    pulses += n;
  }
  return s.levels[i] ^ (pulses & 1);
}

/** The data blocks of a .cas: after each marker (on a multiple of 8), up to the next. */
export function casBlocks(cas: Uint8Array): { pos: number; end: number }[] {
  const marks: number[] = [];
  for (let p = 0; p + 8 <= cas.length; p += 8) {
    if (CAS_MARKER.every((b, i) => cas[p + i] === b)) marks.push(p);
  }
  return marks.map((m, i) => ({ pos: m + 8, end: i + 1 < marks.length ? marks[i + 1] : cas.length }));
}

/** A .cas played the way the BIOS records it: 1200 baud, long pilot before each file header. */
export function casSignal(cas: Uint8Array): Signal {
  const b = new Builder();
  for (const { pos, end } of casBlocks(cas)) {
    const data = cas.subarray(pos, end);
    const header = data.length === 16 && [0xd0, 0xd3, 0xea].includes(data[0]) && data.subarray(0, 10).every((x) => x === data[0]);
    b.pause(header ? 1000 : 300);
    const t0 = b.t;
    b.tone(P, header ? LONG_PILOT : SHORT_PILOT);
    b.data(data, MSX_1200, pos, t0);
  }
  b.pause(500);
  return new Signal(b.segs, b.t);
}

/**
 * A .tsx (TZX 1.20 with MSX blocks, as makeTSX writes): its signal, and the
 * .cas made of its MSX blocks (ID 4Bh), which the BIOS traps read. The
 * signal keeps every block that makes pulses: ZX Spectrum speed blocks
 * (10h, 11h, 14h), tones and pulses (12h, 13h), direct recordings (15h)
 * and pauses (20h); turbo loaders use them. Throws if it is not a TZX file.
 */
export function parseTsx(tsx: Uint8Array): { cas: Uint8Array<ArrayBuffer>; signal: Signal } {
  const sig = 'ZXTape!\x1a';
  if (tsx.length < 10 || [...sig].some((c, i) => tsx[i] !== c.charCodeAt(0))) throw new Error('not a .tsx tape');
  const w = (p: number) => tsx[p] | (tsx[p + 1] << 8);
  const t3 = (p: number) => w(p) | (tsx[p + 2] << 16);
  const d = (p: number) => (w(p) | (w(p + 2) << 16)) >>> 0;
  const out: number[] = [];
  const b = new Builder();
  const zx = (len0: number, len1: number, lastBits: number): Bits =>
    ({ len0: len0 * ZX, len1: len1 * ZX, n0: 2, n1: 2, start: 0, startVal: 0, stop: 0, stopVal: 1, msbFirst: true, lastBits: lastBits || 8 });
  let p = 10;
  while (p < tsx.length) {
    const id = tsx[p++];
    let n: number;
    switch (id) {
      case 0x10: { // standard ZX speed data
        const len = w(p + 2);
        const data = tsx.subarray(p + 4, p + 4 + len);
        const t0 = b.t;
        b.tone(2168 * ZX, data[0] < 0x80 ? 8063 : 3223);
        b.list([667 * ZX, 735 * ZX]);
        b.data(data, zx(855, 1710, 8), -1, t0);
        b.pause(w(p));
        n = 4 + len;
        break;
      }
      case 0x11: { // turbo speed data
        const len = t3(p + 15);
        const t0 = b.t;
        b.tone(w(p) * ZX, w(p + 10));
        b.list([w(p + 2) * ZX, w(p + 4) * ZX]);
        b.data(tsx.subarray(p + 18, p + 18 + len), zx(w(p + 6), w(p + 8), tsx[p + 12]), -1, t0);
        b.pause(w(p + 13));
        n = 18 + len;
        break;
      }
      case 0x12: b.tone(w(p) * ZX, w(p + 2)); n = 4; break;
      case 0x13: {
        const count = tsx[p];
        b.list(Array.from({ length: count }, (_, i) => w(p + 1 + 2 * i) * ZX));
        n = 1 + 2 * count;
        break;
      }
      case 0x14: { // pure data
        const len = t3(p + 7);
        b.data(tsx.subarray(p + 10, p + 10 + len), zx(w(p), w(p + 2), tsx[p + 4]), -1, b.t);
        b.pause(w(p + 5));
        n = 10 + len;
        break;
      }
      case 0x15: { // direct recording
        const len = t3(p + 5);
        b.direct(w(p) * ZX, tsx.subarray(p + 8, p + 8 + len), tsx[p + 4] || 8);
        b.pause(w(p + 2));
        n = 8 + len;
        break;
      }
      case 0x4b: { // MSX Kansas City Standard
        const data = tsx.subarray(p + 16, p + 4 + d(p));
        const bitCfg = tsx[p + 14];
        const byteCfg = tsx[p + 15];
        const t0 = b.t;
        b.tone(w(p + 6) * ZX, w(p + 8));
        while (out.length & 7) out.push(0);
        out.push(...CAS_MARKER);
        const casPos = out.length;
        for (const x of data) out.push(x);
        b.data(data, {
          len0: w(p + 10) * ZX,
          len1: w(p + 12) * ZX,
          n0: bitCfg >> 4 || 16,
          n1: bitCfg & 15 || 16,
          start: byteCfg >> 6,
          startVal: (byteCfg >> 5) & 1,
          stop: (byteCfg >> 3) & 3,
          stopVal: (byteCfg >> 2) & 1,
          msbFirst: (byteCfg & 1) === 1,
          lastBits: 8,
        }, casPos, t0);
        b.pause(w(p + 4));
        n = 4 + d(p);
        break;
      }
      case 0x20: b.pause(w(p)); n = 2; break;
      case 0x18: case 0x19: n = 4 + d(p); break;
      case 0x21: case 0x30: n = 1 + tsx[p]; break;
      case 0x22: case 0x25: case 0x27: n = 0; break;
      case 0x23: case 0x24: n = 2; break;
      case 0x26: n = 2 + 2 * w(p); break;
      case 0x28: case 0x32: n = 2 + w(p); break;
      case 0x2a: n = 4; break;
      case 0x2b: n = 5; break;
      case 0x31: n = 2 + tsx[p + 1]; break;
      case 0x33: n = 1 + 3 * tsx[p]; break;
      case 0x35: n = 20 + d(p + 16); break;
      case 0x5a: n = 9; break;
      default: n = 4 + d(p); // TZX: unknown blocks start with a 4-byte length
    }
    p += n;
  }
  return { cas: Uint8Array.from(out), signal: new Signal(b.segs, b.t) };
}
