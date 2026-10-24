// C-BIOS MSX2 and MSX2+ on the emulated MSX2: boot, 80 columns, SCREEN 5,
// with cartridges written in Z80 and built by our own assembler.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { Msx } from '../src/msx/machine';
import { V9938, V_BORDER_X, V_WIDTH } from '../src/msx/v9938';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));
const MSX2 = { main: rom('cbios_main_msx2.rom'), logo: rom('cbios_logo_msx2.rom'), sub: rom('cbios_sub.rom') };
const MSX2P = { main: rom('cbios_main_msx2+.rom'), logo: rom('cbios_logo_msx2+.rom'), sub: rom('cbios_sub.rom') };

/** A 16K cartridge at 4000h from Z80 source (the header is added). */
function cart(body: string): Cartridge {
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:
${body}`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return new Cartridge(r, 'plain');
}

const boot = (bios = MSX2, c?: Cartridge, frames = 400) => {
  const m = new Msx(bios);
  if (c) m.insert(1, c);
  m.powerCycle();
  for (let i = 0; i < frames; i++) m.runFrame();
  return { m, v: m.vdp as V9938 };
};

const text = (v: V9938) => {
  const cols = v.textColumns();
  const nt = (v.regs[2] & (v.mode === 'T2' ? 0x7c : 0x7f)) << 10; // TEXT2 forces A11-A10 on
  let s = '';
  for (let y = 0; y < 24; y++) s += String.fromCharCode(...v.vram.subarray(nt + y * cols, nt + (y + 1) * cols)).trimEnd() + '\n';
  return s;
};

describe('C-BIOS MSX2 on the MSX2', () => {
  it('boots: an MSX2 with a V9938, the logo in SCREEN 5, then the text screen', () => {
    const m = new Msx(MSX2);
    expect(m.model).toBe('msx2');
    m.powerCycle();
    const v = m.vdp as V9938;
    expect(v.v9958).toBe(false);
    for (let i = 0; i < 100; i++) m.runFrame();
    expect(v.mode).toBe('G4');
    expect(v.vram.subarray(31 * 128, 116 * 128).some((b) => b)).toBe(true); // the logo, by HMMC
    for (let i = 0; i < 300; i++) m.runFrame();
    expect(v.mode).toBe('G1');
    expect(text(v)).toContain('No cartridge found');
    expect(m.slots.read(0xfafc) & 4).toBe(4); // MODE: 128K of VRAM found
  });

  it('boots C-BIOS MSX2+ on a V9958', () => {
    const { m, v } = boot(MSX2P);
    expect(m.model).toBe('msx2+');
    expect(v.v9958).toBe(true);
    expect(text(v)).toContain('No cartridge found');
  });

  it('shows 80 columns: LINL40 = 80 and INITXT give TEXT2', () => {
    const { v } = boot(MSX2, cart(`
        ld a, 80
        ld (0F3AEh), a      ; LINL40
        call 006Ch          ; INITXT
        ld hl, msg
next:   ld a, (hl)
        or a
        jr z, done
        call 00A2h          ; CHPUT
        inc hl
        jr next
done:   jr done
msg:    db "Hello from the MSX2 at 80 columns", 0`));
    expect(v.mode).toBe('T2');
    expect(v.textColumns()).toBe(80);
    expect(text(v)).toContain('Hello from the MSX2 at 80 columns');
    // The H is drawn: some pixel of the first character cell is the text colour.
    const fg = v.frame[0]; // border
    const top = v.displayLines === 212 ? 14 : 24;
    let lit = false;
    for (let y = 0; y < 8; y++) for (let x = 16; x < 22; x++) if (v.frame[(top + y) * V_WIDTH + V_BORDER_X + x] !== fg) lit = true;
    expect(lit).toBe(true);
  });

  it('draws in SCREEN 5 set by CHGMOD, through the VDP ports', () => {
    const { v } = boot(MSX2, cart(`
        ld a, 5
        call 005Fh          ; CHGMOD
        di
        xor a
        out (99h), a
        ld a, 80h | 14
        out (99h), a        ; R#14 = 0
        xor a
        out (99h), a
        ld a, 40h
        out (99h), a        ; write at 0
        ld a, 9Ah
        out (98h), a
        ei
loop:   jr loop`));
    expect(v.mode).toBe('G4');
    expect(v.vram[0]).toBe(0x9a);
  });
});
