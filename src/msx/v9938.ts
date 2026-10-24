/**
 * The V9938 video chip of the MSX2, and the V9958 of the MSX2+ (`v9958`).
 * docs/v9938.md is the spec this follows, section by section.
 *
 * 128K of VRAM; ports 98h (data), 99h (control and status), 9Ah (palette)
 * and 9Bh (indirect registers); registers R#0-R#46 (R#25-R#27 on the
 * V9958); status registers S#0-S#9; a 16-colour palette of 9-bit colours.
 * Ten screen modes: TEXT1 and TEXT2 (80 columns), MULTICOLOUR, GRAPHIC1-3
 * and the bitmaps GRAPHIC4-7 (SCREEN 5-8; YJK SCREEN 10-12 on the V9958).
 * Sprites mode 1 (as the TMS9918A) and mode 2 (8 a line, a colour per line).
 * Line interrupts, vertical scroll, 192 or 212 lines. The command engine is
 * in v9938-cmd.ts.
 *
 * The frame is 576 x 240: 512 pixels plus borders, 256-pixel modes drawn
 * twice as wide; 212 picture lines from row 14, 192 from row 24.
 */
import { CmdMode, CommandEngine } from './v9938-cmd';
import type { VideoChip } from './video';

export const V_BORDER_X = 32;
export const V_WIDTH = 512 + 2 * V_BORDER_X;
export const V_HEIGHT = 240;

/** The palette the MSX2 BIOS sets (0x0GRB), also loaded at reset. */
export const MSX2_PALETTE = [
  0x000, 0x000, 0x611, 0x733, 0x117, 0x327, 0x151, 0x627,
  0x171, 0x373, 0x661, 0x664, 0x411, 0x265, 0x555, 0x777,
];
/** Sprite colours in GRAPHIC7, which has no palette (0x0GRB). */
const G7_SPRITES = [
  0x000, 0x002, 0x030, 0x032, 0x300, 0x302, 0x330, 0x332,
  0x472, 0x007, 0x070, 0x077, 0x700, 0x707, 0x770, 0x777,
];
const MASKS = [
  0x7e, 0x7f, 0x7f, 0xff, 0x3f, 0xff, 0x3f, 0xff, 0xfb, 0xbf, 0x07, 0x03, 0xff, 0xff, 0x07, 0x0f,
  0x0f, 0xbf, 0xff, 0xff, 0x3f, 0x3f, 0x3f, 0xff,
];

export type Mode = 'T1' | 'T2' | 'MC' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'none';
const MODES: Record<number, Mode> = { 16: 'T1', 18: 'T2', 8: 'MC', 0: 'G1', 4: 'G2', 2: 'G3', 6: 'G4', 1: 'G5', 5: 'G6', 7: 'G7' };

const rgba = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const c3 = (v: number) => Math.round((v * 255) / 7);
const grb = (v: number) => rgba(c3((v >> 4) & 7), c3((v >> 8) & 7), c3(v & 7));
const phys = (l: number) => ((l << 16) | (l >> 1)) & 0x1ffff;
const clamp31 = (v: number) => (v < 0 ? 0 : v > 31 ? 31 : v);

/** GRAPHIC7's 256 fixed colours, GGGRRRBB. */
const G7 = new Uint32Array(256).map((_, i) => rgba(c3((i >> 2) & 7), c3(i >> 5), c3(((i & 3) << 1) | ((i & 3) >> 1))));
const G7S = new Uint32Array(G7_SPRITES.map(grb));

export class V9938 implements VideoChip {
  readonly vram = new Uint8Array(0x20000);
  readonly regs = new Uint8Array(64);
  readonly palette = new Uint16Array(16);
  readonly frame = new Uint32Array(V_WIDTH * V_HEIGHT);
  readonly width = V_WIDTH;
  readonly height = V_HEIGHT;
  readonly cmd: CommandEngine;

  /** Palette entries as RGBA. */
  private pal = new Uint32Array(16);
  private ptr = 0;
  private latch = 0;
  private latched = false;
  private readAhead = 0;
  private palLatch = 0;
  private palPhase = false;
  private s0 = 0;
  private fh = false;
  private colX = 0;
  private colY = 0;
  private blinkState = false;
  private blinkCount = 0;
  private lines: 192 | 212 = 192;
  private ntsc = true;
  /** One picture line, 512 pixels, before it goes into the frame. */
  private line = new Uint32Array(512);
  private spriteCol = new Int16Array(256);
  private spriteOwner = new Int8Array(256);
  private spriteHit = new Uint8Array(256);

  /**
   * `now` gives the CPU cycle count since the frame started (for the HR
   * and VR flags of S#2).
   */
  constructor(readonly v9958 = false, private readonly now: () => number = () => 0) {
    this.cmd = new CommandEngine({ vram: this.vram, regs: this.regs, cmdMode: () => this.cmdMode() });
    this.reset();
  }

  reset(): void {
    this.vram.fill(0);
    this.regs.fill(0);
    for (let i = 0; i < 16; i++) this.setPalette(i, MSX2_PALETTE[i]);
    this.ptr = this.latch = this.readAhead = this.palLatch = 0;
    this.latched = this.palPhase = false;
    this.s0 = 0;
    this.fh = false;
    this.colX = this.colY = 0;
    this.blinkState = false;
    this.blinkCount = 0;
    this.lines = 192;
    this.ntsc = true;
    this.cmd.reset();
    this.frame.fill(this.pal[0]);
  }

  // ---- state -----------------------------------------------------------------

  get mode(): Mode {
    const r0 = this.regs[0], r1 = this.regs[1];
    const bits = (((r1 >> 4) & 1) << 4) | (((r1 >> 3) & 1) << 3) | (((r0 >> 1) & 1) << 2) | (((r0 >> 2) & 1) << 1) | ((r0 >> 3) & 1);
    return MODES[bits] ?? 'none';
  }

  /** GRAPHIC6 and 7 store VRAM interleaved across two banks. */
  private get planar(): boolean {
    const m = this.mode;
    return m === 'G6' || m === 'G7';
  }

  get displayLines(): number {
    return this.lines;
  }

  /** R#9 NT as latched at the start of the frame: 313 lines (PAL) when false. */
  get isNtsc(): boolean {
    return this.ntsc;
  }

  get irq(): boolean {
    return ((this.s0 & 0x80) !== 0 && (this.regs[1] & 0x20) !== 0) || (this.fh && (this.regs[0] & 0x10) !== 0);
  }

  textColumns(): number {
    const m = this.mode;
    return m === 'T1' ? 40 : m === 'T2' ? 80 : m === 'G1' ? 32 : 0;
  }

  private setPalette(i: number, v: number): void {
    this.palette[i] = v;
    this.pal[i] = grb(v);
  }

  /** Reads VRAM at a logical address (through the interleave in G6/G7). */
  private rd(l: number): number {
    return this.vram[this.planar ? phys(l) : l & 0x1ffff];
  }

  cmdMode(): CmdMode | null {
    switch (this.mode) {
      case 'G4': return { width: 256, shift: 1, ymask: 1023, pitch: 128, planar: false };
      case 'G5': return { width: 512, shift: 2, ymask: 1023, pitch: 128, planar: false };
      case 'G6': return { width: 512, shift: 1, ymask: 511, pitch: 256, planar: true };
      case 'G7': return { width: 256, shift: 0, ymask: 511, pitch: 256, planar: true };
    }
    if (this.v9958 && this.regs[25] & 0x40) return { width: 256, shift: 0, ymask: 511, pitch: 256, planar: false };
    return null;
  }

  // ---- ports -------------------------------------------------------------------

  private get cpuAddr(): number {
    const a = ((this.regs[14] & 7) << 14) | this.ptr;
    return this.planar ? phys(a) : a;
  }

  private increment(): void {
    this.ptr = (this.ptr + 1) & 0x3fff;
    // The carry into R#14 only in the V9938's own modes (M4 or M5 set).
    if (this.ptr === 0 && this.regs[0] & 0x0c) this.regs[14] = (this.regs[14] + 1) & 7;
  }

  readData(): number {
    const v = this.readAhead;
    this.readAhead = this.vram[this.cpuAddr];
    this.increment();
    this.latched = false;
    return v;
  }

  writeData(value: number): void {
    this.vram[this.cpuAddr] = value;
    this.readAhead = value;
    this.increment();
    this.latched = false;
  }

  writeControl(value: number): void {
    if (!this.latched) {
      this.latch = value;
      this.latched = true;
      return;
    }
    this.latched = false;
    if (value & 0x80) {
      this.writeReg(value & 0x3f, this.latch);
      return;
    }
    this.ptr = ((value & 0x3f) << 8) | this.latch;
    if (!(value & 0x40)) {
      this.readAhead = this.vram[this.cpuAddr];
      this.increment();
    }
  }

  writePalette(value: number): void {
    if (!this.palPhase) {
      this.palLatch = value;
      this.palPhase = true;
      return;
    }
    const n = this.regs[16] & 15;
    this.setPalette(n, ((value & 7) << 8) | (this.palLatch & 0x77));
    this.regs[16] = (n + 1) & 15;
    this.palPhase = false;
  }

  writeIndirect(value: number): void {
    const n = this.regs[17] & 0x3f;
    if (n !== 17) this.writeReg(n, value);
    if (!(this.regs[17] & 0x80)) this.regs[17] = (this.regs[17] & 0x80) | ((n + 1) & 0x3f);
  }

  /** Writes register n with its mask and side effects. */
  writeReg(n: number, v: number): void {
    if (n >= 47 || n === 24 || (n >= 28 && n <= 31)) return;
    if (n >= 25 && n <= 27) {
      if (!this.v9958) return;
      this.regs[n] = v & [0x7f, 0x3f, 0x07][n - 25];
      return;
    }
    if (n >= 32) { this.cmd.write(n, v); return; }
    this.regs[n] = v & MASKS[n];
    switch (n) {
      case 0: if (!(v & 0x10)) this.fh = false; break;
      case 13: this.resetBlink(); break;
      case 16: this.palPhase = false; break;
    }
  }

  readStatus(): number {
    this.latched = false;
    switch (this.regs[15] & 15) {
      case 0: {
        const v = this.s0;
        this.s0 &= 0x1f;
        return v;
      }
      case 1: {
        const v = (this.fh ? 1 : 0) | (this.v9958 ? 0x04 : 0);
        this.fh = false;
        return v;
      }
      case 2: {
        const c = this.now();
        const line = Math.floor(c / 228);
        const text = this.mode === 'T1' || this.mode === 'T2';
        const hr = c % 228 >= 228 - (text ? 67 : 52);
        const vr = line >= this.lines;
        return (this.cmd.tr ? 0x80 : 0) | (vr ? 0x40 : 0) | (hr ? 0x20 : 0) | (this.cmd.bd ? 0x10 : 0) | 0x0c | (this.cmd.ce ? 1 : 0);
      }
      case 3: return this.colX & 0xff;
      case 4: return 0xfe | ((this.colX >> 8) & 1);
      case 5: {
        const v = this.colY & 0xff;
        this.colX = this.colY = 0;
        return v;
      }
      case 6: return 0xfc | ((this.colY >> 8) & 3);
      case 7: return this.cmd.readColor();
      case 8: return this.cmd.borderX & 0xff;
      case 9: return 0xfe | ((this.cmd.borderX >> 8) & 1);
      default: return 0xff;
    }
  }

  // ---- frame timing ------------------------------------------------------------

  private resetBlink(): void {
    const v = this.regs[13];
    if (v & 0xf0 && v & 0x0f) {
      this.blinkState = true;
      this.blinkCount = (v >> 4) * 10;
    } else {
      this.blinkState = (v & 0xf0) !== 0;
      this.blinkCount = 0;
    }
  }

  frameStart(): void {
    this.lines = this.regs[9] & 0x80 ? 212 : 192;
    this.ntsc = !(this.regs[9] & 0x02);
    if (this.blinkCount && --this.blinkCount === 0) {
      this.blinkState = !this.blinkState;
      const v = this.regs[13];
      this.blinkCount = (this.blinkState ? v >> 4 : v & 15) * 10;
    }
  }

  endLine(line: number): void {
    if (line === ((this.regs[19] - this.regs[23]) & 0xff)) this.fh = true;
  }

  vblank(): void {
    this.s0 |= 0x80;
    const top = this.top();
    for (let y = 0; y < V_HEIGHT; y++) {
      if (y >= top && y < top + this.lines) continue;
      this.fillBorder(y);
    }
  }

  private top(): number {
    return this.lines === 212 ? 14 : 24;
  }

  // ---- colours -------------------------------------------------------------------

  /** Fills a frame row with the border colour. */
  private fillBorder(y: number): void {
    const row = y * V_WIDTH;
    const m = this.mode;
    const r7 = this.regs[7];
    if (m === 'G5') {
      const even = this.pal[(r7 >> 2) & 3], odd = this.pal[r7 & 3];
      for (let x = 0; x < V_WIDTH; x++) this.frame[row + x] = x & 1 ? odd : even;
    } else {
      this.frame.fill(m === 'G7' ? G7[r7] : this.pal[r7 & 15], row, row + V_WIDTH);
    }
  }

  /** A pixel colour: colour 0 is the backdrop unless TP (R#8 bit 5). */
  private c(i: number): number {
    if (i === 0 && !(this.regs[8] & 0x20)) return this.pal[this.regs[7] & 15];
    return this.pal[i];
  }

  // ---- the picture ---------------------------------------------------------------

  renderLine(y: number): void {
    if (y >= this.lines) return;
    const fy = this.top() + y;
    this.fillBorder(fy);
    const r1 = this.regs[1];
    if (!(r1 & 0x40)) return; // blanked
    const line = this.line;
    const l = (y + this.regs[23]) & 0xff;
    const mode = this.mode;
    switch (mode) {
      case 'T1': this.text1(l); break;
      case 'T2': this.text2(l); break;
      case 'MC': this.multi(l); break;
      case 'G1': this.g1(l); break;
      case 'G2': case 'G3': this.g23(l); break;
      case 'G4': this.g4(l); break;
      case 'G5': this.g5(l); break;
      case 'G6': this.g6(l); break;
      case 'G7': this.g7(l); break;
      default: line.fill(this.pal[15]); break;
    }
    if (mode !== 'T1' && mode !== 'T2' && mode !== 'none' && !(this.regs[8] & 0x02)) {
      const two = mode !== 'G1' && mode !== 'G2' && mode !== 'MC';
      this.sprites(l, y, two, mode);
    }
    if (this.v9958 && this.regs[25] & 0x02) line.fill(this.borderAt(), 0, 16); // MSK
    this.frame.set(line, fy * V_WIDTH + V_BORDER_X);
  }

  private borderAt(): number {
    const m = this.mode;
    return m === 'G7' ? G7[this.regs[7]] : this.pal[this.regs[7] & (m === 'G5' ? 3 : 15)];
  }

  /** Two pixels for one 256-space pixel. */
  private put2(x: number, c: number): void {
    this.line[x * 2] = c;
    this.line[x * 2 + 1] = c;
  }

  private text1(l: number): void {
    const r = this.regs;
    const nt = (r[2] & 0x7f) << 10;
    const pg = (r[4] & 0x3f) << 11;
    const fg = this.c(r[7] >> 4), bg = this.c(r[7] & 15);
    this.line.fill(this.pal[r[7] & 15]);
    const row = l >> 3;
    let x = 16;
    for (let col = 0; col < 40; col++) {
      const bits = this.vram[pg | (this.vram[(nt | (row * 40 + col)) & 0x1ffff] << 3) | (l & 7)];
      for (let b = 0; b < 6; b++, x += 2) {
        const c = bits & (0x80 >> b) ? fg : bg;
        this.line[x] = c;
        this.line[x + 1] = c;
      }
    }
  }

  private text2(l: number): void {
    const r = this.regs;
    const nameBase = ((r[2] & 0x7f) << 10) | 0x3ff;
    const blinkBase = ((r[10] & 7) << 14) | (r[3] << 6) | 0x1ff;
    const pg = (r[4] & 0x3f) << 11;
    const fg = this.c(r[7] >> 4), bg = this.c(r[7] & 15);
    const bfg = this.c(r[12] >> 4), bbg = this.c(r[12] & 15);
    this.line.fill(this.pal[r[7] & 15]);
    const row = l >> 3;
    let x = 16;
    for (let col = 0; col < 80; col++) {
      const name = this.vram[nameBase & (0x1f000 | (row * 80 + col))];
      const bits = this.vram[pg | (name << 3) | (l & 7)];
      const blink = this.blinkState && (this.vram[blinkBase & (0x1fe00 | (row * 10 + (col >> 3)))] >> (7 - (col & 7))) & 1;
      const f = blink ? bfg : fg, b = blink ? bbg : bg;
      for (let i = 0; i < 6; i++) this.line[x++] = bits & (0x80 >> i) ? f : b;
    }
  }

  private multi(l: number): void {
    const r = this.regs;
    const nt = (r[2] & 0x7f) << 10;
    const pg = (r[4] & 0x3f) << 11;
    const row = l >> 3;
    for (let col = 0; col < 32; col++) {
      const name = this.vram[nt | (row * 32 + col)];
      const v = this.vram[pg | (name << 3) | ((row & 3) << 1) | ((l >> 2) & 1)];
      const a = this.c(v >> 4), b = this.c(v & 15);
      for (let i = 0; i < 4; i++) this.put2(col * 8 + i, a);
      for (let i = 4; i < 8; i++) this.put2(col * 8 + i, b);
    }
  }

  private g1(l: number): void {
    const r = this.regs;
    const nt = (r[2] & 0x7f) << 10;
    const pg = (r[4] & 0x3f) << 11;
    const ct = ((r[10] & 7) << 14) | (r[3] << 6);
    const row = l >> 3;
    for (let col = 0; col < 32; col++) {
      const name = this.vram[nt | (row * 32 + col)];
      const bits = this.vram[pg | (name << 3) | (l & 7)];
      const colour = this.vram[ct | (name >> 3)];
      const f = this.c(colour >> 4), b = this.c(colour & 15);
      for (let i = 0; i < 8; i++) this.put2(col * 8 + i, bits & (0x80 >> i) ? f : b);
    }
  }

  private g23(l: number): void {
    const r = this.regs;
    const nt = (r[2] & 0x7f) << 10;
    const pgBase = ((r[4] & 0x3f) << 11) | 0x7ff;
    const ctBase = ((r[10] & 7) << 14) | (r[3] << 6) | 0x3f;
    const row = l >> 3;
    for (let col = 0; col < 32; col++) {
      const ch = ((l >> 6) << 8) | this.vram[nt | (row * 32 + col)];
      const idx = 0x1e000 | (ch << 3) | (l & 7);
      const bits = this.vram[pgBase & idx];
      const colour = this.vram[ctBase & idx];
      const f = this.c(colour >> 4), b = this.c(colour & 15);
      for (let i = 0; i < 8; i++) this.put2(col * 8 + i, bits & (0x80 >> i) ? f : b);
    }
  }

  /** The V9958's horizontal scroll, in 256-space dots. */
  private hscroll(): number {
    if (!this.v9958) return 0;
    return (this.regs[26] * 8 - (this.regs[27] & 7)) & 0xff;
  }

  private g4(l: number): void {
    const base = ((this.regs[2] & 0x7f) << 10) | 0x3ff;
    const s = this.hscroll();
    for (let x = 0; x < 256; x++) {
      const lx = (x + s) & 0xff;
      const b = this.vram[base & (0x18000 | (l << 7) | (lx >> 1))];
      this.put2(x, this.c(lx & 1 ? b & 15 : b >> 4));
    }
  }

  private g5(l: number): void {
    const base = ((this.regs[2] & 0x7f) << 10) | 0x3ff;
    const s = this.hscroll() * 2;
    const r7 = this.regs[7];
    const tp = this.regs[8] & 0x20;
    for (let x = 0; x < 512; x++) {
      const lx = (x + s) & 0x1ff;
      const b = this.vram[base & (0x18000 | (l << 7) | (lx >> 2))];
      const v = (b >> ((~lx & 3) << 1)) & 3;
      // Colour 0 shows the border's own even/odd colours (R#7).
      this.line[x] = v === 0 && !tp ? this.pal[x & 1 ? r7 & 3 : (r7 >> 2) & 3] : this.pal[v];
    }
  }

  private g6(l: number): void {
    const page = (this.regs[2] & 0x20) << 11;
    const s = this.hscroll() * 2;
    for (let x = 0; x < 512; x++) {
      const lx = (x + s) & 0x1ff;
      const b = this.vram[phys(page | (l << 8) | (lx >> 1))];
      this.line[x] = this.c(lx & 1 ? b & 15 : b >> 4);
    }
  }

  private g7(l: number): void {
    const page = (this.regs[2] & 0x20) << 11;
    const s = this.hscroll();
    const r25 = this.v9958 ? this.regs[25] : 0;
    const row = page | (l << 8);
    const byte = (x: number) => this.vram[phys(row | ((x + s) & 0xff))];
    if (r25 & 0x08) { this.yjk(byte, (r25 & 0x10) !== 0); return; }
    const tp = this.regs[8] & 0x20;
    for (let x = 0; x < 256; x++) {
      const v = byte(x);
      this.put2(x, v === 0 && !tp ? G7[this.regs[7]] : G7[v]);
    }
  }

  /** SCREEN 10-12 on the V9958: YJK, and with YAE palette pixels among them. */
  private yjk(byte: (x: number) => number, yae: boolean): void {
    for (let x = 0; x < 256; x += 4) {
      const p0 = byte(x), p1 = byte(x + 1), p2 = byte(x + 2), p3 = byte(x + 3);
      const k = (p0 & 7) + ((p1 & 3) << 3) - ((p1 & 4) << 3);
      const j = (p2 & 7) + ((p3 & 3) << 3) - ((p3 & 4) << 3);
      [p0, p1, p2, p3].forEach((p, i) => {
        if (yae && p & 0x08) { this.put2(x + i, this.c(p >> 4)); return; }
        const y = p >> 3;
        const r = clamp31(y + j), g = clamp31(y + k), b = clamp31(Math.trunc((5 * y - 2 * j - k + 2) / 4));
        this.put2(x + i, rgba(Math.round((r * 255) / 31), Math.round((g * 255) / 31), Math.round((b * 255) / 31)));
      });
    }
  }

  // ---- sprites ---------------------------------------------------------------------

  private sprites(l: number, y: number, mode2: boolean, mode: Mode): void {
    const r = this.regs;
    const big = (r[1] & 0x02) !== 0;
    const mag = (r[1] & 0x01) !== 0;
    const size = (big ? 16 : 8) * (mag ? 2 : 1);
    const spg = (r[6] & 0x3f) << 11;
    const tp = (r[8] & 0x20) !== 0;
    const satBase = ((r[11] & 3) << 15) | (r[5] << 7);
    const B = satBase | 0x7f;
    const attr = (i: number) => (mode2 ? this.rd(B & (0x1fc00 | 0x200 | i)) : this.rd((satBase & 0x1ff80) | i));
    const end = mode2 ? 216 : 208;
    const most = mode2 ? 8 : 4;
    const col = this.spriteCol, owner = this.spriteOwner, hit = this.spriteHit;
    col.fill(0);
    owner.fill(-1);
    hit.fill(0);
    let shown = 0;
    let group = -1;
    let n = 0;
    for (; n < 32; n++) {
      const sy = attr(n * 4);
      if (sy === end) break;
      const dy = (l - sy - 1) & 0xff;
      if (dy >= size) continue;
      if (shown === most) {
        if (!(this.s0 & 0x40)) this.s0 = (this.s0 & 0xa0) | 0x40 | n;
        break;
      }
      shown++;
      const row = mag ? dy >> 1 : dy;
      let x = attr(n * 4 + 1);
      const pat = big ? attr(n * 4 + 2) & 0xfc : attr(n * 4 + 2);
      let colour: number;
      let collides = true;
      if (mode2) {
        const cb = this.rd(B & (0x1fc00 | (n * 16 + row)));
        if (cb & 0x80) x -= 32;
        colour = cb & 15;
        if (cb & 0x40) {
          if (group < 0) continue; // CC with no sprite before it: not shown
        } else {
          group = n;
        }
        if (cb & 0x60) collides = false;
      } else {
        const a3 = attr(n * 4 + 3);
        if (a3 & 0x80) x -= 32;
        colour = a3 & 15;
        group = n;
      }
      if (colour === 0 && !tp) collides = false;
      const base = spg + (pat << 3) + row;
      const bits = big ? (this.rd(base) << 8) | this.rd(base + 16) : this.rd(base) << 8;
      const w = big ? 16 : 8;
      const step = mag ? 2 : 1;
      for (let i = 0; i < w; i++) {
        if (!(bits & (0x8000 >> i))) { x += step; continue; }
        for (let m = 0; m < step; m++, x++) {
          if (x < 0 || x > 255) continue;
          if (collides) {
            if (hit[x] && !(this.s0 & 0x20)) {
              this.s0 |= 0x20;
              this.colX = x + 12;
              this.colY = y + 8;
            }
            hit[x] = 1;
          }
          if (owner[x] === -1) { owner[x] = group; col[x] = colour; }
          else if (owner[x] === group) col[x] |= colour; // CC: the group's colours OR together
        }
      }
    }
    if (!(this.s0 & 0x40)) this.s0 = (this.s0 & 0xe0) | Math.min(n, 31);
    for (let x = 0; x < 256; x++) {
      if (owner[x] < 0) continue;
      const c = col[x];
      if (c === 0 && !tp) continue;
      if (mode === 'G7') this.put2(x, G7S[c]);
      else if (mode === 'G5') {
        this.line[x * 2] = this.pal[(c >> 2) & 3];
        this.line[x * 2 + 1] = this.pal[c & 3];
      } else this.put2(x, this.pal[c]);
    }
  }
}
