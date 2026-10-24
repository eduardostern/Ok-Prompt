/**
 * Builds the modem cartridge's ROM: src/roms/okmodem.asm plus a CP437 table
 * worked out here, assembled into src/roms/okmodem.rom (16K at 4000h).
 *
 *   npx vite-node scripts/make-okmodem.ts   (writes src/roms/okmodem.rom)
 *
 * The table maps the PC characters BBSes send (CP437 80h-FFh) to MSX codes.
 * The accented letters (80h-AFh) and the Greek and maths signs (E0h-FFh) sit
 * at the same codes on the MSX. The box lines, blocks and shades (B0h-DFh)
 * do not: they are found by their shapes in the MSX font (C-BIOS's), as
 * lines reaching the top, bottom, left and right edges, or as blocks.
 */
import { assemble } from './z80asm';

const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8;

/** What each CP437 character in B0h-DFh looks like: line ends, or a block. */
const SHAPES: (number | string)[] = [
  'shade', 'shade', 'shade',                                    // B0 ░ ▒ ▓
  UP | DOWN, UP | DOWN | LEFT, UP | DOWN | LEFT, UP | DOWN | LEFT, // B3 │ ┤ ╡ ╢
  DOWN | LEFT, DOWN | LEFT, UP | DOWN | LEFT, UP | DOWN,           // B7 ╖ ╕ ╣ ║
  DOWN | LEFT, UP | LEFT, UP | LEFT, UP | LEFT, DOWN | LEFT,       // BB ╗ ╝ ╜ ╛ ┐
  UP | RIGHT, UP | LEFT | RIGHT, DOWN | LEFT | RIGHT, UP | DOWN | RIGHT, // C0 └ ┴ ┬ ├
  LEFT | RIGHT, 15, UP | DOWN | RIGHT, UP | DOWN | RIGHT,         // C4 ─ ┼ ╞ ╟
  UP | RIGHT, DOWN | RIGHT, UP | LEFT | RIGHT, DOWN | LEFT | RIGHT, // C8 ╚ ╔ ╩ ╦
  UP | DOWN | RIGHT, LEFT | RIGHT, 15, UP | LEFT | RIGHT,         // CC ╠ ═ ╬ ╧
  UP | LEFT | RIGHT, DOWN | LEFT | RIGHT, DOWN | LEFT | RIGHT, UP | RIGHT, // D0 ╨ ╤ ╥ ╙
  UP | RIGHT, DOWN | RIGHT, DOWN | RIGHT, 15, 15,                 // D4 ╘ ╒ ╓ ╫ ╪
  UP | LEFT, DOWN | RIGHT,                                        // D9 ┘ ┌
  'full', 'lower', 'left', 'right', 'upper',                     // DB █ ▄ ▌ ▐ ▀
];
const BLOCKS: Record<string, number[]> = {
  full: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  lower: [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff],
  upper: [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0],
  left: Array(8).fill(0xf0),
  right: Array(8).fill(0x0f),
};
/** If the font has no such shape: plain ASCII. */
const FALLBACK = (s: number | string) =>
  typeof s === 'string' ? (s === 'shade' ? ':' : '#') : s === (UP | DOWN) ? '|' : s === (LEFT | RIGHT) ? '-' : '+';

const bits = (b: number) => { let n = 0; for (; b; b &= b - 1) n++; return n; };

/** The line ends a glyph reaches: a pixel at the middle of an edge. */
function ends(g: number[]): number {
  const mid = 0x18; // columns 3 and 4
  let e = 0;
  if (g[0] & mid) e |= UP;
  if (g[7] & mid) e |= DOWN;
  if (g[3] & 0x80 || g[4] & 0x80) e |= LEFT;
  if (g[3] & 0x01 || g[4] & 0x01) e |= RIGHT;
  return e;
}

/** CP437 80h-FFh to MSX codes, from the font (8 bytes per character). */
export function cp437Table(font: Uint8Array): number[] {
  const glyph = (c: number) => [...font.subarray(c * 8, c * 8 + 8)];
  const candidates = [...Array(32).keys(), ...Array.from({ length: 128 }, (_, i) => 0x80 + i)];
  const table: number[] = [];
  for (let c = 0x80; c < 0x100; c++) {
    if (c < 0xb0 || c >= 0xe0) { table.push(c); continue; } // the same on both
    const shape = SHAPES[c - 0xb0];
    let best = -1;
    let bestPixels = Infinity;
    for (const m of candidates) {
      const g = glyph(m);
      const pixels = g.reduce((n, b) => n + bits(b), 0);
      let ok: boolean;
      if (shape === 'shade') ok = pixels === 32 && g.every((b) => bits(b) === 4 && bits((b ^ (b >> 1)) & 0x7f) >= 3); // a fine checkerboard
      else if (typeof shape === 'string') ok = g.every((b, i) => b === BLOCKS[shape][i]);
      else ok = ends(g) === shape && pixels <= 24;
      // The fewest pixels wins; on a tie, the first (graphic 00h-1Fh, then C0h-DFh before FFh, the cursor).
      if (ok && pixels < bestPixels) { best = m; bestPixels = pixels; }
    }
    table.push(best >= 0 ? best : FALLBACK(shape).charCodeAt(0));
  }
  return table;
}

/** Assembles the ROM; returns 16K. */
export function buildOkModem(source: string, font: Uint8Array): Uint8Array {
  const table = cp437Table(font);
  const lines: string[] = ['cptab:'];
  for (let i = 0; i < 128; i += 16) {
    lines.push('        db ' + table.slice(i, i + 16).map((b) => `0${b.toString(16).padStart(2, '0')}h`).join(', '));
  }
  const { bytes, origin } = assemble(source + '\n' + lines.join('\n') + '\n');
  if (origin !== 0x4000) throw new Error('the ROM must start at 4000h');
  if (bytes.length > 0x4000) throw new Error(`the ROM is ${bytes.length} bytes, over 16K`);
  const rom = new Uint8Array(0x4000).fill(0xff);
  rom.set(bytes);
  return rom;
}

/** C-BIOS's font, where its CGTABL (0004h) points. */
export function cbiosFont(bios: Uint8Array): Uint8Array {
  const at = bios[4] | (bios[5] << 8);
  return bios.subarray(at, at + 2048);
}
