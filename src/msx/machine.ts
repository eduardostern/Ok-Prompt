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
 * Time is kept in CPU cycles: a frame is 262 lines (NTSC, 60 Hz) or 313
 * (PAL, 50 Hz) of 228 cycles. The VDP draws each picture line as its cycles
 * pass and raises the interrupt at the end of the picture.
 */
import { Z80 } from '../z80';
import { Cartridge } from './cartridge';
import { Ppi } from './ppi';
import { Psg } from './psg';
import { Ram, Rom, Slots, EMPTY } from './slots';
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
  private readonly sampleRate: number;

  constructor(bios: Bios, sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.psg = new Psg(CPU_CLOCK, sampleRate);
    const rom = new Rom().place(0x0000, bios.main);
    if (bios.logo) rom.place(0x8000, bios.logo);
    this.slots.insert(0, rom);
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

  /** Plugs a cartridge into port 1 or 2 (null takes it out). Reset to use it. */
  insert(port: 1 | 2, cart: Cartridge | null): void {
    this.cartridges[port - 1] = cart;
    if (cart?.scc) {
      cart.scc.sampleRate = this.sampleRate;
      cart.scc.now = () => this.cpu.cycles;
    }
    this.slots.insert(port, cart ?? EMPTY);
  }

  /** The reset button: CPU and chips back to power-on; RAM keeps its bytes. */
  reset(): void {
    this.cpu.reset();
    this.ppi.reset();
    this.vdp.reset();
    this.psg.reset();
    for (const c of this.cartridges) c?.reset();
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
