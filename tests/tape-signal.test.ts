// Tapes played as a signal: a loader of its own (as games with turbo loaders
// have) reads the cassette input bit and decodes the FSK, from a .cas at the
// BIOS's 1200 baud, from a .tsx at 2400 baud, and after the BIOS routines.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { Msx } from '../src/msx/machine';
import { CAS_MARKER, Tape } from '../src/msx/tape';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >> (8 * i)) & 0xff);

const HEADER = [...Array(10).fill(0xd0), ...text('SIGNAL')];
const DATA = Array.from({ length: 16 }, (_, i) => (i * 37 + 5) & 0xff);
/** A .cas with the given blocks. */
const cas = (...blocks: number[][]) => {
  const out: number[] = [];
  for (const b of blocks) {
    while (out.length & 7) out.push(0);
    out.push(...CAS_MARKER, ...b);
  }
  return Uint8Array.from(out);
};

/**
 * A loader in Z80: counts loop turns between edges of R14 bit 7 (about 45
 * cycles a turn); pulses shorter than `thresh` turns are 1-bit halves.
 * `bios` first reads one block through TAPION/TAPIN (to C000h); the
 * signal part reads 16 bytes to `dest`.
 */
function loader(thresh: number, opts: { motor?: boolean; bios?: boolean; dest?: number } = {}): Cartridge {
  const { motor = true, bios = false, dest = 0xc000 } = opts;
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:   di
        ${bios ? `call 00E1h           ; TAPION
        ld hl, 0C000h
        ld b, 16
hdr:    push bc
        push hl
        call 00E4h          ; TAPIN
        pop hl
        pop bc
        ld (hl), a
        inc hl
        djnz hdr
        call 00E7h          ; TAPIOF
        di` : ''}
        ld a, 14
        out (0A0h), a
        ${motor ? `in a, (0AAh)
        and 0EFh
        out (0AAh), a       ; motor on` : ''}
        ld hl, ${dest}
        in a, (0A2h)
        and 80h
        ld b, a
getb:   call pulse          ; skip the pilot and stop bits: short pulses
        cp ${thresh}
        jr c, getb
        cp ${thresh * 3}
        jr nc, getb         ; silence
        call pulse          ; the start bit's second half
        ld e, 8
nbit:   call pulse
        cp ${thresh}
        jr nc, zero
        call pulse
        call pulse
        call pulse
        scf
        jr store
zero:   call pulse
        or a
store:  rr d
        dec e
        jr nz, nbit
        ld (hl), d
        inc hl
        ld a, l
        cp ${(dest + 16) & 0xff}
        jr nz, getb
        in a, (0AAh)
        or 10h
        out (0AAh), a       ; motor off
        ld a, 1
        ld (0C100h), a
done:   jr done
pulse:  ld c, 0
p1:     in a, (0A2h)
        and 80h
        cp b
        jr nz, p2
        inc c
        jr nz, p1
        dec c
        jr p1
p2:     ld b, a
        ld a, c
        ret`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return new Cartridge(r, 'plain');
}

function run(cart: Cartridge, tape: Tape, frames: number) {
  const m = new Msx({ main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') });
  m.insert(1, cart);
  m.tape = tape;
  m.powerCycle();
  for (let i = 0; i < frames; i++) m.runFrame();
  const ram = (a: number, n: number) => Array.from({ length: n }, (_, i) => m.slots.read(a + i));
  return { m, ram };
}

describe('the tape as a signal', () => {
  it('plays a .cas at 1200 baud to a loader reading the cassette input', () => {
    const tape = new Tape(cas(HEADER), 'sig.cas');
    const { ram } = run(loader(25), tape, 500);
    expect(ram(0xc100, 1)).toEqual([1]);
    expect(ram(0xc000, 16)).toEqual(HEADER);
    expect(tape.progress).toBeGreaterThan(0.5);
  });

  it('plays a .tsx with its own timing (2400 baud)', () => {
    // makeTSX's 4Bh block: pilot 365 T, 0 = 2 x 730 T, 1 = 4 x 365 T.
    const kc = (data: number[]) => {
      const params = [...le(500, 2), ...le(365, 2), ...le(6000, 2), ...le(730, 2), ...le(365, 2), 0x24, 0x54];
      return [0x4b, ...le(params.length + data.length, 4), ...params, ...data];
    };
    const tsx = Uint8Array.from([...text('ZXTape!'), 0x1a, 1, 21, 0x20, ...le(200, 2), ...kc(DATA)]);
    const tape = new Tape(tsx, 'fast.tsx');
    const { ram } = run(loader(12), tape, 300);
    expect(ram(0xc100, 1)).toEqual([1]);
    expect(ram(0xc000, 16)).toEqual(DATA);
    expect(tape.file()).toEqual({ name: 'fast.tsx', data: tsx });
  });

  it('stands still while the motor is off', () => {
    const tape = new Tape(cas(HEADER), 'sig.cas');
    const { ram } = run(loader(25, { motor: false }), tape, 300);
    expect(ram(0xc100, 1)).not.toEqual([1]);
    expect(tape.progress).toBe(0);
  });

  it('plays on from where the BIOS routines stopped reading', () => {
    const tape = new Tape(cas(HEADER, DATA), 'two.cas');
    const { ram } = run(loader(25, { bios: true, dest: 0xc010 }), tape, 300);
    expect(ram(0xc000, 16)).toEqual(HEADER);
    expect(ram(0xc010, 16)).toEqual(DATA);
    expect(ram(0xc100, 1)).toEqual([1]);
  });

  it('lets the BIOS routines read on from where the signal stopped', () => {
    const tape = new Tape(cas(HEADER, DATA), 'two.cas');
    const { m } = run(loader(25), tape, 500); // the loader reads the header by signal
    expect(tape.findBlock()).toBe(true); // next: the data block
    expect(Array.from({ length: 16 }, () => tape.readByte())).toEqual(DATA);
    expect(m).toBeTruthy();
  });
});
