// The MSX mouse in joystick port 1, read the way the BIOS reads it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { Msx } from '../src/msx/machine';
import { Mouse } from '../src/msx/mouse';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));

/** Reads the four nibbles of port 1 (pin 8 toggled before each) to C000h, twice. */
const reader = () => {
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:   di
        ld hl, 0C000h
        call read4
        ld b, 0
pause:  djnz pause      ; a pause: the next read starts over
        call read4
        ld a, 1
        ld (0C100h), a
done:   jr done
read4:  ld a, 15
        out (0A0h), a
        in a, (0A2h)
        and 0AFh        ; port 1, pin 8 low
        ld e, a
        out (0A1h), a
        ld b, 4
next:   ld a, e
        xor 10h         ; pin 8 changes: the next nibble
        ld e, a
        ld a, 15
        out (0A0h), a
        ld a, e
        out (0A1h), a
        ld a, 14
        out (0A0h), a
        in a, (0A2h)
        ld (hl), a
        inc hl
        djnz next
        ret`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return new Cartridge(r, 'plain');
};

describe('the MSX mouse', () => {
  it('sends X then Y, high nibble first, right and down negative; then starts over', () => {
    const m = new Msx({ main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') });
    const mouse = new Mouse();
    m.psg.mice[0] = mouse;
    mouse.move(5, -3); // 5 right, 3 up
    mouse.buttons = 1; // left held
    m.insert(1, reader());
    m.powerCycle();
    for (let i = 0; i < 300 && m.slots.read(0xc100) !== 1; i++) m.runFrame();
    const got = Array.from({ length: 8 }, (_, i) => m.slots.read(0xc000 + i) & 0x3f);
    // -5 = FBh, +3 = 03h; left button low (bit 4 = 0), right up (bit 5 = 1).
    expect(got.slice(0, 4)).toEqual([0x2f, 0x2b, 0x20, 0x23]);
    expect(got.slice(4)).toEqual([0x20, 0x20, 0x20, 0x20]); // nothing moved since
  });

  it('clamps a long move to one byte and keeps the rest for the next read', () => {
    const mouse = new Mouse();
    mouse.move(-300, 0);
    let t = 0;
    const read = () => {
      t += 10_000; // after a pause
      const out: number[] = [];
      for (let i = 0; i < 4; i++) { mouse.strobe(i & 1 ? 0 : 1, t); t += 50; out.push(mouse.read() & 0x0f); }
      mouse.strobe(0, t); // back low, ready for the next read
      return ((out[0] << 4) | out[1]) << 24 >> 24;
    };
    expect([read(), read(), read()]).toEqual([127, 127, 46]);
  });
});
