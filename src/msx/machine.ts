/**
 * An MSX1: Z80 at 3.58 MHz, the slots, the PPI, the TMS9918A and the PSG,
 * wired as C-BIOS's MSX1 configuration (and the original machines) have
 * them:
 *
 *   slot 0  BIOS ROM 0000h-7FFFh (+ C-BIOS logo ROM at 8000h)
 *   slot 1  cartridge port 1
 *   slot 2  cartridge port 2
 *   slot 3  64K RAM
 *
 *   I/O 98h-99h VDP, A0h-A2h PSG, A8h-ABh PPI; other ports go to the
 *   cartridges (the modem cartridge's 04h-05h), else read FFh.
 *
 * The cassette is not played as sound: the BIOS's tape routines at
 * 00E1h-00F3h are caught while slot 0 is at page 0 and answered from the
 * .cas image (see tape.ts). Text is typed by putting it in the BIOS's
 * keyboard buffer, which works whatever the keyboard layout.
 *
 * Time is kept in CPU cycles: a frame is 262 lines (NTSC, 60 Hz) or 313
 * (PAL, 50 Hz) of 228 cycles. The VDP draws each picture line as its cycles
 * pass and raises the interrupt at the end of the picture.
 */
import { Z80 } from '../z80';
import { Cartridge } from './cartridge';
import { Ppi } from './ppi';
import { Printer } from './printer';
import { Psg } from './psg';
import { MapperRam } from './mapper';
import { Rtc } from './rtc';
import { ExpandedSlot, Ram, Rom, Slots, EMPTY, type SlotDevice } from './slots';
import { V9938 } from './v9938';
import type { VideoChip } from './video';
import { Tape, type TapeState } from './tape';
import { grab, put, type ChipState } from './state';
import { musicRom } from './music-rom';
import { Disk, DiskRomSlot, DSKCHG, DSKFMT, DSKIO, dpb, GETDPB, NOT_READY, RECORD_NOT_FOUND, SECTOR } from './disk';
import { Ym2413 } from './ym2413';
import { Vdp } from './vdp';

type SavedDisk = { name: string; data: Uint8Array; changed: boolean };
const saveDisk = (d: Disk | null): SavedDisk | null => (d ? { name: d.name, data: d.data.slice(), changed: d.changed } : null);
const loadDisk = (s: SavedDisk | null): Disk | null => {
  if (!s) return null;
  const d = new Disk(s.data, s.name);
  d.changed = s.changed;
  return d;
};

/** A machine's state (Msx.saveState), structured-clonable. */
export interface MachineState {
  version: 1;
  model: Model;
  region: Region;
  frames: number;
  cycleBase: number;
  toType: string;
  keysAsked: boolean;
  bootFlags?: number;
  cpu: ChipState;
  primary: number;
  subslots: number;
  ram: Uint8Array;
  mapper: ChipState;
  rtc: ChipState;
  ppi: ChipState;
  psg: ChipState;
  vdp: ChipState;
  cmd: ChipState | null;
  fm: ChipState | null;
  carts: ({ name: string; state: ChipState; scc: ChipState | null } | null)[];
  tape: TapeState | null;
  disk: SavedDisk | null;
  diskB?: SavedDisk | null;
  printer: number[];
}

export const CPU_CLOCK = 3_579_545;
export const CYCLES_PER_LINE = 228;

export type Region = 'ntsc' | 'pal';

export const REGIONS: Record<Region, { lines: number; hz: number; label: string }> = {
  ntsc: { lines: 262, hz: CPU_CLOCK / CYCLES_PER_LINE / 262, label: 'NTSC, 60 Hz' },
  pal: { lines: 313, hz: CPU_CLOCK / CYCLES_PER_LINE / 313, label: 'PAL, 50 Hz' },
};

export interface Bios {
  main: Uint8Array;
  /** C-BIOS's logo ROM, at 8000h in slot 0. */
  logo?: Uint8Array;
  /** The MSX2 SUB-ROM (16K, starts with "CD"), in slot 3-0. */
  sub?: Uint8Array;
}

export type Model = 'msx1' | 'msx2' | 'msx2+';

/** The machine a main ROM is for: its byte 002Dh (0 MSX1, 1 MSX2, 2 MSX2+, 3 turbo R). */
export function biosModel(main: Uint8Array): Model {
  const v = main[0x2d];
  return v === 1 ? 'msx2' : v >= 2 && v <= 3 ? 'msx2+' : 'msx1';
}

/** Throws unless `rom` looks like an MSX1 BIOS: 16K-64K, starting with DI. */
export function checkBios(rom: Uint8Array): void {
  if (rom.length < 0x4000 || rom.length > 0x10000 || rom.length % 0x2000) {
    throw new Error("an MSX1 BIOS is 16K to 64K (the Expert's is 32K)");
  }
  if (rom[0] !== 0xf3) throw new Error('it does not start like an MSX BIOS (DI at 0000h)');
}

// BIOS entry points and system variables (the same on every MSX).
const CHSNS = 0x009c, CHGET = 0x009f;
const TAPION = 0x00e1, TAPIN = 0x00e4, TAPIOF = 0x00e7;
const TAPOON = 0x00ea, TAPOUT = 0x00ed, TAPOOF = 0x00f0, STMOTR = 0x00f3;
const PUTPNT = 0xf3f8, GETPNT = 0xf3fa;
const KEYBUF = 0xfbf0, KEYBUF_END = 0xfc18;
/** Frames after a reset to give up waiting for CHGET and type anyway. */
const TYPE_FALLBACK_FRAMES = 600;

/**
 * A name for a BIOS from its start-up text: "Gradiente Expert 1.1",
 * "Sharp Hotbit 1.1", "MSX BASIC 1.0"; null if it has none.
 */
/** Whether a SUB-ROM carries MSX-MUSIC in its second 16K ("APRLOPLL" at 4018h). */
export function hasMusic(sub: Uint8Array | undefined): boolean {
  return !!sub && sub.length >= 0x8000 && [...'APRLOPLL'].every((c, i) => sub[0x4018 + i] === c.charCodeAt(0));
}

export function biosLabel(rom: Uint8Array): string | null {
  let text = '';
  for (const b of rom) text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '\u00b7';
  const version = /vers(?:.o|ion)\s*(\d\.\d)/.exec(text)?.[1] ?? '';
  const maker = text.includes('HOT-BASIC') ? 'Sharp Hotbit'
    : text.includes('G r a d i e n t e') ? 'Gradiente Expert'
      : text.includes('MSX BASIC') ? 'MSX BASIC' : '';
  return maker ? `${maker} ${version}`.trim() : null;
}

export class Msx {
  readonly cpu = new Z80();
  readonly slots = new Slots();
  readonly ppi = new Ppi(this.slots);
  /** The TMS9918A (MSX1) or the V9938/V9958 (MSX2, MSX2+): set by the BIOS. */
  vdp: VideoChip = new Vdp();
  readonly psg: Psg;
  /** The printer port (90h, 91h). */
  readonly printer = new Printer();
  /** The MSX1's 64K in slot 3. */
  readonly ram = new Ram();
  /** The MSX2's memory mapper (512K in slot 3-2) and clock. */
  readonly mapper = new MapperRam(512);
  readonly rtc = new Rtc();
  model: Model = 'msx1';
  private expanded = new ExpandedSlot();
  private bios!: Bios;
  /** MSX-MUSIC (the YM2413 and its ROM in slot 3-3), when switched on. */
  fm: Ym2413 | null = null;
  /** The BIOS brings MSX-MUSIC itself (its ROM in the SUB-ROM's slot): the chip is always there. */
  private builtInMusic = false;
  /** What the player asked for (setFm), apart from a BIOS's own. */
  private fmWanted = false;
  /** The disk drive's ROM in slot 3-1, when there is one. */
  private diskSlot: DiskRomSlot | null = null;
  /** The disks in drives A and B. */
  readonly disks: (Disk | null)[] = [null, null];
  /**
   * Port F4h on an MSX2+: the BIOS sets bit 7 once it has started, and a
   * reset (unlike power-off) keeps it, so the logo shows only at power-on.
   */
  private bootFlags = 0;
  /** CPU cycles of the frames before this one (cycle counts restart each frame). */
  private cycleBase = 0;
  /** Called after the MSX wrote to the disk. */
  onDiskWritten?: (disk: Disk) => void;
  readonly cartridges: (Cartridge | null)[] = [null, null];
  region: Region = 'ntsc';
  /** Frames run since power-on. */
  frames = 0;
  /** The cassette in the tape deck. */
  tape: Tape | null = null;
  /** Called when the BIOS stops recording onto the tape. */
  onTapeWritten?: (tape: Tape) => void;
  /** Text waiting to be typed when the program next waits for a key. */
  private toType = '';
  /**
   * Where the jumps at CHSNS (009Ch) and CHGET (009Fh) lead in this BIOS.
   * MSX BASIC calls those routines directly, so they are caught as well.
   */
  private keyBodies: number[] = [];
  /**
   * Whether a program asked for keys (CHSNS or CHGET) since reset: the BIOS
   * has set up its key buffer by then.
   */
  private keysAsked = false;
  private readonly sampleRate: number;

  constructor(bios: Bios, sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.psg = new Psg(CPU_CLOCK, sampleRate);
    this.setBios(bios);

    const cpu = this.cpu;
    cpu.read = (a) => this.slots.read(a);
    cpu.write = (a, v) => this.slots.write(a, v);
    cpu.portIn = (p) => this.portIn(p & 0xff);
    cpu.portOut = (p, v) => this.portOut(p & 0xff, v);
    this.ppi.onMotor = () => this.tape?.advance(this.cpu.cycles, this.ppi.motor);
    this.psg.clock = () => this.cycleBase + this.cpu.cycles;
    // The cassette input follows the tape only while its motor runs.
    this.psg.tapeIn = () => (this.tape && this.ppi.motor ? this.tape.level(this.cpu.cycles, true) : 0);
    this.ppi.onClick = (level) => {
      this.psg.advanceTo(cpu.cycles);
      this.psg.click = level;
    };
    this.reset();
  }

  /**
   * Puts a system ROM in slot 0: C-BIOS, or a real machine's BIOS and BASIC
   * (32K at 0000h, such as the Gradiente Expert's). Power-cycle to boot it.
   */
  setBios(bios: Bios): void {
    const rom = new Rom().place(0x0000, bios.main);
    if (bios.logo) rom.place(0x8000, bios.logo);
    this.slots.insert(0, rom);
    const model = biosModel(bios.main);
    if (model !== this.model) {
      this.model = model;
      this.vdp = model === 'msx1' ? new Vdp() : new V9938(model === 'msx2+', () => this.cpu.cycles, true);
    }
    this.bios = bios;
    this.builtInMusic = hasMusic(bios.sub);
    const fmOn = this.fmWanted || this.builtInMusic;
    if (fmOn !== Boolean(this.fm)) this.fm = fmOn ? this.newFm() : null;
    this.layoutSlot3();
    const m = bios.main;
    const body = (at: number) => (m[at] === 0xc3 ? m[at + 1] | (m[at + 2] << 8) : -1);
    this.keyBodies = [body(CHSNS), body(CHGET)].filter((a) => a >= 0);
  }

  /**
   * Slot 3. An MSX1 has its 64K there; MSX2s have C-BIOS's layout, slot 3
   * expanded with the SUB-ROM in 3-0 and the mapper in 3-2. The disk ROM
   * goes in 3-1 and MSX-MUSIC in 3-3; either expands an MSX1's slot 3 too
   * (the RAM in 3-0), as MSX1s with something built in did.
   */
  private layoutSlot3(): void {
    // Our MSX-MUSIC ROM, unless the BIOS has the real one.
    const fm = this.fm && !this.builtInMusic ? new Rom().place(0x4000, musicRom()) : EMPTY;
    const disk = this.diskSlot ?? EMPTY;
    if (this.model === 'msx1') {
      if (fm === EMPTY && !this.diskSlot) {
        this.slots.insert(3, this.ram);
        return;
      }
      this.expanded = new ExpandedSlot().insert(0, this.ram).insert(1, disk).insert(3, fm);
    } else {
      this.expanded = new ExpandedSlot()
        .insert(0, this.bios.sub ? new Rom().place(0x0000, this.bios.sub) : EMPTY)
        .insert(1, disk)
        .insert(2, this.mapper)
        .insert(3, fm);
    }
    this.slots.insert(3, this.expanded);
  }

  /** Switches MSX-MUSIC on or off (a BIOS with its own keeps it). Power-cycle for software to find it. */
  setFm(on: boolean): void {
    this.fmWanted = on;
    on ||= this.builtInMusic;
    if (on === Boolean(this.fm)) return;
    this.fm = on ? this.newFm() : null;
    this.layoutSlot3();
  }

  private newFm(): Ym2413 {
    const fm = new Ym2413(this.sampleRate, CPU_CLOCK);
    fm.now = () => this.cpu.cycles;
    return fm;
  }

  /** Puts a disk ROM (16K) in slot 3-1, or takes it out. Power-cycle to use it. */
  setDiskRom(rom: Uint8Array | null): void {
    this.diskSlot = rom ? new DiskRomSlot(rom) : null;
    this.layoutSlot3();
  }

  get hasDiskDrive(): boolean {
    return this.diskSlot !== null;
  }

  /** The disk in drive A. */
  get disk(): Disk | null {
    return this.disks[0];
  }

  /** Puts a disk in drive A (0) or B (1); null takes it out. */
  insertDisk(disk: Disk | null, drive: 0 | 1 = 0): void {
    this.disks[drive] = disk;
    if (disk) disk.changed = true;
  }

  /** Plugs a cartridge into port 1 or 2 (null takes it out). Reset to use it. */
  insert(port: 1 | 2, cart: Cartridge | null): void {
    this.cartridges[port - 1] = cart;
    if (cart) cart.screenColumns = () => this.vdp.textColumns() || 40;
    if (cart?.scc) {
      cart.scc.sampleRate = this.sampleRate;
      cart.scc.now = () => this.cpu.cycles;
    }
    this.slots.insert(port, cart ?? EMPTY);
  }

  /**
   * Types `text` (\r for Enter) into the BIOS key buffer once the BIOS has
   * started up (a program asked for keys, as MSX BASIC does at its Ok prompt);
   * text put there earlier would be lost when the BIOS clears the buffer.
   */
  type(text: string): void {
    this.toType += text;
  }

  /** Whether text is still waiting to be typed. */
  get typing(): boolean {
    return this.toType.length > 0;
  }

  /** The reset button: CPU and chips back to power-on; RAM keeps its bytes. */
  reset(): void {
    this.cpu.reset();
    this.ppi.reset();
    this.vdp.reset();
    this.psg.reset();
    this.fm?.reset();
    this.mapper.reset();
    this.expanded.reg = 0;
    for (const c of this.cartridges) c?.reset();
    this.tape?.rewind();
    this.toType = '';
    this.keysAsked = false;
    this.frames = 0;
  }

  /** Power off and on: RAM too is cleared. */
  powerCycle(): void {
    this.bootFlags = 0;
    this.ram.data.fill(0);
    this.mapper.data.fill(0);
    this.reset();
  }

  /** Runs one video frame: lines x 228 cycles, drawing as it goes. */
  runFrame(): void {
    const cpu = this.cpu;
    const vdp = this.vdp;
    vdp.frameStart();
    // On an MSX2 the BIOS picks 50 or 60 Hz in the VDP (R#9 NT).
    if (vdp instanceof V9938) this.region = vdp.isNtsc ? 'ntsc' : 'pal';
    const lines = REGIONS[this.region].lines;
    const shown = vdp.displayLines;
    let end = 0;
    for (let line = 0; line < lines; line++) {
      end += CYCLES_PER_LINE;
      while (cpu.cycles < end) {
        // The VDP holds the line until the status register is read.
        if (vdp.irq && cpu.interrupt()) continue;
        const pc = cpu.pc;
        if (((pc <= STMOTR && pc >= CHSNS) || this.keyBodies.includes(pc)) && this.trap(pc)) continue;
        if (pc >= DSKIO && pc <= DSKFMT && this.diskSlot && this.diskTrap(pc)) continue;
        cpu.step();
      }
      if (line < shown) vdp.renderLine(line);
      else if (line === shown) vdp.vblank();
      vdp.endLine(line);
    }
    this.psg.advanceTo(end);
    for (const c of this.cartridges) c?.scc?.advanceTo(end);
    this.fm?.advanceTo(end);
    this.tape?.advance(end, this.ppi.motor);
    this.tape?.rebase(end);
    // Keep the counters small: the next frame starts at cycle 0 (plus overrun).
    cpu.cycles -= end;
    this.cycleBase += end;
    this.psg.rebase(end);
    for (const c of this.cartridges) c?.scc?.rebase(end);
    this.fm?.rebase(end);
    if (vdp instanceof V9938) vdp.cmd.rebase(end);
    this.frames++;
    if (this.toType && (this.keysAsked || this.frames >= TYPE_FALLBACK_FRAMES)) this.fillKeyBuffer();
  }

  /** Moves as much pending text as fits into the BIOS keyboard buffer. */
  private fillKeyBuffer(): void {
    // Through the CPU's view of page 3, which is RAM (or the mapper) by then.
    const ram = { get: (a: number) => this.slots.read(a), set: (a: number, v: number) => this.slots.write(a, v) };
    const word = (a: number) => ram.get(a) | (ram.get(a + 1) << 8);
    let put = word(PUTPNT);
    const get = word(GETPNT);
    if (put < KEYBUF || put >= KEYBUF_END || get < KEYBUF || get >= KEYBUF_END) return; // not set up yet
    let n = 0;
    while (n < this.toType.length) {
      const next = put + 1 === KEYBUF_END ? KEYBUF : put + 1;
      if (next === get) break; // full
      ram.set(put, this.toType.charCodeAt(n++) & 0xff);
      put = next;
    }
    this.toType = this.toType.slice(n);
    ram.set(PUTPNT, put & 0xff);
    ram.set(PUTPNT + 1, put >> 8);
  }

  /**
   * A BIOS entry point the machine handles itself. Returns true when it
   * did the routine's work and returned to the caller.
   */
  private trap(pc: number): boolean {
    if (this.slots.slotOf(0) !== 0) return false; // the BIOS is not at page 0
    const cpu = this.cpu;
    if (pc === CHSNS || pc === CHGET || this.keyBodies.includes(pc)) {
      this.keysAsked = true;
      if (this.toType) this.fillKeyBuffer();
      return false; // CHGET itself runs, and finds the keys
    }
    const tape = this.tape;
    let carry = false;
    switch (pc) {
      case TAPION: carry = !tape?.findBlock(); break;
      case TAPIN: {
        const v = tape ? tape.readByte() : -1;
        if (v < 0) carry = true;
        else cpu.a = v;
        break;
      }
      case TAPOON:
        if (tape) tape.startBlock();
        else carry = true;
        break;
      case TAPOUT:
        if (tape) tape.writeByte(cpu.a);
        else carry = true;
        break;
      case TAPIOF: case TAPOOF:
        // The real routines end with EI (TAPION and TAPOON did DI).
        cpu.iff1 = cpu.iff2 = 1;
        if (pc === TAPOOF && tape?.changed) this.onTapeWritten?.(tape);
        break;
      case STMOTR: {
        // A: 0 stops the motor, 1 starts it, FFh turns it over.
        const on = cpu.a === 0xff ? !this.ppi.motor : cpu.a !== 0;
        this.ppi.out(0xab, on ? 0x08 : 0x09); // port C bit 4: 0 runs the motor
        break;
      }
      default: return false;
    }
    cpu.f = carry ? cpu.f | 0x01 : cpu.f & ~0x01;
    // RET
    cpu.pc = this.slots.read(cpu.sp) | (this.slots.read((cpu.sp + 1) & 0xffff) << 8);
    cpu.sp = (cpu.sp + 2) & 0xffff;
    cpu.cycles += 50;
    return true;
  }

  /** Whether page 1 shows the disk ROM (slot 3-1). */
  private diskRomShown(): boolean {
    return this.slots.slotOf(1) === 3 && this.slots.devices[3] === this.expanded && this.expanded.subOf(1) === 1;
  }

  /**
   * Memory as the disk routines' caller sees it, with RAM in page 1: the
   * disk ROM is there while its routines run, so transfers to 4000h-7FFFh
   * go to the RAM of page 3's slot (the RAM slot), as real disk ROMs do.
   */
  private callerWrite(addr: number, v: number): void {
    if (addr >> 14 === 1) this.ramDevice().write(addr, v);
    else this.slots.write(addr, v);
  }

  private callerRead(addr: number): number {
    return addr >> 14 === 1 ? this.ramDevice().read(addr) : this.slots.read(addr);
  }

  private ramDevice(): SlotDevice {
    const dev = this.slots.devices[this.slots.slotOf(3)];
    return dev instanceof ExpandedSlot ? dev.subs[dev.subOf(3)] : dev;
  }

  /** The disk ROM's entries (disk.ts), done on the disk image. */
  private diskTrap(pc: number): boolean {
    if (!this.diskRomShown()) return false;
    const cpu = this.cpu;
    // The drive: A for DSKIO, DSKCHG and GETDPB, D for DSKFMT; 0 is A:, 1 is B:.
    const drive = pc === DSKFMT ? cpu.d : cpu.a;
    const disk = drive < this.disks.length ? this.disks[drive] : null;
    let error = -1;
    const fillDpb = (base: number) => {
      dpb(disk!.geometry()).forEach((b, i) => this.callerWrite((base + 1 + i) & 0xffff, b));
    };
    switch (pc) {
      case DSKIO: {
        if (!disk) { error = NOT_READY; break; }
        const writing = (cpu.f & 1) !== 0;
        let addr = (cpu.h << 8) | cpu.l;
        let sector = (cpu.d << 8) | cpu.e;
        while (cpu.b > 0) {
          if (writing) {
            const buf = new Uint8Array(SECTOR);
            for (let i = 0; i < SECTOR; i++) buf[i] = this.callerRead((addr + i) & 0xffff);
            if (!disk.write(sector, buf)) { error = RECORD_NOT_FOUND; break; }
          } else {
            const data = disk.read(sector);
            if (!data) { error = RECORD_NOT_FOUND; break; }
            for (let i = 0; i < SECTOR; i++) this.callerWrite((addr + i) & 0xffff, data[i]);
          }
          addr = (addr + SECTOR) & 0xffff;
          sector++;
          cpu.b--;
          cpu.cycles += 2000; // a little time per sector, for loaders that wait
        }
        if (writing && disk.dirty) this.onDiskWritten?.(disk);
        break;
      }
      case DSKCHG:
        if (!disk) { error = NOT_READY; break; }
        if (disk.changed) {
          disk.changed = false;
          cpu.b = 0xff;
          fillDpb((cpu.h << 8) | cpu.l);
        } else {
          cpu.b = 1;
        }
        break;
      case GETDPB:
        if (!disk) { error = NOT_READY; break; }
        fillDpb((cpu.h << 8) | cpu.l);
        break;
      case DSKFMT:
        if (!disk) { error = NOT_READY; break; }
        disk.format();
        disk.changed = true;
        this.onDiskWritten?.(disk);
        break;
      default:
        return false;
    }
    if (error >= 0) {
      cpu.a = error;
      cpu.f |= 0x01;
    } else {
      cpu.f &= ~0x01;
    }
    cpu.pc = this.slots.read(cpu.sp) | (this.slots.read((cpu.sp + 1) & 0xffff) << 8);
    cpu.sp = (cpu.sp + 2) & 0xffff;
    cpu.cycles += 50;
    return true;
  }

  /**
   * Everything the machine is, between two frames: CPU, memory, chips, the
   * cartridges' banks and battery RAM, the tape and the disk with where
   * they are. The ROMs are not in it (the page keeps those); load it into
   * a machine with the same BIOS model and cartridges.
   */
  saveState(): MachineState {
    const vdp = this.vdp;
    return {
      version: 1,
      model: this.model,
      region: this.region,
      frames: this.frames,
      cycleBase: this.cycleBase,
      toType: this.toType,
      keysAsked: this.keysAsked,
      bootFlags: this.bootFlags,
      cpu: grab(this.cpu, ['mem']),
      primary: this.slots.primary,
      subslots: this.expanded.reg,
      ram: this.ram.data.slice(),
      mapper: grab(this.mapper),
      rtc: grab(this.rtc),
      ppi: grab(this.ppi, ['rows']),
      psg: grab(this.psg, ['out', 'joystick']),
      vdp: grab(vdp, ['frame']),
      cmd: vdp instanceof V9938 ? grab(vdp.cmd) : null,
      fm: this.fm ? (this.fm.save() as ChipState) : null,
      carts: this.cartridges.map((c) => (c ? { name: c.name, state: grab(c, ['rom']), scc: c.scc ? grab(c.scc, ['out']) : null } : null)),
      tape: this.tape?.saveState() ?? null,
      disk: saveDisk(this.disks[0]),
      diskB: saveDisk(this.disks[1]),
      printer: this.printer.bytes.slice(),
    };
  }

  /** Puts a saved state back (see saveState). Throws if the BIOS model differs. */
  loadState(s: MachineState): void {
    if (s.version !== 1) throw new Error('a save state from another version');
    if (s.model !== this.model) throw new Error(`the state is of an ${s.model.toUpperCase()}, the BIOS now is an ${this.model.toUpperCase()}`);
    this.setFm(s.fm !== null);
    this.region = s.region;
    this.frames = s.frames;
    this.cycleBase = s.cycleBase;
    this.toType = s.toType;
    this.keysAsked = s.keysAsked;
    this.bootFlags = s.bootFlags ?? 0;
    put(this.cpu, s.cpu);
    this.expanded.reg = s.subslots;
    this.slots.primary = s.primary;
    this.ram.data.set(s.ram);
    put(this.mapper, s.mapper);
    put(this.rtc, s.rtc);
    put(this.ppi, s.ppi);
    put(this.psg, s.psg);
    put(this.vdp, s.vdp);
    if (s.cmd && this.vdp instanceof V9938) put(this.vdp.cmd, s.cmd);
    if (s.fm) this.fm!.load(s.fm);
    s.carts.forEach((saved, i) => {
      const c = this.cartridges[i];
      if (!c || !saved || saved.name !== c.name) return;
      put(c, saved.state);
      if (c.scc && saved.scc) put(c.scc, saved.scc);
    });
    this.tape = s.tape ? Tape.fromState(s.tape) : null;
    this.disks[0] = loadDisk(s.disk);
    this.disks[1] = loadDisk(s.diskB ?? null);
    this.printer.bytes = s.printer.slice();
  }

  /** The frame's sound: the PSG with any cartridge's SCC and MSX-MUSIC mixed in. */
  takeAudio(): Float32Array<ArrayBuffer> {
    const out = this.psg.take();
    for (const c of this.cartridges) c?.scc?.mixInto(out);
    this.fm?.mixInto(out);
    return out;
  }

  private portIn(port: number): number {
    switch (port) {
      case 0x98: return this.vdp.readData();
      case 0x99: return this.vdp.readStatus();
      case 0xa2: return this.psg.read();
      case 0xa8: case 0xa9: case 0xaa: case 0xab: return this.ppi.in(port);
      case 0x90: return this.printer.status();
    }
    // A Brazilian (Microsol) disk ROM's controller: idle, not busy.
    if (this.diskSlot && port >= 0xd0 && port <= 0xd4) return this.diskSlot.fdc.read(port - 0xd0);
    if (this.model !== 'msx1') {
      if (port >= 0xfc) return this.mapper.getPage(port - 0xfc);
      if (port === 0xb5) return this.rtc.read();
      if (port === 0xf4 && this.model === 'msx2+') return this.bootFlags;
    }
    for (const c of this.cartridges) {
      const v = c?.ioIn(port) ?? -1;
      if (v >= 0) return v;
    }
    return 0xff;
  }

  private portOut(port: number, value: number): void {
    switch (port) {
      case 0x98: this.vdp.writeData(value); break;
      case 0x99: this.vdp.writeControl(value); break;
      case 0xa0: this.psg.select(value); break;
      case 0xa1: this.psg.write(value, this.cpu.cycles); break;
      case 0xa8: case 0xa9: case 0xaa: case 0xab: this.ppi.out(port, value); break;
      case 0x90: case 0x91: this.printer.write(port, value); break;
      case 0x7c: if (this.fm) this.fm.selectRegister(value); break;
      case 0x7d: if (this.fm) this.fm.writeData(value); break;
      case 0x9a: this.vdp.writePalette(value); break;
      case 0x9b: this.vdp.writeIndirect(value); break;
      case 0xb4: if (this.model !== 'msx1') this.rtc.select(value); break;
      case 0xb5: if (this.model !== 'msx1') this.rtc.write(value); break;
      case 0xf4: if (this.model === 'msx2+') this.bootFlags = value; break;
      case 0xfc: case 0xfd: case 0xfe: case 0xff:
        if (this.model !== 'msx1') { this.mapper.setPage(port - 0xfc, value); break; }
        for (const c of this.cartridges) if (c?.ioOut(port, value)) break;
        break;
      default:
        if (this.diskSlot && port >= 0xd0 && port <= 0xd4) { this.diskSlot.fdc.write(port - 0xd0, value); break; }
        for (const c of this.cartridges) if (c?.ioOut(port, value)) break;
    }
  }
}
