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
 *   I/O 98h-99h VDP, A0h-A2h PSG, A8h-ABh PPI; everything else reads FFh.
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
import { Psg } from './psg';
import { Ram, Rom, Slots, EMPTY } from './slots';
import { Tape } from './tape';
import { Vdp } from './vdp';

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
}

/** Throws unless `rom` looks like an MSX1 BIOS: 16K-64K, starting with DI. */
export function checkBios(rom: Uint8Array): void {
  if (rom.length < 0x4000 || rom.length > 0x10000 || rom.length % 0x2000) {
    throw new Error("an MSX1 BIOS is 16K to 64K (the Expert's is 32K)");
  }
  if (rom[0] !== 0xf3) throw new Error('it does not start like an MSX BIOS (DI at 0000h)');
}

// BIOS entry points and system variables (the same on every MSX).
const CHGET = 0x009f;
const TAPION = 0x00e1, TAPIN = 0x00e4, TAPIOF = 0x00e7;
const TAPOON = 0x00ea, TAPOUT = 0x00ed, TAPOOF = 0x00f0, STMOTR = 0x00f3;
const PUTPNT = 0xf3f8, GETPNT = 0xf3fa;
const KEYBUF = 0xfbf0, KEYBUF_END = 0xfc18;
/** Frames after a reset to give up waiting for CHGET and type anyway. */
const TYPE_FALLBACK_FRAMES = 600;

export class Msx {
  readonly cpu = new Z80();
  readonly slots = new Slots();
  readonly ppi = new Ppi(this.slots);
  readonly vdp = new Vdp();
  readonly psg: Psg;
  readonly ram = new Ram();
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
  private readonly sampleRate: number;

  constructor(bios: Bios, sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.psg = new Psg(CPU_CLOCK, sampleRate);
    this.setBios(bios);
    this.slots.insert(3, this.ram);

    const cpu = this.cpu;
    cpu.read = (a) => this.slots.read(a);
    cpu.write = (a, v) => this.slots.write(a, v);
    cpu.portIn = (p) => this.portIn(p & 0xff);
    cpu.portOut = (p, v) => this.portOut(p & 0xff, v);
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
  }

  /** Plugs a cartridge into port 1 or 2 (null takes it out). Reset to use it. */
  insert(port: 1 | 2, cart: Cartridge | null): void {
    this.cartridges[port - 1] = cart;
    if (cart?.scc) {
      cart.scc.sampleRate = this.sampleRate;
      cart.scc.now = () => this.cpu.cycles;
    }
    this.slots.insert(port, cart ?? EMPTY);
  }

  /**
   * Types `text` (\r for Enter) once the program waits for a key at CHGET,
   * as MSX BASIC does at its Ok prompt. Typing it earlier would be lost
   * when the BIOS clears the keyboard buffer at start-up.
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
    for (const c of this.cartridges) c?.reset();
    this.tape?.rewind();
    this.toType = '';
    this.frames = 0;
  }

  /** Power off and on: RAM too is cleared. */
  powerCycle(): void {
    this.ram.data.fill(0);
    this.reset();
  }

  /** Runs one video frame: lines x 228 cycles, drawing as it goes. */
  runFrame(): void {
    const cpu = this.cpu;
    const vdp = this.vdp;
    const lines = REGIONS[this.region].lines;
    let end = 0;
    for (let line = 0; line < lines; line++) {
      end += CYCLES_PER_LINE;
      while (cpu.cycles < end) {
        // The VDP holds the line until the status register is read.
        if (vdp.irq && cpu.interrupt()) continue;
        const pc = cpu.pc;
        if (pc <= STMOTR && pc >= CHGET && this.trap(pc)) continue;
        cpu.step();
      }
      if (line < 192) vdp.renderLine(line);
      else if (line === 192) vdp.vblank();
    }
    this.psg.advanceTo(end);
    for (const c of this.cartridges) c?.scc?.advanceTo(end);
    // Keep the counters small: the next frame starts at cycle 0 (plus overrun).
    cpu.cycles -= end;
    this.psg.rebase(end);
    for (const c of this.cartridges) c?.scc?.rebase(end);
    this.frames++;
    if (this.toType && this.frames >= TYPE_FALLBACK_FRAMES) this.fillKeyBuffer();
  }

  /** Moves as much pending text as fits into the BIOS keyboard buffer. */
  private fillKeyBuffer(): void {
    const ram = this.ram.data;
    const word = (a: number) => ram[a] | (ram[a + 1] << 8);
    let put = word(PUTPNT);
    const get = word(GETPNT);
    if (put < KEYBUF || put >= KEYBUF_END || get < KEYBUF || get >= KEYBUF_END) return; // not set up yet
    let n = 0;
    while (n < this.toType.length) {
      const next = put + 1 === KEYBUF_END ? KEYBUF : put + 1;
      if (next === get) break; // full
      ram[put] = this.toType.charCodeAt(n++) & 0xff;
      put = next;
    }
    this.toType = this.toType.slice(n);
    ram[PUTPNT] = put & 0xff;
    ram[PUTPNT + 1] = put >> 8;
  }

  /**
   * A BIOS entry point the machine handles itself. Returns true when it
   * did the routine's work and returned to the caller.
   */
  private trap(pc: number): boolean {
    if (this.slots.slotOf(0) !== 0) return false; // the BIOS is not at page 0
    const cpu = this.cpu;
    if (pc === CHGET) {
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
      case STMOTR: break;
      default: return false;
    }
    cpu.f = carry ? cpu.f | 0x01 : cpu.f & ~0x01;
    // RET
    cpu.pc = this.slots.read(cpu.sp) | (this.slots.read((cpu.sp + 1) & 0xffff) << 8);
    cpu.sp = (cpu.sp + 2) & 0xffff;
    cpu.cycles += 50;
    return true;
  }

  /** The frame's sound: the PSG with any cartridge's SCC mixed in. */
  takeAudio(): Float32Array<ArrayBuffer> {
    const out = this.psg.take();
    for (const c of this.cartridges) c?.scc?.mixInto(out);
    return out;
  }

  private portIn(port: number): number {
    switch (port) {
      case 0x98: return this.vdp.readData();
      case 0x99: return this.vdp.readStatus();
      case 0xa2: return this.psg.read();
      case 0xa8: case 0xa9: case 0xaa: case 0xab: return this.ppi.in(port);
      default: return 0xff;
    }
  }

  private portOut(port: number, value: number): void {
    switch (port) {
      case 0x98: this.vdp.writeData(value); break;
      case 0x99: this.vdp.writeControl(value); break;
      case 0xa0: this.psg.select(value); break;
      case 0xa1: this.psg.write(value, this.cpu.cycles); break;
      case 0xa8: case 0xa9: case 0xaa: case 0xab: this.ppi.out(port, value); break;
    }
  }
}
