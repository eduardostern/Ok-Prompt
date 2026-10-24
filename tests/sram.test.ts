// Battery-backed RAM in ASCII cartridges (game saves).
import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/msx/cartridge';

/** A ROM whose every 8K page starts with its page number. */
const rom = (kb: number) => {
  const r = new Uint8Array(kb * 1024);
  for (let p = 0; p < r.length / 0x2000; p++) r[p * 0x2000] = p;
  return r;
};

describe('battery-backed RAM', () => {
  it('ASCII 8K: a bank value with the bit above the ROM shows the RAM, written in 8000h-BFFFh', () => {
    const c = new Cartridge(rom(128), 'ascii8sram'); // 16 pages: bit 10h
    let writes = 0;
    c.onSramWrite = () => writes++;
    c.write(0x7000, 0x05); // 8000h: page 5
    expect(c.read(0x8000)).toBe(5);
    c.write(0x8000, 0x42); // ROM there: ignored
    expect(writes).toBe(0);
    c.write(0x7000, 0x10); // the RAM
    c.write(0x8000, 0x42);
    c.write(0x9fff, 0x24);
    expect([c.read(0x8000), c.read(0x9fff)]).toEqual([0x42, 0x24]);
    expect(writes).toBe(2);
    c.write(0x7000, 0x05);
    expect(c.read(0x8000)).toBe(5); // ROM again
    c.write(0x6000, 0x10); // RAM at 4000h: readable, not writable
    expect(c.read(0x4000)).toBe(0x42);
    c.write(0x4000, 0x99);
    expect(c.read(0x4000)).toBe(0x42);
    c.reset();
    expect(c.sram![0]).toBe(0x42); // kept through a reset
  });

  it('ASCII 16K: bit 4 shows 2K of RAM, mirrored over the 16K window', () => {
    const c = new Cartridge(rom(128), 'ascii16sram');
    c.write(0x7000, 0x10);
    c.write(0x8000, 0x77);
    expect([c.read(0x8800), c.read(0xb800)]).toEqual([0x77, 0x77]);
    c.write(0x7000, 0x02);
    expect(c.read(0x8000)).toBe(4); // 16K bank 2 = 8K page 4
  });
});
