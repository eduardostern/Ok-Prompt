/**
 * What the machine needs from a video chip: the TMS9918A of the MSX1
 * (vdp.ts) or the V9938/V9958 of the MSX2 and MSX2+ (v9938.ts).
 */
export interface VideoChip {
  readonly vram: Uint8Array;
  readonly regs: Uint8Array;
  /** The picture with its border as RGBA pixels, width x height. */
  readonly frame: Uint32Array;
  readonly width: number;
  readonly height: number;
  /** Picture lines in this frame: 192, or 212 on the V9938 with LN. */
  readonly displayLines: number;
  /** The interrupt line. */
  readonly irq: boolean;
  /** Text columns on screen (32, 40 or 80), or 0 in a graphics mode. */
  textColumns(): number;
  reset(): void;
  readData(): number;
  writeData(value: number): void;
  readStatus(): number;
  writeControl(value: number): void;
  /** Port 9Ah (V9938 only). */
  writePalette(value: number): void;
  /** Port 9Bh (V9938 only). */
  writeIndirect(value: number): void;
  /** Before the first line of a frame. */
  frameStart(): void;
  /** Draws picture line y. */
  renderLine(y: number): void;
  /** After the CPU cycles of frame line `line` (line interrupts). */
  endLine(line: number): void;
  /** The end of the picture. */
  vblank(): void;
}
