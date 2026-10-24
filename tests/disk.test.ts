// The disk drive: a disk ROM's jump table done by the machine on a .dsk.
// The test disk ROM is ours (any real one works the same way): its start-up
// calls DSKIO, DSKCHG, GETDPB and DSKFMT as MSX-DOS would.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble } from '../scripts/z80asm';
import { blankDisk, Disk, DiskRomSlot, diskRomIn, dpb, isDiskRom, SECTOR, standardGeometry } from '../src/msx/disk';
import { Bios, Msx } from '../src/msx/machine';

const rom = (n: string) => new Uint8Array(readFileSync(new URL(`../src/roms/${n}`, import.meta.url)));
const MSX1: Bios = { main: rom('cbios_main_msx1.rom'), logo: rom('cbios_logo_msx1.rom') };
const MSX2: Bios = { main: rom('cbios_main_msx2.rom'), logo: rom('cbios_logo_msx2.rom'), sub: rom('cbios_sub.rom') };

/** A disk ROM whose init runs `body`; its jump table leads to HALT (never reached: trapped). */
function diskRom(body: string): Uint8Array {
  const { bytes } = assemble(`
        org 4000h
        db "AB"
        dw init
        ds 12, 0
        jp never            ; 4010h DSKIO
        jp never            ; 4013h DSKCHG
        jp never            ; 4016h GETDPB
        jp never            ; 4019h CHOICE
        jp never            ; 401Ch DSKFMT
never:  halt
init:
${body}
        ld a, 1
        ld (0C3FFh), a      ; done
        ret`);
  const r = new Uint8Array(0x4000).fill(0xff);
  r.set(bytes);
  return r;
}

/** DSKIO: read (carry clear) or write `n` sectors from `sector` at `addr`; error code to `flag`. */
const dskio = (write: boolean, n: number, sector: number, addr: number, flag: number) => `
        ld hl, ${addr}
        ld de, ${sector}
        ld b, ${n}
        xor a
        ld c, 0F9h
        ${write ? 'scf' : 'or a'}
        call 4010h
        ld (${flag}), a
        ld a, 0
        rla
        ld (${flag + 1}), a ; carry
        ld a, b
        ld (${flag + 2}), a`;

function boot(bios: Bios, body: string, disk: Disk | null) {
  const m = new Msx(bios);
  m.setDiskRom(diskRom(body));
  m.insertDisk(disk);
  m.powerCycle();
  for (let i = 0; i < 800 && m.slots.read(0xc3ff) !== 1; i++) m.runFrame();
  const ram = (a: number, n: number) => Array.from({ length: n }, (_, i) => m.slots.read(a + i));
  return { m, ram };
}

const sample = () => {
  const d = blankDisk();
  for (let i = 0; i < SECTOR; i++) d[3 * SECTOR + i] = (i * 7) & 0xff;
  return new Disk(d, 'test.dsk');
};

describe('the disk drive', () => {
  for (const [name, bios] of [['MSX1', MSX1], ['MSX2', MSX2]] as const) {
    it(`reads sectors through DSKIO on an ${name}`, () => {
      const { ram } = boot(bios, dskio(false, 2, 3, 0xc400, 0xc3f0), sample());
      expect(ram(0xc3ff, 1)).toEqual([1]);
      expect(ram(0xc3f0, 3)).toEqual([0, 0, 0]); // no error, carry clear, none left
      expect(ram(0xc400, 8)).toEqual([0, 7, 14, 21, 28, 35, 42, 49]);
    });
  }

  it('writes sectors, and tells the page', () => {
    const disk = sample();
    let told = 0;
    const m = new Msx(MSX2);
    m.setDiskRom(diskRom(`
        ld hl, 0C400h
        ld (hl), 0AAh
        ${dskio(true, 1, 10, 0xc400, 0xc3f0)}`));
    m.insertDisk(disk);
    m.onDiskWritten = () => told++;
    m.powerCycle();
    for (let i = 0; i < 800 && m.slots.read(0xc3ff) !== 1; i++) m.runFrame();
    expect(disk.read(10)![0]).toBe(0xaa);
    expect(told).toBe(1);
  });

  it('puts sectors read to page 1 in the RAM there, not in the disk ROM', () => {
    const { m } = boot(MSX2, dskio(false, 1, 3, 0x4000, 0xc3f0), sample());
    // The MSX2's page 1 RAM is mapper segment 2 (C-BIOS sets 3, 2, 1, 0).
    const seg = m.mapper.getPage(1) & 0x1f;
    expect(Array.from(m.mapper.data.subarray(seg * 0x4000, seg * 0x4000 + 4))).toEqual([0, 7, 14, 21]);
  });

  it('reports no disk, and a sector past the end', () => {
    const none = boot(MSX2, dskio(false, 1, 0, 0xc400, 0xc3f0), null);
    expect(none.ram(0xc3f0, 2)).toEqual([2, 1]); // not ready
    const past = boot(MSX2, dskio(false, 2, 1439, 0xc400, 0xc3f0), sample());
    expect(past.ram(0xc3f0, 3)).toEqual([8, 1, 1]); // record not found, one sector left
  });

  it('answers DSKCHG once with a new disk, then no change; GETDPB fills the DPB', () => {
    const { ram } = boot(MSX2, `
        ld hl, 0C500h
        xor a
        call 4013h          ; DSKCHG
        ld a, b
        ld (0C3F0h), a
        ld hl, 0C600h
        xor a
        call 4013h
        ld a, b
        ld (0C3F1h), a
        ld hl, 0C700h
        xor a
        ld c, 0F9h
        call 4016h          ; GETDPB`, sample());
    expect(ram(0xc3f0, 2)).toEqual([0xff, 1]);
    const want = dpb(standardGeometry(737_280));
    expect(ram(0xc501, 18)).toEqual(want);
    expect(ram(0xc701, 18)).toEqual(want);
    // F9h: 720K, 2 sectors a cluster, data from sector 14, 714 clusters + 1, 3 sectors a FAT, directory at 7.
    expect(want).toEqual([0xf9, 0, 2, 0x0f, 4, 1, 2, 1, 0, 2, 112, 14, 0, 0xca, 2, 3, 7, 0]);
  });

  it('formats the disk with DSKFMT', () => {
    const d = new Disk(new Uint8Array(737_280).fill(0xe5), 'new.dsk');
    boot(MSX2, `
        ld a, 1
        ld d, 0
        call 401Ch          ; DSKFMT`, d);
    expect(d.geometry()).toEqual(standardGeometry(737_280));
    expect(Array.from(d.read(1)!.subarray(0, 3))).toEqual([0xf9, 0xff, 0xff]);
  });
});

describe('disk ROM files', () => {
  it('finds the disk ROM in a 16K or 32K dump', () => {
    const r = diskRom('');
    expect(isDiskRom(r)).toBe(true);
    const big = new Uint8Array(0x8000).fill(0xff);
    big.set(r, 0x4000);
    expect(diskRomIn(big)).toEqual(r);
    expect(diskRomIn(new Uint8Array(0x4000))).toBeNull();
  });
});

describe('the idle floppy controller', () => {
  // Disk ROMs look for their controller as they start: FastDROM writes the
  // track register and reads it back, and installs nothing if it differs.
  it('reads back its track, sector and data registers (Microsol ports D1h-D3h)', () => {
    const m = new Msx(MSX1);
    m.setDiskRom(diskRom(''));
    const out = (p: number, v: number) => m.cpu.portOut(p, v);
    const inp = (p: number) => m.cpu.portIn(p);
    out(0xd1, 0x5a);
    out(0xd2, 0x07);
    out(0xd3, 0x21);
    expect([inp(0xd1), inp(0xd2), inp(0xd3)]).toEqual([0x5a, 0x07, 0x21]);
    expect(inp(0xd0) & 1).toBe(0); // not busy
    out(0xd0, 0x10); // seek to the data register's track
    expect(inp(0xd1)).toBe(0x21);
    out(0xd0, 0x00); // restore
    expect(inp(0xd1)).toBe(0);
  });

  it('does the same at 7FF8h-7FFBh (Philips)', () => {
    const slot = new DiskRomSlot(diskRom(''));
    slot.write(0x7ff9, 0x33);
    slot.write(0x7ffa, 0x05);
    expect([slot.read(0x7ff9), slot.read(0x7ffa), slot.read(0x7ff8) & 1]).toEqual([0x33, 0x05, 0]);
    expect(slot.read(0x4000)).toBe(0x41); // the ROM around it
  });
});

