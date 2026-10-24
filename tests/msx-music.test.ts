// MSX-MUSIC in the machine: our ROM in slot 3-3 says "APRLOPLL" where
// software looks, and the YM2413 on ports 7Ch/7Dh plays into the mix.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { Bios, Msx } from '../src/msx/machine';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));
const MSX1: Bios = { main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') };
const MSX2: Bios = { main: rom('cbios_main_msx2.rom'), logo: rom('cbios_logo_msx2.rom'), sub: rom('cbios_sub.rom') };

/** Reads 8 bytes at 4018h of slot 3-3 through RDSLT to C000h, then plays a note. */
const probe = () => {
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:   ld hl, 4018h
        ld de, 0C000h
        ld b, 8
rd:     push bc
        push de
        push hl
        ld a, 8Fh           ; slot 3-3
        call 000Ch          ; RDSLT
        pop hl
        pop de
        pop bc
        ld (de), a
        inc hl
        inc de
        djnz rd
        ei
        ld a, 30h           ; channel 0: violin, full volume
        out (7Ch), a
        ld a, 10h
        out (7Dh), a
        ld a, 10h           ; F-number low
        out (7Ch), a
        ld a, 0ACh
        out (7Dh), a
        ld a, 20h           ; key on, block 4
        out (7Ch), a
        ld a, 18h
        out (7Dh), a
done:   jr done`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return new Cartridge(r, 'plain');
};

function run(bios: Bios, fm: boolean) {
  const m = new Msx(bios);
  m.setFm(fm);
  m.insert(1, probe());
  m.powerCycle();
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    m.runFrame();
    const a = m.takeAudio();
    if (i > 380) for (const v of a) peak = Math.max(peak, Math.abs(v - a[0]));
  }
  const sig = String.fromCharCode(...Array.from({ length: 8 }, (_, i) => m.slots.read(0xc000 + i)));
  return { sig, peak };
}

describe('MSX-MUSIC', () => {
  for (const [name, bios] of [['MSX1', MSX1], ['MSX2', MSX2]] as const) {
    it(`is found in slot 3-3 and plays on an ${name}`, () => {
      const on = run(bios, true);
      expect(on.sig).toBe('APRLOPLL');
      expect(on.peak).toBeGreaterThan(0.02);
    });

    it(`is not there when switched off (${name})`, () => {
      const off = run(bios, false);
      expect(off.sig).not.toBe('APRLOPLL');
      expect(off.peak).toBeLessThan(0.02);
    });
  }
});
