import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Cartridge, guessMapper, plainBase } from '../src/msx/cartridge';
import { checkBios, Msx } from '../src/msx/machine';
import { msxKey } from '../src/msx/keyboard';
import { Ppi } from '../src/msx/ppi';
import { Scc } from '../src/msx/scc';
import { Psg } from '../src/msx/psg';
import { Ram, Rom, Slots } from '../src/msx/slots';
import { BORDER_X, BORDER_Y, PALETTE, Vdp, WIDTH } from '../src/msx/vdp';

const rom = (name: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${name}`, import.meta.url)));
const BIOS = { main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') };

/** A 16K cartridge that prints `text` with the BIOS's CHPUT, then loops. */
function helloCart(text: string): Uint8Array {
  const c = new Uint8Array(0x4000).fill(0xff);
  c.set([0x41, 0x42, 0x10, 0x40], 0); // "AB", INIT = 4010h
  c.set([
    0x21, 0x20, 0x40, // LD HL,4020h
    0x7e, //             LD A,(HL)
    0xb7, //             OR A
    0x28, 0x06, //       JR Z,+6
    0xcd, 0xa2, 0x00, // CALL CHPUT
    0x23, //             INC HL
    0x18, 0xf6, //       JR -10
    0x18, 0xfe, //       JR $
  ], 0x10);
  c.set([...text].map((ch) => ch.charCodeAt(0)).concat(0), 0x20);
  return c;
}

/** The text on screen: the name table, wherever register 2 puts it. */
const screenText = (m: Msx) => {
  const nt = (m.vdp.regs[2] & 0x0f) << 10;
  return String.fromCharCode(...m.vdp.vram.subarray(nt, nt + 960));
};

const rgb = (pixel: number) => [pixel & 0xff, (pixel >> 8) & 0xff, (pixel >> 16) & 0xff];

describe('slots', () => {
  it('maps each 16K page to the slot the primary register picks', () => {
    const s = new Slots();
    const ram = new Ram();
    s.insert(0, new Rom().place(0, new Uint8Array(0x8000).fill(0x11)));
    s.insert(3, ram);
    s.primary = 0b11_11_00_00; // pages 0-1 slot 0, pages 2-3 slot 3
    expect(s.read(0x0000)).toBe(0x11);
    s.write(0xc000, 0x42);
    expect(s.read(0xc000)).toBe(0x42);
    s.write(0x0000, 0x99); // ROM ignores writes
    expect(s.read(0x0000)).toBe(0x11);
    s.primary = 0xff;
    expect(s.read(0x0000)).toBe(0); // now RAM
    expect(s.read(0xc000)).toBe(0x42);
  });
});

describe('cartridges', () => {
  it('places plain ROMs by size and header', () => {
    expect(plainBase(new Uint8Array(0x4000))).toBe(0x4000);
    const basic = new Uint8Array(0x4000);
    basic.set([0x41, 0x42, 0x10, 0x80]); // INIT in 8000h-BFFFh
    expect(plainBase(basic)).toBe(0x8000);
    expect(plainBase(new Uint8Array(0x8000))).toBe(0x4000);
    expect(plainBase(new Uint8Array(0x10000))).toBe(0x0000);
  });

  it('guesses the mapper from the bank-switch writes in the code', () => {
    const mega = (addrs: number[]) => {
      const r = new Uint8Array(0x20000);
      addrs.forEach((a, i) => r.set([0x32, a & 0xff, a >> 8], 0x100 + i * 3));
      return r;
    };
    expect(guessMapper(new Uint8Array(0x8000))).toBe('plain');
    expect(guessMapper(mega([0x5000, 0x7000, 0x9000, 0xb000]))).toBe('konamiscc');
    expect(guessMapper(mega([0x6000, 0x8000, 0xa000, 0xa000]))).toBe('konami');
    expect(guessMapper(mega([0x6000, 0x6800, 0x7000, 0x7800]))).toBe('ascii8');
    expect(guessMapper(mega([0x6000, 0x7000, 0x77ff, 0x77ff]))).toBe('ascii16');
  });

  it('switches banks as each mapper does', () => {
    const r = new Uint8Array(0x20000);
    for (let b = 0; b < 16; b++) r.fill(b, b * 0x2000, (b + 1) * 0x2000); // 8K bank n is all n
    const k = new Cartridge(r, 'konami');
    k.write(0x8000, 5);
    k.write(0x4000, 9); // Konami: 4000h is fixed
    expect([k.read(0x4000), k.read(0x8000)]).toEqual([0, 5]);
    const a16 = new Cartridge(r, 'ascii16');
    a16.write(0x7000, 3); // 16K bank 3 = 8K banks 6 and 7 at 8000h
    expect([a16.read(0x8000), a16.read(0xa000)]).toEqual([6, 7]);
    const scc = new Cartridge(r, 'konamiscc');
    scc.write(0xb000, 12);
    expect(scc.read(0xa000)).toBe(12);
  });
});

describe('SCC', () => {
  /** A Konami SCC cartridge whose 8K bank n is filled with n. */
  const sccCart = () => {
    const r = new Uint8Array(0x80000);
    for (let b = 0; b < 64; b++) r.fill(b, b * 0x2000, (b + 1) * 0x2000);
    return new Cartridge(r, 'konamiscc');
  };
  /** Channel `ch`: a square wave, the period, full volume, enabled. */
  const square = (c: Cartridge, ch: number, period: number) => {
    for (let i = 0; i < 32; i++) c.write(0x9800 + Math.min(ch, 3) * 32 + i, i < 16 ? 0x7f : 0x80);
    c.write(0x9880 + ch * 2, period & 0xff);
    c.write(0x9881 + ch * 2, period >> 8);
    c.write(0x988a + ch, 15);
    c.write(0x988f, 1 << ch);
  };
  const rising = (s: Float32Array) => {
    let n = 0;
    for (let i = 1; i < s.length; i++) if (s[i] > 0 && s[i - 1] <= 0) n++;
    return n;
  };

  it('shows its registers at 9800h only while bank 3Fh is at 8000h', () => {
    const c = sccCart();
    c.write(0x9000, 0x3e);
    c.write(0x9800, 0x55);
    expect(c.read(0x9800)).toBe(0x3e); // ROM
    expect(c.scc!.wave[0]).toBe(0);
    c.write(0x9000, 0x3f);
    expect(c.read(0x9800)).toBe(0); // the SCC's wave RAM, not bank 3Fh
    c.write(0x9800, 0x55);
    expect(c.read(0x9800)).toBe(0x55);
    expect(c.read(0x9900)).toBe(0x55); // 256-byte mirror
    expect(c.read(0x9000)).toBe(0x3f); // the rest of the bank is still ROM
    c.write(0xb000, 7); // bank switching still works
    expect(c.read(0xa000)).toBe(7);
  });

  it('decodes periods, volumes, enable and their mirror at 90h', () => {
    const c = sccCart();
    c.write(0x9000, 0x3f);
    c.write(0x9882, 0x34);
    c.write(0x9893, 0x12); // mirror of 9883h
    c.write(0x988c, 0x1a);
    c.write(0x989f, 0xff);
    const scc = c.scc!;
    expect(scc.period[1]).toBe(0x234);
    expect(scc.volume[2]).toBe(0x0a);
    expect(scc.enable).toBe(0x1f);
    expect(c.read(0x9880)).toBe(0xff); // write-only
  });

  it('plays a channel at CPU / (32 x (period + 1))', () => {
    const c = sccCart();
    c.write(0x9000, 0x3f);
    square(c, 0, 253); // 3579545 / 32 / 254 = 440 Hz
    c.scc!.advanceTo(3_579_545);
    const n = rising(c.scc!.take());
    expect(n).toBeGreaterThan(435);
    expect(n).toBeLessThan(445);
  });

  it('plays channel 4\'s wave on channel 5 and keeps disabled channels quiet', () => {
    const scc = new Scc();
    for (let i = 0; i < 32; i++) scc.write(0x60 + i, i < 16 ? 100 : -100);
    scc.write(0x88, 200);
    scc.write(0x8e, 15);
    scc.advanceTo(100_000);
    expect(scc.take().every((v) => v === 0)).toBe(true); // not enabled yet
    scc.write(0x8f, 0x10);
    scc.advanceTo(200_000);
    expect(rising(scc.take())).toBeGreaterThan(10);
  });

  it('is mixed into the machine\'s sound', () => {
    const m = new Msx(BIOS);
    const c = sccCart();
    m.insert(1, c);
    c.write(0x9000, 0x3f);
    square(c, 0, 253);
    m.runFrame();
    const s = m.takeAudio();
    expect(s.length).toBeGreaterThan(700);
    expect(rising(s)).toBeGreaterThan(5);
  });
});

describe('VDP', () => {
  const setReg = (v: Vdp, n: number, value: number) => { v.writeControl(value); v.writeControl(0x80 | n); };
  const setAddr = (v: Vdp, a: number, write: boolean) => { v.writeControl(a & 0xff); v.writeControl((a >> 8) | (write ? 0x40 : 0)); };

  it('writes and reads VRAM through the data port, reading ahead', () => {
    const v = new Vdp();
    setAddr(v, 0x1234, true);
    v.writeData(0xaa);
    v.writeData(0xbb);
    setAddr(v, 0x1234, false);
    expect([v.readData(), v.readData()]).toEqual([0xaa, 0xbb]);
  });

  it('raises the interrupt at the end of the picture until the status is read', () => {
    const v = new Vdp();
    setReg(v, 1, 0x60); // display on, interrupts on
    v.vblank();
    expect(v.irq).toBe(true);
    expect(v.readStatus() & 0x80).toBe(0x80);
    expect(v.irq).toBe(false);
  });

  it('draws Graphics I characters in their group colour', () => {
    const v = new Vdp();
    setReg(v, 1, 0x40); // display on, Graphics I
    setReg(v, 2, 0x06); // names at 1800h
    setReg(v, 3, 0x80); // colours at 2000h
    setReg(v, 4, 0x00); // patterns at 0000h
    setReg(v, 7, 0x04); // backdrop dark blue
    v.vram[0x1800] = 1; // top-left character is pattern 1
    v.vram[8] = 0b1000_0000; // its first row: one pixel set
    v.vram[0x2000] = 0xf1; // group 0: white on black
    v.renderLine(0);
    const row = BORDER_Y * WIDTH + BORDER_X;
    expect(rgb(v.frame[row])).toEqual(PALETTE[15]);
    expect(rgb(v.frame[row + 1])).toEqual(PALETTE[1]);
    expect(rgb(v.frame[row - 1])).toEqual(PALETTE[4]); // the border
  });

  it('shows four sprites on a line and flags the fifth', () => {
    const v = new Vdp();
    setReg(v, 1, 0x40); // display on, 8x8 sprites
    setReg(v, 5, 0x36); // attributes at 1B00h
    setReg(v, 6, 0x07); // patterns at 3800h
    v.vram.fill(0xff, 0x3800, 0x3808); // pattern 0 solid
    for (let n = 0; n < 5; n++) v.vram.set([9, n * 20, 0, 15], 0x1b00 + n * 4); // y=9 shows on line 10
    v.vram[0x1b00 + 20] = 0xd0;
    v.renderLine(10);
    expect(v.status & 0x40).toBe(0x40);
    expect(v.status & 0x1f).toBe(4);
    const row = (BORDER_Y + 10) * WIDTH + BORDER_X;
    expect(rgb(v.frame[row + 60])).toEqual(PALETTE[15]); // sprite 3
    expect(rgb(v.frame[row + 80])).not.toEqual(PALETTE[15]); // sprite 4: not drawn
  });
});

describe('PSG', () => {
  it('plays a tone at clock / (16 x period)', () => {
    const psg = new Psg(3_579_545, 44100);
    psg.reset();
    const set = (r: number, v: number) => { psg.select(r); psg.write(v, 0); };
    set(0, 254); // period 254: 1789772.5 / 16 / 254 = 440 Hz
    set(7, 0b11_111_110); // tone A only
    set(8, 15);
    psg.advanceTo(3_579_545); // one second
    const s = psg.take();
    let edges = 0;
    for (let i = 1; i < s.length; i++) if (s[i] > 0.1 && s[i - 1] <= 0.1) edges++;
    expect(edges).toBeGreaterThan(435);
    expect(edges).toBeLessThan(445);
  });

  it('reads the joystick on register 14', () => {
    const psg = new Psg(3_579_545, 44100);
    psg.reset();
    psg.joystick[0] = 0x3f & ~0x01; // up
    psg.select(14);
    expect(psg.read() & 0x3f).toBe(0x3e);
  });
});

describe('keyboard', () => {
  it('maps PC keys onto the MSX matrix through the PPI', () => {
    const ppi = new Ppi(new Slots());
    const [row, bit] = msxKey('KeyA')!;
    ppi.key(row, bit, true);
    ppi.out(0xaa, row); // select the row
    expect(ppi.in(0xa9)).toBe(0xff & ~(1 << bit));
    expect(msxKey('Enter')).toEqual([7, 7]);
  });
});

describe('the machine', () => {
  it('boots C-BIOS, which finds no cartridge and says so', () => {
    const m = new Msx(BIOS);
    for (let i = 0; i < 240; i++) m.runFrame(); // past the logo
    expect(m.vdp.regs[1] & 0x40).toBe(0x40); // display on
    expect(screenText(m)).toContain('No cartridge found');
  });

  it('starts a cartridge in port 1 and runs it', () => {
    const m = new Msx(BIOS);
    m.insert(1, new Cartridge(helloCart('HELLO FROM OK-PROMPT')));
    m.reset();
    for (let i = 0; i < 180; i++) m.runFrame();
    expect(screenText(m)).toContain('HELLO FROM OK-PROMPT');
  });

  it('boots a system ROM of the player\'s own in place of C-BIOS', () => {
    // A 32K "BIOS" that writes "Ok" at VRAM 0000h through the VDP, then loops.
    const own = new Uint8Array(0x8000).fill(0xff);
    own.set([
      0xf3, //             DI
      0xaf, //             XOR A
      0xd3, 0x99, //       OUT (99h),A   address low
      0x3e, 0x40, //       LD A,40h
      0xd3, 0x99, //       OUT (99h),A   address high, write mode
      0x3e, 0x4f, //       LD A,'O'
      0xd3, 0x98, //       OUT (98h),A
      0x3e, 0x6b, //       LD A,'k'
      0xd3, 0x98, //       OUT (98h),A
      0x18, 0xfe, //       JR $
    ]);
    expect(() => checkBios(own)).not.toThrow();
    expect(() => checkBios(BIOS.main)).not.toThrow();
    expect(() => checkBios(new Uint8Array(0x8000))).toThrow(/DI/);
    expect(() => checkBios(new Uint8Array(0x1000).fill(0xf3))).toThrow(/32K/);

    const m = new Msx(BIOS);
    m.setBios({ main: own });
    m.powerCycle();
    m.runFrame();
    expect(String.fromCharCode(m.vdp.vram[0], m.vdp.vram[1])).toBe('Ok');
    expect(m.slots.read(0x8000)).toBe(0xff); // no C-BIOS logo ROM left behind

    m.setBios(BIOS); // and back to C-BIOS
    m.powerCycle();
    for (let i = 0; i < 300; i++) m.runFrame();
    expect(screenText(m)).toMatch(/cartridge/i);
  });
});
