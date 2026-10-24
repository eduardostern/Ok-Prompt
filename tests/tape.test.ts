// .tsx tapes (TZX with MSX blocks) read as the .cas the tape deck plays.
import { describe, expect, it } from 'vitest';
import { CAS_MARKER, Tape, tsxToCas } from '../src/msx/tape';

const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >> (8 * i)) & 0xff);
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A 4Bh block as makeTSX writes it: pause, pilot, pulses, bit lengths, config, data. */
const kc = (data: number[]) => {
  const params = [...le(1000, 2), ...le(0x05dc, 2), ...le(0x77f7, 2), ...le(0x05dc, 2), ...le(0x02dc, 2), 0x24, 0x54];
  return [0x4b, ...le(params.length + data.length, 4), ...params, ...data];
};

const header = [...Array(10).fill(0xd0), ...text('GAME  ')];
const body = [0x00, 0xc0, 0x03, 0xc0, 0x00, 0xc0, 0xc9];

const tsx = Uint8Array.from([
  ...text('ZXTape!'), 0x1a, 1, 21,
  0x35, ...text('TSX.LOAD        '), ...le(13, 4), ...text('BLOAD"CAS:",R'), // custom info
  0x32, ...le(7, 2), 1, 0x00, 4, ...text('Game'), // archive info
  ...kc(header),
  0x20, ...le(500, 2), // pause
  0x10, ...le(1000, 2), ...le(3, 2), 0x00, 0x01, 0x02, // a ZX Spectrum block: nothing for the MSX
  ...kc(body),
]);

describe('.tsx tapes', () => {
  it('turns each MSX block into a .cas block and skips the rest', () => {
    const cas = tsxToCas(tsx);
    expect([...cas]).toEqual([...CAS_MARKER, ...header, ...CAS_MARKER, ...body]);
    expect(new Tape(cas).first()).toEqual({ kind: 'binary', name: 'GAME' });
  });

  it('refuses files that are not .tsx tapes or hold no MSX data', () => {
    expect(() => tsxToCas(Uint8Array.from(text('not a tape')))).toThrow(/not a \.tsx/);
    expect(() => tsxToCas(Uint8Array.from([...text('ZXTape!'), 0x1a, 1, 21, 0x20, 0, 0]))).toThrow(/no MSX data/);
  });
});
