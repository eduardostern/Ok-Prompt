// The V9938/V9958 against docs/v9938.md.
import { describe, expect, it } from 'vitest';
import { MSX2_PALETTE, V9938, V_BORDER_X, V_WIDTH } from '../src/msx/v9938';

const reg = (v: V9938, n: number, val: number) => { v.writeControl(val); v.writeControl(0x80 | n); };
const addr = (v: V9938, a: number, write: boolean) => { v.writeControl(a & 0xff); v.writeControl(((a >> 8) & 0x3f) | (write ? 0x40 : 0)); };
const status = (v: V9938, n: number) => { reg(v, 15, n); const s = v.readStatus(); reg(v, 15, 0); return s; };
/** Sets a screen mode by its M bits, display on. */
const MODE_BITS: Record<string, [number, number]> = {
  T1: [0x00, 0x10], T2: [0x04, 0x10], MC: [0x00, 0x08], G1: [0x00, 0x00], G2: [0x02, 0x00], G3: [0x04, 0x00],
  G4: [0x06, 0x00], G5: [0x08, 0x00], G6: [0x0a, 0x00], G7: [0x0e, 0x00],
};
const mode = (v: V9938, m: string, r1 = 0x40) => { reg(v, 0, MODE_BITS[m][0]); reg(v, 1, MODE_BITS[m][1] | r1); };
const rgb = (c: number) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
/** Picture pixel (x in 512-space, y picture line) after frameStart + renderLine. */
const px = (v: V9938, x: number, y: number) => {
  const top = v.displayLines === 212 ? 14 : 24;
  return v.frame[(top + y) * V_WIDTH + V_BORDER_X + x];
};
const draw = (v: V9938, y: number) => { v.frameStart(); v.renderLine(y); };
const palRgb = (n: number) => {
  const g = (MSX2_PALETTE[n] >> 8) & 7, r = (MSX2_PALETTE[n] >> 4) & 7, b = MSX2_PALETTE[n] & 7;
  return [r, g, b].map((c) => Math.round((c * 255) / 7));
};
/** Runs a command: registers R#32 up, then CMD. */
const command = (v: V9938, r: Record<string, number>, cmd: number) => {
  const set = (n: number, val: number) => reg(v, n, val);
  const w = (lo: number, val = 0) => { set(lo, val & 0xff); set(lo + 1, val >> 8); };
  w(32, r.sx ?? 0); w(34, r.sy ?? 0); w(36, r.dx ?? 0); w(38, r.dy ?? 0); w(40, r.nx ?? 0); w(42, r.ny ?? 0);
  if (r.clr !== undefined) set(44, r.clr);
  set(45, r.arg ?? 0);
  set(46, cmd);
};

describe('V9938 ports', () => {
  it('writes VRAM at the address, with R#14 for the top bits', () => {
    const v = new V9938();
    addr(v, 0x1234, true);
    v.writeData(0xaa);
    v.writeData(0xbb);
    expect([v.vram[0x1234], v.vram[0x1235]]).toEqual([0xaa, 0xbb]);
    reg(v, 14, 2);
    addr(v, 0, true);
    v.writeData(0x77);
    expect(v.vram[0x8000]).toBe(0x77);
  });

  it('carries into R#14 only in the V9938 modes', () => {
    const v = new V9938();
    mode(v, 'G4');
    addr(v, 0x3fff, true);
    v.writeData(1);
    v.writeData(2);
    expect([v.vram[0x3fff], v.vram[0x4000], v.regs[14]]).toEqual([1, 2, 1]);
    const w = new V9938();
    mode(w, 'G1');
    addr(w, 0x3fff, true);
    w.writeData(1);
    w.writeData(2);
    expect([w.vram[0x3fff], w.vram[0], w.regs[14]]).toEqual([1, 2, 0]);
  });

  it('reads ahead, and a first control byte alone moves nothing', () => {
    const v = new V9938();
    v.vram[0x100] = 1;
    v.vram[0x101] = 2;
    addr(v, 0x100, false);
    expect([v.readData(), v.readData()]).toEqual([1, 2]);
    addr(v, 0x1000, true);
    v.writeControl(0x55); // half a pair...
    v.readStatus(); // ...reset by a status read
    v.writeData(9);
    expect(v.vram[0x1000]).toBe(9);
  });

  it('writes registers indirectly through 9Bh, with and without increment', () => {
    const v = new V9938();
    reg(v, 17, 32);
    v.writeIndirect(1); v.writeIndirect(2); v.writeIndirect(3);
    expect([v.regs[32], v.regs[33], v.regs[34]]).toEqual([1, 0, 3]); // R#33 keeps bit 0 only... of 2
    reg(v, 17, 0x80 | 7);
    v.writeIndirect(4); v.writeIndirect(5);
    expect(v.regs[7]).toBe(5);
    expect(v.regs[8]).toBe(0);
  });

  it('takes palette entries as two bytes, GRB 3-3-3', () => {
    const v = new V9938();
    reg(v, 16, 2);
    v.writePalette(0x71); // R7 B1
    v.writePalette(0x05); // G5
    expect(v.palette[2]).toBe(0x571);
    expect(v.regs[16]).toBe(3);
    v.writePalette(0x77); // half an entry...
    reg(v, 16, 4); // ...dropped by setting R#16
    v.writePalette(0x70); v.writePalette(0x00);
    expect(v.palette[4]).toBe(0x070);
  });

  it('masks registers; R#25-27 exist only on the V9958', () => {
    const v = new V9938();
    reg(v, 1, 0xff);
    expect(v.regs[1]).toBe(0x7f);
    reg(v, 25, 0xff);
    expect(v.regs[25]).toBe(0);
    const p = new V9938(true);
    reg(p, 25, 0xff);
    expect(p.regs[25]).toBe(0x7f);
  });
});

describe('V9938 status and interrupts', () => {
  it('sets F at vblank, interrupts with IE0, and clears on reading S#0', () => {
    const v = new V9938();
    v.vblank();
    expect(v.irq).toBe(false);
    reg(v, 1, 0x20);
    expect(v.irq).toBe(true);
    expect(status(v, 0) & 0x80).toBe(0x80);
    expect(v.irq).toBe(false);
  });

  it('raises the line interrupt at R#19, counted from the scrolled start', () => {
    const v = new V9938();
    reg(v, 0, 0x10);
    reg(v, 19, 100);
    v.endLine(99);
    expect(v.irq).toBe(false);
    v.endLine(100);
    expect(v.irq).toBe(true);
    expect(status(v, 1) & 1).toBe(1);
    expect(v.irq).toBe(false);
    reg(v, 23, 10);
    v.endLine(90);
    expect(v.irq).toBe(true);
  });

  it('identifies itself in S#1 and keeps S#2 bits 3-2 set', () => {
    expect(status(new V9938(), 1) & 0x3e).toBe(0);
    expect(status(new V9938(true), 1) & 0x3e).toBe(0x04);
    expect(status(new V9938(), 2) & 0x0c).toBe(0x0c);
  });

  it('tells HR from the cycle in the line and VR after the picture', () => {
    let c = 0;
    const v = new V9938(false, () => c);
    mode(v, 'G4');
    expect(status(v, 2) & 0x60).toBe(0);
    c = 200;
    expect(status(v, 2) & 0x20).toBe(0x20);
    c = 228 * 195;
    expect(status(v, 2) & 0x40).toBe(0x40);
  });
});

describe('V9938 screen modes', () => {
  it('knows the ten modes from the M bits', () => {
    const v = new V9938();
    for (const m of Object.keys(MODE_BITS)) {
      mode(v, m);
      expect(v.mode).toBe(m);
    }
  });

  it('GRAPHIC4: a nibble a pixel, high nibble on the left, each drawn twice', () => {
    const v = new V9938();
    mode(v, 'G4');
    reg(v, 2, 0x1f);
    v.vram[0] = 0x12;
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(1 === 1 ? 1 : 0).map((x) => x)); // colour 1 (black)
    expect(rgb(px(v, 2, 0))).toEqual(palRgb(2));
    expect(px(v, 2, 0)).toBe(px(v, 3, 0));
  });

  it('GRAPHIC5: four pixels a byte in 512, and colour 0 shows the split border', () => {
    const v = new V9938();
    mode(v, 'G5');
    reg(v, 2, 0x1f);
    v.vram[0] = 0xe4; // 3 2 1 0
    reg(v, 7, 0b1001); // even pixels colour 2, odd colour 1
    draw(v, 0);
    expect([px(v, 0, 0), px(v, 1, 0), px(v, 2, 0)].map(rgb)).toEqual([palRgb(3), palRgb(2), palRgb(1)]);
    expect(rgb(px(v, 3, 0))).toEqual(palRgb(1)); // colour 0 at an odd pixel: R#7 bits 1-0
  });

  it('GRAPHIC6 and 7 interleave VRAM across two banks, for the CPU and the picture', () => {
    const v = new V9938();
    mode(v, 'G6');
    addr(v, 0, true);
    for (const b of [0x12, 0x34, 0x56, 0x78]) v.writeData(b);
    expect([v.vram[0], v.vram[0x10000], v.vram[1], v.vram[0x10001]]).toEqual([0x12, 0x34, 0x56, 0x78]);
    draw(v, 0);
    expect([0, 1, 2, 3, 4, 5].map((x) => rgb(px(v, x, 0)))).toEqual([1, 2, 3, 4, 5, 6].map(palRgb));
    mode(v, 'G7');
    v.vram[0] = 0xe0; // GGG = 7: green
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual([0, 255, 0]);
    v.vram[1] = 0x1c; // physical byte 1 is logical byte 2 in G7: red
    draw(v, 0);
    expect(rgb(px(v, 4, 0))).toEqual([255, 0, 0]);
  });

  it('shows colour 0 as the backdrop, or palette 0 with TP', () => {
    const v = new V9938();
    mode(v, 'G4');
    reg(v, 2, 0x1f);
    reg(v, 7, 4);
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(4));
    reg(v, 8, 0x20);
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(0));
  });

  it('has 212 lines with LN and scrolls with R#23', () => {
    const v = new V9938();
    mode(v, 'G4');
    reg(v, 2, 0x1f);
    reg(v, 9, 0x80);
    v.vram[211 * 128] = 0xff;
    v.vram[1 * 128] = 0xcc;
    v.frameStart();
    expect(v.displayLines).toBe(212);
    v.renderLine(211);
    expect(rgb(px(v, 0, 211))).toEqual(palRgb(15));
    reg(v, 23, 1);
    v.renderLine(0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(12));
  });

  it('TEXT2: 80 columns of 6-pixel characters, and blinking ones in R#12 colours', () => {
    const v = new V9938();
    mode(v, 'T2');
    reg(v, 2, 0x03); // names at 0
    reg(v, 4, 0x02); // patterns at 1000h
    reg(v, 7, 0xf4);
    reg(v, 3, 0x27); reg(v, 10, 0); // blink table at 0800h (R#3 bits 2-0 must be 1)
    v.vram[79] = 65; // 'A' in the last column
    v.vram[0x1000 + 65 * 8] = 0xfc; // six pixels on
    draw(v, 0);
    expect(v.textColumns()).toBe(80);
    expect(rgb(px(v, 16 + 79 * 6, 0))).toEqual(palRgb(15));
    expect(rgb(px(v, 16 + 79 * 6 - 1, 0))).toEqual(palRgb(4));
    v.vram[0x0800 + 9] = 0x01; // blink bit for column 79
    reg(v, 12, 0x86);
    reg(v, 13, 0xf0); // always on
    draw(v, 0);
    expect(rgb(px(v, 16 + 79 * 6, 0))).toEqual(palRgb(8));
  });
});

describe('V9938 sprites', () => {
  /** G4 with sprites mode 2: SAT at 7600h, colours at 7400h, patterns at 7800h. */
  const g4 = () => {
    const v = new V9938();
    mode(v, 'G4');
    reg(v, 2, 0x1f); reg(v, 5, 0xef); reg(v, 11, 0); reg(v, 6, 0x0f);
    for (let i = 0; i < 32; i++) v.vram[0x7600 + i * 4] = 216; // all ended
    v.vram[0x7800] = 0xff; // pattern 0, row 0: full line
    return v;
  };
  const sprite = (v: V9938, n: number, y: number, x: number, colour: number) => {
    v.vram.set([y, x, 0, 0], 0x7600 + n * 4);
    v.vram[0x7400 + n * 16] = colour;
  };

  it('draws a line of a sprite with its per-line colour', () => {
    const v = g4();
    sprite(v, 0, 9, 100, 9);
    draw(v, 10);
    expect(rgb(px(v, 200, 10))).toEqual(palRgb(9));
    expect(rgb(px(v, 216, 10))).not.toEqual(palRgb(9));
  });

  it('shows 8 a line and flags the ninth', () => {
    const v = g4();
    for (let n = 0; n < 9; n++) sprite(v, n, 9, n * 20, 2);
    draw(v, 10);
    expect(status(v, 0) & 0x5f).toBe(0x40 | 8);
  });

  it('ORs the colours of CC sprites and keeps them out of collisions', () => {
    const v = g4();
    sprite(v, 0, 9, 50, 1);
    sprite(v, 1, 9, 50, 0x40 | 2);
    draw(v, 10);
    expect(rgb(px(v, 100, 10))).toEqual(palRgb(3));
    expect(status(v, 0) & 0x20).toBe(0);
    sprite(v, 1, 9, 50, 2); // no CC: a collision
    draw(v, 10);
    expect(status(v, 0) & 0x20).toBe(0x20);
    expect([status(v, 3), status(v, 5)]).toEqual([50 + 12, 10 + 8]);
  });

  it('hides all sprites with SPD', () => {
    const v = g4();
    sprite(v, 0, 9, 100, 9);
    reg(v, 8, 0x02);
    draw(v, 10);
    expect(rgb(px(v, 200, 10))).not.toEqual(palRgb(9));
  });
});

describe('V9938 commands', () => {
  const g4 = () => { const v = new V9938(); mode(v, 'G4'); return v; };

  it('takes its time with a clock: CE stays set until the chip would be done', () => {
    let now = 1000;
    const v = new V9938(false, () => now, true);
    mode(v, 'G4');
    command(v, { nx: 256, ny: 212, clr: 0x44 }, 0xc0); // HMMV, a whole SCREEN 5 page
    expect(v.vram[211 * 128 + 127]).toBe(0x44); // the work is done at once...
    expect(status(v, 2) & 1).toBe(1); // ...but CE says busy
    // 128 x 212 bytes at about 8 cycles, plus rows: some 220,000 cycles, 3.7 frames.
    now += 200_000;
    expect(status(v, 2) & 1).toBe(1);
    now += 30_000;
    expect(status(v, 2) & 1).toBe(0);
    // Blanked screen: faster. And STOP ends it at once.
    reg(v, 1, MODE_BITS.G4[1]);
    command(v, { nx: 256, ny: 212, clr: 0x55 }, 0xc0);
    now += 150_000;
    expect(status(v, 2) & 1).toBe(0);
    command(v, { nx: 256, ny: 212, clr: 0x66 }, 0xc0);
    expect(status(v, 2) & 1).toBe(1);
    command(v, {}, 0x00);
    expect(status(v, 2) & 1).toBe(0);
  });

  it('keeps its busy time across frames (the machine rebases its clock)', () => {
    let now = 0;
    const v = new V9938(false, () => now, true);
    mode(v, 'G4');
    command(v, { nx: 256, ny: 212, clr: 0x44 }, 0xc0);
    now = 59_736; // end of a frame
    v.cmd.rebase(59_736);
    now = 0;
    expect(status(v, 2) & 1).toBe(1);
  });

  it('HMMV fills bytes and leaves DY and NY as the chip does', () => {
    const v = g4();
    command(v, { nx: 256, ny: 212, clr: 0x44 }, 0xc0);
    expect(v.vram[0]).toBe(0x44);
    expect(v.vram[211 * 128 + 127]).toBe(0x44);
    expect(v.vram[212 * 128]).toBe(0);
    expect(status(v, 2) & 1).toBe(0);
    expect([v.regs[38] | (v.regs[39] << 8), v.regs[42] | (v.regs[43] << 8)]).toEqual([212, 0]);
  });

  it('LMMV with logical operations; TIMP skips colour 0', () => {
    const v = g4();
    command(v, { dx: 0, dy: 0, nx: 4, ny: 1, clr: 5 }, 0x80);
    expect([v.vram[0], v.vram[1]]).toEqual([0x55, 0x55]);
    command(v, { dx: 0, dy: 0, nx: 4, ny: 1, clr: 0 }, 0x88); // TIMP 0: nothing
    expect(v.vram[0]).toBe(0x55);
    command(v, { dx: 0, dy: 0, nx: 2, ny: 1, clr: 3 }, 0x83); // XOR
    expect(v.vram[0]).toBe(0x66);
  });

  it('LINE draws NX+1 pixels stepping the minor axis Bresenham-style', () => {
    const v = g4();
    command(v, { dx: 10, dy: 10, nx: 5, ny: 2, clr: 1 }, 0x70);
    const on: string[] = [];
    for (let y = 9; y < 14; y++) for (let x = 8; x < 18; x++) {
      const b = v.vram[y * 128 + (x >> 1)];
      if (((x & 1 ? b : b >> 4) & 15) === 1) on.push(`${x},${y}`);
    }
    expect(on).toEqual(['10,10', '11,10', '12,11', '13,11', '14,12', '15,12']);
  });

  it('PSET, POINT and SRCH', () => {
    const v = g4();
    command(v, { dx: 40, dy: 3, clr: 5 }, 0x50);
    command(v, { sx: 40, sy: 3 }, 0x40);
    expect(status(v, 7)).toBe(5);
    command(v, { sx: 0, sy: 3, clr: 5 }, 0x60);
    expect(status(v, 2) & 0x10).toBe(0x10);
    expect([status(v, 8), status(v, 9)]).toEqual([40, 0xfe]);
  });

  it('clips at the edge and copies with LMMM, HMMM and YMMM', () => {
    const v = g4();
    command(v, { dx: 250, dy: 0, nx: 10, ny: 1, clr: 7 }, 0x80);
    expect(v.vram[127]).toBe(0x77);
    expect(v.vram[128]).toBe(0); // not wrapped onto the next line
    command(v, { sx: 250, sy: 0, dx: 0, dy: 5, nx: 6, ny: 1 }, 0x90);
    expect(v.vram[5 * 128]).toBe(0x77);
    command(v, { sx: 248, sy: 0, dx: 8, dy: 6, nx: 8, ny: 1 }, 0xd0);
    expect(v.vram[6 * 128 + 4 + 1]).toBe(0x77);
    command(v, { sy: 0, dx: 250, dy: 7, ny: 1 }, 0xe0);
    expect(v.vram[7 * 128 + 127]).toBe(0x77);
    expect(v.vram[7 * 128 + 124]).toBe(0); // only from DX to the edge
  });

  it('HMMC, LMMC and LMCM move data with the CPU, the first datum pre-written', () => {
    const v = g4();
    command(v, { dx: 0, dy: 0, nx: 4, ny: 1, clr: 0x12 }, 0xf0);
    expect(status(v, 2) & 0x81).toBe(0x81); // CE and TR
    reg(v, 44, 0x34);
    expect(status(v, 2) & 1).toBe(0); // done after two bytes
    expect([v.vram[0], v.vram[1]]).toEqual([0x12, 0x34]);
    reg(v, 44, 0x99); // extra writes are harmless
    expect(v.vram[2]).toBe(0);
    command(v, { dx: 0, dy: 1, nx: 2, ny: 1, clr: 6 }, 0xb0);
    reg(v, 44, 7);
    expect(v.vram[128]).toBe(0x67);
    command(v, { sx: 0, sy: 1, nx: 2, ny: 1 }, 0xa0);
    expect(status(v, 7)).toBe(6);
    expect(status(v, 7)).toBe(7);
    expect(status(v, 2) & 1).toBe(0);
  });

  it('works in GRAPHIC6 and 7 through the interleave, and not at all in GRAPHIC1', () => {
    const v = new V9938();
    mode(v, 'G7');
    command(v, { dx: 1, dy: 0, nx: 1, ny: 1, clr: 0xab }, 0xc0);
    expect(v.vram[0x10000]).toBe(0xab); // logical byte 1
    mode(v, 'G6');
    command(v, { dx: 2, dy: 0, clr: 9 }, 0x50); // logical byte 1, high nibble
    expect(v.vram[0x10000] >> 4).toBe(9);
    const w = new V9938();
    mode(w, 'G1');
    command(w, { nx: 8, ny: 8, clr: 0xff }, 0xc0);
    expect(w.vram.some((b) => b)).toBe(false);
    expect(status(w, 2) & 1).toBe(0);
  });
});

describe('V9958', () => {
  it('shows YJK: with J = K = 0, red and green are Y and blue is (5Y + 2) / 4', () => {
    const v = new V9938(true);
    mode(v, 'G7');
    reg(v, 25, 0x08);
    for (let i = 0; i < 4; i++) v.vram[i & 1 ? 0x10000 + (i >> 1) : i >> 1] = 16 << 3;
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual([132, 132, 165]); // Y = 16: r = g = 16, b = 20 of 31
  });

  it('shows palette pixels among YJK ones with YAE', () => {
    const v = new V9938(true);
    mode(v, 'G7');
    reg(v, 25, 0x18);
    v.vram[0] = (9 << 4) | 0x08;
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(9));
  });

  it('scrolls horizontally with R#26/R#27', () => {
    const v = new V9938(true);
    mode(v, 'G4');
    reg(v, 2, 0x1f);
    v.vram[4] = 0xf0; // pixel 8 is colour 15
    reg(v, 26, 1);
    draw(v, 0);
    expect(rgb(px(v, 0, 0))).toEqual(palRgb(15));
  });
});
