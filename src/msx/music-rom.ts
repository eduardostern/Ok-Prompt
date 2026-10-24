/**
 * The MSX-MUSIC ROM, our own: software looks for the FM chip by the
 * string "APRLOPLL" at 4018h in some slot (built-in MSX-MUSIC; an FM-PAC
 * cartridge has "PAC2OPLL"). Real ones also hold FM-BASIC and the FM BIOS,
 * which are copyrighted; this one has only the string and the FM BIOS
 * entries (4110h-4122h) as plain RETs. Games that drive the chip through
 * its ports (7Ch, 7Dh), as most do, play their FM music.
 */
export function musicRom(): Uint8Array {
  const rom = new Uint8Array(0x4000).fill(0xff);
  rom.fill(0, 0, 0x18);
  rom.set([0x41, 0x42]); // "AB", no init, no CALL statements, no device, no BASIC text
  rom.set([...'APRLOPLL'].map((c) => c.charCodeAt(0)), 0x18);
  for (let a = 0x110; a <= 0x122; a += 3) rom[a] = 0xc9; // WRTOPL INIOPL MSTART MSTOP RDDATA OPLDRV TSTBGM
  return rom;
}
