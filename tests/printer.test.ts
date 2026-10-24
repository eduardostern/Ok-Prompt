// The printer port, the numeric keypad and pasted text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { msxKey, msxText } from '../src/msx/keyboard';
import { Msx } from '../src/msx/machine';
import { printedText } from '../src/msx/printer';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));

describe('the printer port', () => {
  it('takes each byte on the strobe, as the BIOS LPTOUT sends it', () => {
    const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:   ld hl, msg
next:   ld a, (hl)
        or a
        jr z, done
wait:   in a, (90h)
        and 2
        jr nz, wait         ; busy
        ld a, (hl)
        out (91h), a
        xor a
        out (90h), a        ; strobe low: printed
        dec a
        out (90h), a        ; strobe high
        inc hl
        jr next
done:   jr done
msg:    db "OI", 13, 10, "MSX", 0`);
    const r = new Uint8Array(0x4000).fill(0xff);
    r.set(bytes);
    const m = new Msx({ main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') });
    m.insert(1, new Cartridge(r, 'plain'));
    m.powerCycle();
    for (let i = 0; i < 300; i++) m.runFrame();
    expect(m.printer.bytes).toEqual([0x4f, 0x49, 13, 10, 0x4d, 0x53, 0x58]);
    expect(printedText(m.printer.bytes, (c) => String.fromCharCode(c))).toBe('OI\nMSX');
  });

  it('turns line ends and MSX characters into text', () => {
    expect(printedText([0x41, 13, 0x42, 10, 0x43, 0x87], (c) => (c === 0x87 ? 'ç' : String.fromCharCode(c)))).toBe('A\nB\nCç');
  });
});

describe('the numeric keypad and pasted text', () => {
  it('maps the keypad to matrix rows 9 and 10', () => {
    expect(msxKey('NumpadMultiply')).toEqual([9, 0]);
    expect(msxKey('Numpad4')).toEqual([9, 7]);
    expect(msxKey('Numpad5')).toEqual([10, 0]);
    expect(msxKey('NumpadDecimal')).toEqual([10, 7]);
  });

  it('types pasted text with Enter at each line end and MSX codes for accents', () => {
    expect(msxText('10 PRINT "ação"\r\n20 END\n')).toBe('10 PRINT "a\x87\xb1o"\r20 END\r');
    expect(msxText('ç', 'brazil-1.0')).toBe('\x60');
    expect(msxText('emoji 😀')).toBe('emoji ');
  });
});
