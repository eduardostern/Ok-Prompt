/**
 * Cartridges. Small ones (up to 64K) are plain ROM at a fixed place; bigger
 * "MegaROMs" switch 8K or 16K banks into the 4000h-BFFFh window when the
 * program writes to particular addresses. The four common schemes:
 *
 * - Konami (no SCC): 8K banks; 4000h fixed to bank 0, writes to 6000h, 8000h
 *   and A000h pick the banks at 6000h, 8000h and A000h.
 * - Konami SCC: 8K banks; writes to 5000h, 7000h, 9000h, B000h pick the banks
 *   at 4000h, 6000h, 8000h, A000h. Bank 3Fh at 8000h also brings up the SCC
 *   sound chip's registers at 9800h-9FFFh (see scc.ts).
 * - ASCII 8K: writes to 6000h, 6800h, 7000h, 7800h pick 8K banks for 4000h,
 *   6000h, 8000h, A000h.
 * - ASCII 16K: writes to 6000h and 7000h pick 16K banks for 4000h and 8000h.
 *
 * Which one a ROM uses is not in the file, so `guessMapper` counts the
 * LD (nnnn),A instructions aimed at each scheme's addresses, as fMSX and
 * openMSX do; the UI lets the player override it.
 */
import { Scc } from './scc';
import type { SlotDevice } from './slots';

export type Mapper = 'plain' | 'konami' | 'konamiscc' | 'ascii8' | 'ascii16';

export const MAPPERS: Record<Mapper, string> = {
  plain: 'Plain ROM (up to 64K)',
  konami: 'Konami',
  konamiscc: 'Konami SCC',
  ascii8: 'ASCII 8K',
  ascii16: 'ASCII 16K',
};

/** Where a plain ROM goes: from its size and its "AB" header. */
export function plainBase(rom: Uint8Array): number {
  if (rom.length > 0xc000) return 0x0000;
  if (rom.length > 0x8000) {
    // 48K: usually 0000h-BFFFh, but some put the header at 4000h.
    return rom[0] === 0x41 && rom[1] === 0x42 ? 0x4000 : 0x0000;
  }
  if (rom.length <= 0x4000 && rom[0] === 0x41 && rom[1] === 0x42) {
    // A 16K cartridge whose INIT points into 8000h-BFFFh lives there (BASIC ROMs).
    const init = rom[2] | (rom[3] << 8);
    if (init >= 0x8000 && init < 0xc000) return 0x8000;
  }
  return 0x4000;
}

/** The likely mapper of a ROM image. */
export function guessMapper(rom: Uint8Array): Mapper {
  if (rom.length <= 0x10000) return 'plain';
  const score: Record<Exclude<Mapper, 'plain'>, number> = { konami: 0, konamiscc: 0, ascii8: 0, ascii16: 0 };
  for (let i = 0; i + 2 < rom.length; i++) {
    if (rom[i] !== 0x32) continue; // LD (nnnn),A
    const addr = rom[i + 1] | (rom[i + 2] << 8);
    switch (addr) {
      case 0x5000: case 0x9000: case 0xb000: score.konamiscc++; break;
      case 0x4000: case 0x8000: case 0xa000: score.konami++; break;
      case 0x6800: case 0x7800: score.ascii8++; break;
      case 0x6000: score.konami++; score.ascii8++; score.ascii16++; break;
      case 0x7000: score.konamiscc++; score.ascii8++; score.ascii16++; break;
      case 0x77ff: score.ascii16++; break;
    }
  }
  // ASCII 16K ROMs also set 6000h and 7000h, so ASCII 8K must clearly win.
  if (score.ascii8 > 0) score.ascii8--;
  let best: Mapper = 'konami';
  let top = -1;
  for (const [k, v] of Object.entries(score) as [Exclude<Mapper, 'plain'>, number][]) {
    if (v > top) { best = k; top = v; }
  }
  return best;
}

export class Cartridge implements SlotDevice {
  readonly mapper: Mapper;
  /** The SCC sound chip, in Konami SCC cartridges. */
  readonly scc: Scc | null;
  /** Bank number in each 8K window of 4000h-BFFFh (16K mappers use two). */
  private banks = [0, 1, 2, 3];
  private base = 0x4000;
  private mask: number;

  constructor(readonly rom: Uint8Array, mapper?: Mapper, readonly name = '') {
    this.mapper = mapper ?? guessMapper(rom);
    this.scc = this.mapper === 'konamiscc' ? new Scc() : null;
    if (this.mapper === 'plain') this.base = plainBase(rom);
    // Banks wrap at the ROM size (rounded up to a power of two).
    const pages = Math.max(1, Math.ceil(rom.length / 0x2000));
    let n = 1;
    while (n < pages) n <<= 1;
    this.mask = n - 1;
  }

  read(addr: number): number {
    if (this.mapper === 'plain') {
      const off = addr - this.base;
      return off >= 0 && off < this.rom.length ? this.rom[off] : 0xff;
    }
    if (addr < 0x4000 || addr >= 0xc000) return 0xff;
    if (this.sccOn(addr)) return this.scc!.read(addr);
    const window = (addr - 0x4000) >> 13;
    const off = ((this.banks[window] & this.mask) << 13) | (addr & 0x1fff);
    return off < this.rom.length ? this.rom[off] : 0xff;
  }

  write(addr: number, value: number): void {
    switch (this.mapper) {
      case 'konami':
        if (addr >= 0x6000 && addr < 0xc000) this.banks[(addr - 0x4000) >> 13] = value;
        break;
      case 'konamiscc':
        if ((addr & 0x1800) === 0x1000 && addr >= 0x4000 && addr < 0xc000) {
          this.banks[(addr - 0x4000) >> 13] = value;
        } else if (this.sccOn(addr)) {
          this.scc!.write(addr, value);
        }
        break;
      case 'ascii8':
        if (addr >= 0x6000 && addr < 0x8000) this.banks[(addr >> 11) & 3] = value;
        break;
      case 'ascii16':
        if (addr >= 0x6000 && addr < 0x6800) { this.banks[0] = value * 2; this.banks[1] = value * 2 + 1; }
        else if (addr >= 0x7000 && addr < 0x7800) { this.banks[2] = value * 2; this.banks[3] = value * 2 + 1; }
        break;
    }
  }

  /** An I/O port read the cartridge answers, or -1 (most cartridges have none). */
  ioIn(_port: number): number {
    return -1;
  }

  /** An I/O port write; true if the cartridge took it. */
  ioOut(_port: number, _value: number): boolean {
    return false;
  }

  /** Back to the power-on banks. */
  reset(): void {
    this.banks = [0, 1, 2, 3];
    this.scc?.reset();
  }

  /** Whether `addr` hits the SCC's registers: 9800h-9FFFh with bank 3Fh at 8000h. */
  private sccOn(addr: number): boolean {
    return this.scc !== null && (this.banks[2] & 0x3f) === 0x3f && addr >= 0x9800 && addr < 0xa000;
  }
}
