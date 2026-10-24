/** Writes src/roms/okmodem.rom from src/roms/okmodem.asm (see build-okmodem.ts). */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildOkModem, cbiosFont } from './build-okmodem';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/roms/okmodem.asm', root), 'utf8');
const bios = new Uint8Array(readFileSync(new URL('src/roms/cbios_main_msx1.rom', root)));
const rom = buildOkModem(source, cbiosFont(bios));
writeFileSync(new URL('src/roms/okmodem.rom', root), rom);
const used = rom.findLastIndex((b) => b !== 0xff) + 1;
console.log(`okmodem.rom: ${used} bytes of code and data, padded to 16K`);
