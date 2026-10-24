/**
 * The disk drive. Every MSX disk ROM (Philips, Sony, Panasonic, the
 * Brazilian ones...) starts with the same jump table, which MSX-DOS and
 * Disk BASIC call for all disk work:
 *
 *   4010h DSKIO   read (carry clear) or write (carry set) B sectors from
 *                 sector DE at HL; A = drive, C = media descriptor
 *   4013h DSKCHG  has the disk changed? B = 1 no, FFh yes (then the DPB
 *                 at HL is filled in, as GETDPB does), 0 don't know
 *   4016h GETDPB  fill the drive parameter block at HL+1..HL+18
 *   401Ch DSKFMT  format the disk
 *
 * They return carry set and an error code in A on failure (0 write
 * protected, 2 not ready, 4 data error, 8 record not found, 10 write
 * fault, 12 other). The machine catches these entries while the disk ROM
 * is in page 1 and does the work on a .dsk image (as fMSX does), so the
 * ROM's own floppy controller code never runs and any disk ROM works,
 * whatever controller it was made for. The rest of the ROM (Disk BASIC,
 * the MSX-DOS kernel) runs as it is.
 *
 * So that the ROM's start-up does not wait for a controller that is not
 * there, the disk slot answers like an idle one: the Philips WD2793
 * registers at 7FF8h-7FFFh, and the machine answers the Microsol ports
 * D0h-D4h (Brazilian disk drives).
 */
import type { SlotDevice } from './slots';

export const SECTOR = 512;

export const DSKIO = 0x4010;
export const DSKCHG = 0x4013;
export const GETDPB = 0x4016;
export const DSKFMT = 0x401c;

/** Error codes in A. */
export const NOT_READY = 2;
export const RECORD_NOT_FOUND = 8;

/** Whether a 16K ROM looks like a disk ROM: "AB" and the jump table at 4010h. */
export function isDiskRom(rom: Uint8Array): boolean {
  return rom.length >= 0x4000 && rom[0] === 0x41 && rom[1] === 0x42
    && [0x10, 0x13, 0x16, 0x1c].every((a) => rom[a] === 0xc3);
}

/** The 16K disk ROM in a file (some dumps are 32K with the ROM in one half). */
export function diskRomIn(data: Uint8Array): Uint8Array | null {
  for (let at = 0; at + 0x4000 <= data.length; at += 0x4000) {
    const rom = data.subarray(at, at + 0x4000);
    if (isDiskRom(rom)) return rom.slice();
  }
  return null;
}

/** A disk image: the sectors of a .dsk one after another. */
export class Disk {
  private bytes: Uint8Array;
  /** Set when a disk goes in; DSKCHG reports it once. */
  changed = true;
  /** Set when something was written since the page last saved it. */
  dirty = false;

  constructor(data: Uint8Array, readonly name = 'disk.dsk') {
    this.bytes = data.slice();
  }

  get data(): Uint8Array {
    return this.bytes;
  }

  get sectors(): number {
    return Math.floor(this.bytes.length / SECTOR);
  }

  read(sector: number): Uint8Array | null {
    if (sector < 0 || sector >= this.sectors) return null;
    return this.bytes.subarray(sector * SECTOR, (sector + 1) * SECTOR);
  }

  write(sector: number, data: Uint8Array): boolean {
    if (sector < 0 || sector >= this.sectors) return false;
    this.bytes.set(data.subarray(0, SECTOR), sector * SECTOR);
    this.dirty = true;
    return true;
  }

  /** The disk's layout from its boot sector, or the standard one for its size. */
  geometry(): Geometry {
    const b = this.bytes;
    const w = (a: number) => b[a] | (b[a + 1] << 8);
    const g: Geometry = {
      media: b[21], perCluster: b[13], reserved: w(14), fats: b[16],
      dirEntries: w(17), total: w(19), perFat: w(22),
    };
    const sane = w(11) === SECTOR && g.media >= 0xf8 && [1, 2, 4, 8].includes(g.perCluster)
      && g.fats >= 1 && g.fats <= 2 && g.dirEntries > 0 && g.perFat > 0 && g.reserved > 0;
    return sane ? g : standardGeometry(this.bytes.length);
  }

  /** DSKFMT: an empty MSX-DOS disk, the layout of its size (720K if unsure). */
  format(): void {
    const g = standardGeometry(this.bytes.length);
    this.bytes = blankDisk(g);
    this.dirty = true;
  }
}

export interface Geometry {
  media: number;
  perCluster: number;
  reserved: number;
  fats: number;
  dirEntries: number;
  total: number;
  perFat: number;
}

/** The standard MSX formats: 720K double-sided (F9h) and 360K single-sided (F8h). */
export function standardGeometry(size: number): Geometry {
  return size <= 368_640
    ? { media: 0xf8, perCluster: 2, reserved: 1, fats: 2, dirEntries: 112, total: 720, perFat: 2 }
    : { media: 0xf9, perCluster: 2, reserved: 1, fats: 2, dirEntries: 112, total: 1440, perFat: 3 };
}

/** A freshly formatted disk: boot sector with the layout, empty FATs and directory. */
export function blankDisk(g: Geometry = standardGeometry(737_280)): Uint8Array {
  const d = new Uint8Array(g.total * SECTOR);
  const w = (a: number, v: number) => { d[a] = v & 0xff; d[a + 1] = v >> 8; };
  d.set([0xeb, 0xfe, 0x90]); // JR $: a disk that does not boot by itself
  d.set([...'OKPROMPT'].map((c) => c.charCodeAt(0)), 3);
  w(11, SECTOR);
  d[13] = g.perCluster;
  w(14, g.reserved);
  d[16] = g.fats;
  w(17, g.dirEntries);
  w(19, g.total);
  d[21] = g.media;
  w(22, g.perFat);
  w(24, 9); // sectors per track
  w(26, g.media === 0xf8 ? 1 : 2); // sides
  d[30] = 0xc9; // the MSX boot entry: RET
  for (let f = 0; f < g.fats; f++) {
    const at = (g.reserved + f * g.perFat) * SECTOR;
    d.set([g.media, 0xff, 0xff], at);
  }
  return d;
}

/** The drive parameter block (DPB) bytes 1-18 for a layout. */
export function dpb(g: Geometry): number[] {
  const dirSectors = Math.ceil((g.dirEntries * 32) / SECTOR);
  const firstDir = g.reserved + g.fats * g.perFat;
  const firstData = firstDir + dirSectors;
  const maxCluster = Math.floor((g.total - firstData) / g.perCluster) + 1;
  const lo = (v: number) => v & 0xff;
  const hi = (v: number) => v >> 8;
  return [
    g.media,
    lo(SECTOR), hi(SECTOR),
    0x0f, 0x04, // directory entries per sector - 1, and its shift
    g.perCluster - 1, Math.log2(g.perCluster) + 1,
    lo(g.reserved), hi(g.reserved),
    g.fats,
    g.dirEntries & 0xff,
    lo(firstData), hi(firstData),
    lo(maxCluster), hi(maxCluster),
    g.perFat,
    lo(firstDir), hi(firstDir),
  ];
}

/**
 * An idle WD2793 floppy controller: the disk ROM's start-up looks for one
 * (writes the track register and reads it back, waits for "not busy"),
 * then all disk work goes through the jump table, which the machine does.
 * Registers 0-3: status/command, track, sector, data; 4: the board's own
 * (Microsol: drive and side select; reads INTRQ in bit 7).
 */
export class IdleFdc {
  private regs = [0, 0, 1, 0];

  read(r: number): number {
    if (r === 0) return 0x04; // not busy, head on track 0
    if (r === 4) return 0x80; // INTRQ: the last command is done
    return this.regs[r];
  }

  write(r: number, v: number): void {
    if (r === 0) {
      // Commands end at once. Seek moves the head to the data register's track; restore to 0.
      if ((v & 0xf0) === 0x10) this.regs[1] = this.regs[3];
      else if ((v & 0xf0) === 0x00) this.regs[1] = 0;
    } else if (r < 4) {
      this.regs[r] = v & 0xff;
    }
  }
}

/**
 * The disk ROM in its slot (3-1): the ROM at 4000h-7FFFh, with the Philips
 * controller registers at 7FF8h-7FFFh answering like an idle drive.
 */
export class DiskRomSlot implements SlotDevice {
  readonly fdc = new IdleFdc();

  constructor(readonly rom: Uint8Array) {}

  read(addr: number): number {
    if (addr < 0x4000 || addr >= 0x8000) return 0xff;
    if (addr >= 0x7ff8) {
      if (addr <= 0x7ffb) return this.fdc.read(addr - 0x7ff8);
      if (addr === 0x7fff) return 0xbf; // INTRQ (bit 6, active low) on, DRQ off
      return 0x00;
    }
    return this.rom[addr - 0x4000];
  }

  write(addr: number, value: number): void {
    // The controller's registers; the machine does the disk work.
    if (addr >= 0x7ff8 && addr <= 0x7ffb) this.fdc.write(addr - 0x7ff8, value);
  }
}
