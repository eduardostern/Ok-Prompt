/**
 * The TMS9918A video chip of the MSX1: 16K of its own VRAM, eight write-only
 * registers and a status register, reached through I/O 98h (data) and 99h
 * (control and status).
 *
 * Screen modes, from the mode bits M1 (R1 bit 4), M2 (R1 bit 3) and M3
 * (R0 bit 1):
 *
 * - Graphics I (SCREEN 1): 32x24 characters, colours per group of 8.
 * - Graphics II (SCREEN 2): 32x24 characters in three thirds, colours per
 *   pixel row of each character.
 * - Multicolour (SCREEN 3): 64x48 blocks of 4x4 pixels.
 * - Text (SCREEN 0): 40x24 characters 6 pixels wide, no sprites.
 *
 * Sprites: 32 of them, 8x8 or 16x16, optionally magnified, at most four on
 * a line (the fifth sets the 5S flag), with collision detection.
 *
 * The machine calls `renderLine` as the beam passes each of the 192 picture
 * lines, so register changes in mid-frame show where they happen, and
 * `vblank` after the last one: that sets the F flag and, with IE (R1 bit 5),
 * holds the CPU's interrupt line until the status register is read.
 */

/** TMS9918A colours as RGB, colour 0 (transparent) drawn as black. */
export const PALETTE: [number, number, number][] = [
  [0, 0, 0], [0, 0, 0], [33, 200, 66], [94, 220, 120],
  [84, 85, 237], [125, 118, 252], [212, 82, 77], [66, 235, 245],
  [252, 85, 84], [255, 121, 120], [212, 193, 84], [230, 206, 128],
  [33, 176, 59], [201, 91, 186], [204, 204, 204], [255, 255, 255],
];

/** The picture with its border, in pixels. */
export const BORDER_X = 16;
export const BORDER_Y = 16;
export const WIDTH = 256 + 2 * BORDER_X;
export const HEIGHT = 192 + 2 * BORDER_Y;

/** Colours packed for a little-endian Uint32Array over RGBA bytes. */
const RGBA = new Uint32Array(PALETTE.map(([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r));

export class Vdp {
  readonly vram = new Uint8Array(0x4000);
  readonly regs = new Uint8Array(8);
  status = 0;
  /** The frame as RGBA pixels, WIDTH x HEIGHT. */
  readonly frame = new Uint32Array(WIDTH * HEIGHT);

  private addr = 0;
  private latched = false;
  private latch = 0;
  private readAhead = 0;

  /** Per-line sprite work buffers. */
  private spriteColor = new Uint8Array(256);
  private spriteHit = new Uint8Array(256);

  reset(): void {
    this.vram.fill(0);
    this.regs.fill(0);
    this.status = 0;
    this.addr = 0;
    this.latched = false;
    this.readAhead = 0;
    this.frame.fill(RGBA[1]);
  }

  /** The interrupt line: F set and interrupts enabled. */
  get irq(): boolean {
    return (this.status & 0x80) !== 0 && (this.regs[1] & 0x20) !== 0;
  }

  // ---- ports -----------------------------------------------------------

  readData(): number {
    const v = this.readAhead;
    this.readAhead = this.vram[this.addr];
    this.addr = (this.addr + 1) & 0x3fff;
    this.latched = false;
    return v;
  }

  writeData(value: number): void {
    this.vram[this.addr] = value;
    this.readAhead = value;
    this.addr = (this.addr + 1) & 0x3fff;
    this.latched = false;
  }

  readStatus(): number {
    const v = this.status;
    this.status &= 0x1f; // reading clears F, 5S and C
    this.latched = false;
    return v;
  }

  writeControl(value: number): void {
    if (!this.latched) {
      this.latch = value;
      this.addr = (this.addr & 0x3f00) | value;
      this.latched = true;
      return;
    }
    this.latched = false;
    if (value & 0x80) {
      this.regs[value & 7] = this.latch;
      return;
    }
    this.addr = ((value & 0x3f) << 8) | this.latch;
    if (!(value & 0x40)) {
      // Set up for reading: the chip fetches the first byte ahead.
      this.readAhead = this.vram[this.addr];
      this.addr = (this.addr + 1) & 0x3fff;
    }
  }

  // ---- the picture -------------------------------------------------------

  private get backdrop(): number {
    return this.regs[7] & 0x0f;
  }

  /** The end of the picture: F flag, and the border lines of this frame. */
  vblank(): void {
    this.status |= 0x80;
    const c = RGBA[this.backdrop];
    this.frame.fill(c, 0, BORDER_Y * WIDTH);
    this.frame.fill(c, (BORDER_Y + 192) * WIDTH);
  }

  /** Draws picture line `y` (0-191) with the registers as they are now. */
  renderLine(y: number): void {
    const out = (BORDER_Y + y) * WIDTH;
    const back = this.backdrop;
    const fb = this.frame;
    fb.fill(RGBA[back], out, out + WIDTH);
    if (!(this.regs[1] & 0x40)) return; // display blanked
    const px = out + BORDER_X;
    const r0 = this.regs[0];
    const r1 = this.regs[1];
    const text = (r1 & 0x10) !== 0;
    const multi = (r1 & 0x08) !== 0;
    const g2 = (r0 & 0x02) !== 0;

    if (text) this.textLine(y, px, back);
    else if (multi) this.multiLine(y, px, back);
    else this.graphicsLine(y, px, back, g2);

    if (!text) this.spriteLine(y, px);
  }

  private put(i: number, colour: number, back: number): void {
    this.frame[i] = RGBA[colour || back];
  }

  private textLine(y: number, px: number, back: number): void {
    const v = this.vram;
    const nt = (this.regs[2] & 0x0f) << 10;
    const pg = (this.regs[4] & 0x07) << 11;
    const fg = this.regs[7] >> 4;
    const row = (y >> 3) * 40;
    let x = px + 8;
    for (let col = 0; col < 40; col++) {
      const bits = v[pg + (v[nt + row + col] << 3) + (y & 7)];
      for (let b = 0; b < 6; b++) this.put(x++, bits & (0x80 >> b) ? fg : back, back);
    }
  }

  private multiLine(y: number, px: number, back: number): void {
    const v = this.vram;
    const nt = (this.regs[2] & 0x0f) << 10;
    const pg = (this.regs[4] & 0x07) << 11;
    const row = (y >> 3) * 32;
    let x = px;
    for (let col = 0; col < 32; col++) {
      const name = v[nt + row + col];
      const c = v[pg + (name << 3) + (((y >> 3) & 3) << 1) + ((y >> 2) & 1)];
      for (let b = 0; b < 4; b++) this.put(x++, c >> 4, back);
      for (let b = 0; b < 4; b++) this.put(x++, c & 0x0f, back);
    }
  }

  private graphicsLine(y: number, px: number, back: number, g2: boolean): void {
    const v = this.vram;
    const r3 = this.regs[3];
    const r4 = this.regs[4];
    const nt = (this.regs[2] & 0x0f) << 10;
    const row = (y >> 3) * 32;
    const line = y & 7;
    let x = px;
    for (let col = 0; col < 32; col++) {
      const name = v[nt + row + col];
      let bits: number;
      let colour: number;
      if (g2) {
        // Each third of the screen has its own 256 patterns and colours,
        // masked by the low bits of R3 and R4.
        const ch = ((y >> 6) << 8) | name;
        bits = v[((r4 & 0x04) << 11) | ((ch & (((r4 & 0x03) << 8) | 0xff)) << 3) | line];
        colour = v[((r3 & 0x80) << 6) | (((ch << 3) | line) & (((r3 & 0x7f) << 6) | 0x3f))];
      } else {
        bits = v[((r4 & 0x07) << 11) + (name << 3) + line];
        colour = v[(r3 << 6) + (name >> 3)];
      }
      const fg = colour >> 4;
      const bg = colour & 0x0f;
      for (let b = 0; b < 8; b++) this.put(x++, bits & (0x80 >> b) ? fg : bg, back);
    }
  }

  private spriteLine(y: number, px: number): void {
    const v = this.vram;
    const r1 = this.regs[1];
    const sat = (this.regs[5] & 0x7f) << 7;
    const spg = (this.regs[6] & 0x07) << 11;
    const big = (r1 & 0x02) !== 0;
    const mag = (r1 & 0x01) !== 0;
    const size = (big ? 16 : 8) * (mag ? 2 : 1);
    const colours = this.spriteColor;
    const hits = this.spriteHit;
    colours.fill(0);
    hits.fill(0);
    let shown = 0;
    let n = 0;
    for (; n < 32; n++) {
      const a = sat + n * 4;
      let sy = v[a];
      if (sy === 0xd0) break; // end of the list
      if (sy > 0xe0) sy -= 256; // partly above the top
      const dy = y - (sy + 1);
      if (dy < 0 || dy >= size) continue;
      if (shown === 4) {
        // A fifth sprite on this line: flag it (once) and draw no more.
        if (!(this.status & 0x40)) this.status = (this.status & 0xa0) | 0x40 | n;
        break;
      }
      shown++;
      const attr = v[a + 3];
      let sx = v[a + 1] - (attr & 0x80 ? 32 : 0);
      const colour = attr & 0x0f;
      const r = mag ? dy >> 1 : dy;
      const pat = big ? v[a + 2] & 0xfc : v[a + 2];
      const base = spg + (pat << 3) + r;
      const bits = big ? (v[base] << 8) | v[base + 16] : v[base] << 8;
      const width = big ? 16 : 8;
      const step = mag ? 2 : 1;
      for (let i = 0; i < width; i++) {
        const on = bits & (0x8000 >> i);
        for (let m = 0; m < step; m++, sx++) {
          if (!on || sx < 0 || sx > 255) continue;
          if (hits[sx]) this.status |= 0x20; // collision
          hits[sx] = 1;
          // A lower-numbered sprite stays in front.
          if (!colours[sx] && colour) colours[sx] = colour;
        }
      }
    }
    if (!(this.status & 0x40)) this.status = (this.status & 0xe0) | Math.min(n, 31);
    for (let x = 0; x < 256; x++) if (colours[x]) this.frame[px + x] = RGBA[colours[x]];
  }
}
