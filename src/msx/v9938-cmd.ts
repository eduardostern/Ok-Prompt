/**
 * The V9938's command engine (docs/v9938.md §7): rectangle fills and copies,
 * lines, searches and single pixels in the bitmap modes, with logical
 * operations, driven by registers R#32-R#46. Commands run at once (CE
 * clears in the R#46 write), except the transfers with the CPU (HMMC, LMMC
 * through R#44, LMCM through S#7), which move one byte or pixel per access.
 */

/** How the screen mode lays out pixels for commands. */
export interface CmdMode {
  width: number;
  /** log2 of pixels per byte: 1 (G4, G6), 2 (G5), 0 (G7 and the V9958's CMD mode). */
  shift: number;
  /** Lines in VRAM: 1024 (G4, G5) or 512. */
  ymask: number;
  /** Bytes per line: 128 (G4, G5) or 256. */
  pitch: number;
  planar: boolean;
}

export interface CmdHost {
  vram: Uint8Array;
  regs: Uint8Array;
  /** The layout for commands now, or null where commands do nothing. */
  cmdMode(): CmdMode | null;
}

const phys = (l: number) => ((l << 16) | (l >> 1)) & 0x1ffff;

type Transfer = {
  kind: 'hmmc' | 'lmmc' | 'lmcm';
  x0: number; y: number; nx: number; ny: number; tx: number; ty: number;
  i: number; r: number; op: number; mode: CmdMode;
};

export class CommandEngine {
  /** S#2 CE, TR, BD; S#7; S#8/S#9. */
  ce = false;
  tr = false;
  bd = false;
  cl = 0;
  borderX = 0;
  /** R#44 was written since the last byte was taken. */
  private transfer = false;
  private xfer: Transfer | null = null;

  constructor(private readonly host: CmdHost) {}

  reset(): void {
    this.ce = this.tr = this.bd = this.transfer = false;
    this.cl = this.borderX = 0;
    this.xfer = null;
  }

  // ---- registers -----------------------------------------------------------

  private get r() { return this.host.regs; }
  private get sx() { return this.r[32] | ((this.r[33] & 1) << 8); }
  private get sy() { return this.r[34] | ((this.r[35] & 3) << 8); }
  private get dx() { return this.r[36] | ((this.r[37] & 1) << 8); }
  private get dy() { return this.r[38] | ((this.r[39] & 3) << 8); }
  private get nx() { return this.r[40] | ((this.r[41] & 3) << 8); }
  private get ny() { return this.r[42] | ((this.r[43] & 3) << 8); }
  private set10(lo: number, v: number): void { this.r[lo] = v & 0xff; this.r[lo + 1] = (v >> 8) & 3; }

  /** A write to R#32-R#46. */
  write(n: number, v: number): void {
    const masks: Record<number, number> = { 33: 1, 35: 3, 37: 1, 39: 3, 41: 3, 43: 3, 45: 0x7f };
    this.r[n] = v & (masks[n] ?? 0xff);
    if (n === 44) {
      this.transfer = true;
      if (this.xfer && this.xfer.kind !== 'lmcm') this.feed();
      else if (!this.ce) this.tr = false;
    } else if (n === 46) {
      this.start(v);
    }
  }

  /** S#7: the colour; during LMCM it also loads the next pixel. */
  readColor(): number {
    const v = this.cl;
    if (this.xfer?.kind === 'lmcm') this.lmcmNext();
    return v;
  }

  // ---- pixels ----------------------------------------------------------------

  private addr(m: CmdMode, bx: number, y: number): number {
    const l = m.pitch === 128 ? ((y & m.ymask) << 7) | (bx & 0x7f) : ((y & m.ymask) << 8) | (bx & 0xff);
    return m.planar ? phys(l) : l & 0x1ffff;
  }

  private point(m: CmdMode, x: number, y: number): number {
    const b = this.host.vram[this.addr(m, x >> m.shift, y)];
    if (m.shift === 1) return (b >> ((~x & 1) << 2)) & 0x0f;
    if (m.shift === 2) return (b >> ((~x & 3) << 1)) & 0x03;
    return b;
  }

  /** Writes a pixel through logical operation `op` (low nibble of CMD). */
  private pset(m: CmdMode, x: number, y: number, c: number, op: number): void {
    const mask = m.shift === 1 ? 0x0f : m.shift === 2 ? 0x03 : 0xff;
    c &= mask;
    if (op & 8 && c === 0) return; // TIMP, TAND...: transparent 0
    const d = this.point(m, x, y);
    let v: number;
    switch (op & 7) {
      case 0: v = c; break;
      case 1: v = d & c; break;
      case 2: v = d | c; break;
      case 3: v = d ^ c; break;
      case 4: v = ~c & mask; break;
      default: return;
    }
    if (op >= 0x0d) return;
    const a = this.addr(m, x >> m.shift, y);
    const vram = this.host.vram;
    if (m.shift === 0) { vram[a] = v; return; }
    const sh = m.shift === 1 ? (~x & 1) << 2 : (~x & 3) << 1;
    vram[a] = (vram[a] & ~(mask << sh)) | (v << sh);
  }

  // ---- commands ----------------------------------------------------------------

  private start(cmd: number): void {
    this.xfer = null;
    // (a pre-written R#44 stays as the first datum of a transfer)
    const code = cmd >> 4;
    const op = cmd & 0x0f;
    if (code < 4) { this.ce = false; this.tr = false; this.transfer = false; return; } // STOP
    const m = this.host.cmdMode();
    if (!m) { this.ce = false; return; }
    const arg = this.r[45];
    const tx = arg & 4 ? -1 : 1;
    const ty = arg & 8 ? -1 : 1;
    switch (code) {
      case 0x4: this.cl = this.point(m, this.sx, this.sy); this.ce = false; return;
      case 0x5: this.pset(m, this.dx, this.dy, this.r[44], op); this.ce = false; return;
      case 0x6: this.srch(m, tx, !!(arg & 2)); return;
      case 0x7: this.line(m, op, tx, ty, !!(arg & 1)); return;
      case 0x8: this.rect(m, 'lmmv', op, tx, ty); return;
      case 0x9: this.rect(m, 'lmmm', op, tx, ty); return;
      case 0xc: this.rect(m, 'hmmv', op, tx, ty); return;
      case 0xd: this.rect(m, 'hmmm', op, tx, ty); return;
      case 0xe: this.ymmm(m, tx, ty); return;
      case 0xa: case 0xb: case 0xf: this.startTransfer(m, code, op, tx, ty); return;
    }
  }

  /** NX clipped at the edge in the X direction (pixels, or bytes with `bytes`). */
  private clipX(m: CmdMode, x: number, n: number, tx: number, bytes: boolean): number {
    const w = bytes ? m.width >> m.shift : m.width;
    if (n === 0) n = w;
    if (x >= w) return 1;
    return tx < 0 ? Math.min(n, x + 1) : Math.min(n, w - x);
  }

  private clipY(y: number, n: number, ty: number): number {
    if (n === 0) n = 1024;
    return ty < 0 ? Math.min(n, y + 1) : n;
  }

  /** Rows done: NY, DY (and SY for copies) updated as the chip leaves them. */
  private finishRows(rows: number, ty: number, m: CmdMode, copiesSource: boolean): void {
    this.set10(42, (this.ny - rows) & 0x3ff);
    this.set10(38, (this.dy + rows * ty) & m.ymask);
    if (copiesSource) this.set10(34, (this.sy + rows * ty) & m.ymask);
    this.ce = false;
  }

  private rect(m: CmdMode, kind: 'lmmv' | 'lmmm' | 'hmmv' | 'hmmm', op: number, tx: number, ty: number): void {
    const bytes = kind[0] === 'h';
    const s = bytes ? m.shift : 0;
    const dx = this.dx >> s;
    const sx = this.sx >> s;
    const copy = kind === 'lmmm' || kind === 'hmmm';
    let nx = this.clipX(m, dx, this.nx >> s, tx, bytes);
    if (copy) nx = Math.min(nx, this.clipX(m, sx, this.nx >> s, tx, bytes));
    let ny = this.clipY(this.dy, this.ny, ty);
    if (copy) ny = Math.min(ny, this.clipY(this.sy, this.ny, ty));
    const vram = this.host.vram;
    for (let row = 0; row < ny; row++) {
      const dy = (this.dy + row * ty) & m.ymask;
      const sy = (this.sy + row * ty) & m.ymask;
      for (let i = 0; i < nx; i++) {
        const x = dx + i * tx;
        if (kind === 'hmmv') vram[this.addr(m, x, dy)] = this.r[44];
        else if (kind === 'hmmm') vram[this.addr(m, x, dy)] = vram[this.addr(m, sx + i * tx, sy)];
        else if (kind === 'lmmv') this.pset(m, x, dy, this.r[44], op);
        else this.pset(m, x, dy, this.point(m, sx + i * tx, sy), op);
      }
    }
    this.finishRows(ny, ty, m, copy);
  }

  /** YMMM: bytes from (DX, SY) to (DX, DY), from DX to the edge. */
  private ymmm(m: CmdMode, tx: number, ty: number): void {
    const bx = this.dx >> m.shift;
    const w = m.width >> m.shift;
    const nx = tx > 0 ? w - bx : bx + 1;
    const ny = Math.min(this.clipY(this.dy, this.ny, ty), this.clipY(this.sy, this.ny, ty));
    const vram = this.host.vram;
    for (let row = 0; row < ny; row++) {
      const dy = (this.dy + row * ty) & m.ymask;
      const sy = (this.sy + row * ty) & m.ymask;
      for (let i = 0; i < nx; i++) vram[this.addr(m, bx + i * tx, dy)] = vram[this.addr(m, bx + i * tx, sy)];
    }
    this.finishRows(ny, ty, m, true);
  }

  private line(m: CmdMode, op: number, tx: number, ty: number, maj: boolean): void {
    const nx = this.nx;
    const ny = this.ny;
    let asx = ((nx - 1) >> 1) & 1023;
    let anx = 0;
    let x = this.dx;
    let y = this.dy;
    for (;;) {
      this.pset(m, x, y, this.r[44], op);
      if (!maj) {
        x += tx;
        if (asx < ny) { asx += nx; y = (y + ty) & m.ymask; }
      } else {
        y = (y + ty) & m.ymask;
        if (asx < ny) { asx += nx; x += tx; }
      }
      asx = (asx - ny) & 1023;
      if (anx++ === nx || x < 0 || x >= m.width) break;
    }
    this.set10(38, y);
    this.ce = false;
  }

  private srch(m: CmdMode, tx: number, eq: boolean): void {
    const mask = m.shift === 1 ? 0x0f : m.shift === 2 ? 0x03 : 0xff;
    const c = this.r[44] & mask;
    this.bd = false;
    for (let x = this.sx; x >= 0 && x < m.width; x += tx) {
      if ((this.point(m, x, this.sy) === c) !== eq) {
        this.bd = true;
        this.borderX = x;
        break;
      }
      this.borderX = x;
    }
    this.ce = false;
  }

  // ---- transfers with the CPU ------------------------------------------------

  private startTransfer(m: CmdMode, code: number, op: number, tx: number, ty: number): void {
    const kind = code === 0xf ? 'hmmc' : code === 0xb ? 'lmmc' : 'lmcm';
    const bytes = kind === 'hmmc';
    const s = bytes ? m.shift : 0;
    const x0 = (kind === 'lmcm' ? this.sx : this.dx) >> s;
    const y = kind === 'lmcm' ? this.sy : this.dy;
    this.xfer = {
      kind, x0, y, tx, ty, op, mode: m, i: 0, r: 0,
      nx: this.clipX(m, x0, this.nx >> s, tx, bytes),
      ny: this.clipY(y, this.ny, ty),
    };
    this.ce = true;
    this.tr = true;
    if (kind === 'lmcm') this.lmcmNext();
    else if (this.transfer) this.feed(); // R#44 written before R#46: the first datum
  }

  /** Steps the transfer's position; true when it is done. */
  private advance(t: Transfer): boolean {
    if (++t.i < t.nx) return false;
    t.i = 0;
    return ++t.r >= t.ny;
  }

  private end(t: Transfer): void {
    this.xfer = null;
    if (t.kind === 'lmcm') {
      this.set10(42, (this.ny - t.ny) & 0x3ff);
      this.set10(34, (this.sy + t.ny * t.ty) & t.mode.ymask);
      this.ce = false;
    } else {
      this.finishRows(t.ny, t.ty, t.mode, false);
    }
  }

  /** One byte (HMMC) or pixel (LMMC) from R#44. */
  private feed(): void {
    const t = this.xfer;
    if (!t) return;
    this.transfer = false;
    const x = t.x0 + t.i * t.tx;
    const y = (t.y + t.r * t.ty) & t.mode.ymask;
    if (t.kind === 'hmmc') this.host.vram[this.addr(t.mode, x, y)] = this.r[44];
    else this.pset(t.mode, x, y, this.r[44], t.op);
    if (this.advance(t)) this.end(t);
    else this.tr = true;
  }

  /** LMCM: loads the next pixel into S#7. */
  private lmcmNext(): void {
    const t = this.xfer;
    if (!t) return;
    this.cl = this.point(t.mode, t.x0 + t.i * t.tx, (t.y + t.r * t.ty) & t.mode.ymask);
    this.tr = true;
    if (this.advance(t)) this.end(t);
  }
}
