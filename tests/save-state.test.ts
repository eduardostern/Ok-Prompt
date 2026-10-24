// Save states: a machine saved, run on, and a fresh machine loaded with the
// state must run the same frames: picture, CPU and sound.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { Cartridge } from '../src/msx/cartridge';
import { Bios, Msx } from '../src/msx/machine';
import { Disk, blankDisk } from '../src/msx/disk';
import { asciiCas, Tape } from '../src/msx/tape';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));
const MSX1: Bios = { main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') };
const MSX2: Bios = { main: rom('cbios_main_msx2.rom'), logo: rom('cbios_logo_msx2.rom'), sub: rom('cbios_sub.rom') };

/** A busy cartridge: a counter, VRAM writes, PSG and FM notes, once a frame. */
const busy = () => {
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
init:   ei
        ld a, 7
        out (0A0h), a
        ld a, 0B8h
        out (0A1h), a
loop:   ld hl, (0C000h)
        inc hl
        ld (0C000h), hl
        ld a, l
        out (98h), a
        ld a, 8
        out (0A0h), a
        ld a, l
        and 15
        out (0A1h), a
        ld a, 0
        out (0A0h), a
        ld a, h
        out (0A1h), a
        ld a, 30h
        out (7Ch), a
        ld a, l
        out (7Dh), a
        ld a, 20h
        out (7Ch), a
        ld a, 18h
        out (7Dh), a
        halt
        jr loop`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return new Cartridge(r, 'plain', 'busy.rom');
};

function machine(bios: Bios) {
  const m = new Msx(bios);
  m.setFm(true);
  m.insert(1, busy());
  m.powerCycle();
  return m;
}

/** Runs n frames: the last frame's picture, the CPU, and a sum of the sound. */
function run(m: Msx, n: number) {
  let sound = 0;
  for (let i = 0; i < n; i++) {
    m.runFrame();
    for (const v of m.takeAudio()) sound += v;
  }
  const { pc, sp, a, f, h, l } = m.cpu;
  return { frame: m.vdp.frame.slice(), cpu: [pc, sp, a, f, h, l], sound: sound.toFixed(6), counter: m.slots.read(0xc000) };
}

describe('save states', () => {
  for (const [name, bios] of [['MSX1', MSX1], ['MSX2', MSX2]] as const) {
    it(`replays the same frames from a saved state (${name})`, () => {
      const m = machine(bios);
      m.tape = new Tape(asciiCas('OI', '10 PRINT 1\n'), 'oi.cas');
      m.insertDisk(new Disk(blankDisk(), 'a.dsk'));
      run(m, 450);
      const state = structuredClone(m.saveState()); // as IndexedDB keeps it
      const want = run(m, 60);

      const fresh = machine(bios);
      run(fresh, 7); // somewhere else entirely
      fresh.loadState(state);
      const got = run(fresh, 60);
      expect(got.cpu).toEqual(want.cpu);
      expect(got.counter).toBe(want.counter);
      expect(got.sound).toBe(want.sound);
      expect(got.frame).toEqual(want.frame);
      expect(fresh.tape?.name).toBe('oi.cas');
      expect(fresh.disk?.name).toBe('a.dsk');
    });
  }

  it('refuses a state of another model', () => {
    const state = machine(MSX1).saveState();
    expect(() => machine(MSX2).loadState(state)).toThrow(/MSX1/);
  });
});
