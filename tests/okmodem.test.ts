import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOkModem, cbiosFont, cp437Table } from '../scripts/build-okmodem';
import { KeyInput, KeyTable } from '../src/msx/keyboard';
import { Msx } from '../src/msx/machine';
import type { Dialer, LinkHandlers } from '../src/msx/modem';
import { ModemCartridge } from '../src/msx/modem-cart';
import type { V9938 } from '../src/msx/v9938';

const file = (p: string) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const BIOS = { main: file('src/roms/cbios_main_msx1.rom'), logo: file('src/roms/cbios_logo_msx1.rom') };
const ROM = file('src/roms/okmodem.rom');

/** A BBS on the other end of the line. */
class FakeBbs {
  sent: number[] = [];
  handlers?: LinkHandlers;
  dialer: Dialer = (_target, handlers) => {
    this.handlers = handlers;
    setTimeout(() => handlers.onOpen(), 0);
    return { send: (b) => this.sent.push(...b), close: () => {} };
  };
  say(text: string): void {
    this.handlers!.onData(Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff)));
  }
  heard(): string {
    const s = String.fromCharCode(...this.sent);
    this.sent = [];
    return s;
  }
}

/** The 40x24 text screen, rows as strings of MSX codes. */
const rows = (m: Msx) => {
  const nt = (m.vdp.regs[2] & 0x0f) << 10;
  const v = m.vdp.vram;
  return Array.from({ length: 24 }, (_, y) => String.fromCharCode(...v.subarray(nt + y * 40, nt + y * 40 + 40)));
};
const screen = (m: Msx) => rows(m).map((r) => r.trimEnd()).join('\n');
const frames = (m: Msx, n: number) => { for (let i = 0; i < n; i++) m.runFrame(); };
const settle = () => new Promise((r) => setTimeout(r, 0));

async function boot() {
  const bbs = new FakeBbs();
  const m = new Msx(BIOS);
  const cart = new ModemCartridge(ROM, { dialer: bbs.dialer, phoneBook: () => [{ host: 'bbs.example.com', port: 23, name: 'Example' }] });
  m.insert(1, cart);
  m.reset();
  frames(m, 300); // past the C-BIOS logo: the terminal starts by itself
  return { m, bbs, cart };
}

/** Dials the fake BBS with the modem cartridge. */
async function online() {
  const t = await boot();
  t.m.type('ATDT 1\r');
  frames(t.m, 30);
  await settle();
  frames(t.m, 30);
  expect(t.cart.modem.online).toBe(true);
  return t;
}

describe('the Ok-Modem cartridge', () => {
  it('is built from its source (npm run okmodem)', () => {
    const rebuilt = buildOkModem(readFileSync(new URL('../src/roms/okmodem.asm', import.meta.url), 'utf8'), cbiosFont(BIOS.main));
    expect(Buffer.from(rebuilt).equals(Buffer.from(ROM))).toBe(true);
  });

  it('maps CP437 lines and blocks to MSX characters by their shapes', () => {
    const t = cp437Table(cbiosFont(BIOS.main));
    const at = (c: number) => t[c - 0x80];
    expect(at(0xc4)).toBe(0x17); // ─
    expect(at(0xb3)).toBe(0x16); // │
    expect(at(0xda)).toBe(0x18); // ┌
    expect(at(0xc5)).toBe(0x15); // ┼
    expect(at(0xcd)).toBe(0x17); // ═ as ─
    expect(at(0xdb)).toBe(0xdb); // █
    expect(at(0xb1)).toBe(0xd7); // ▒: the checkerboard, not the cursor at FFh
    expect(at(0x87)).toBe(0x87); // ç: the same on both
  });

  it('starts its terminal under C-BIOS and talks to the modem', async () => {
    const { m } = await boot();
    expect(screen(m)).toContain('Ok-Modem');
    m.type('AT\r');
    frames(m, 30);
    expect(screen(m)).toMatch(/^OK$/m);
  });

  it('dials, shows the BBS with its ANSI codes and box lines, and sends keys', async () => {
    const { m, bbs } = await online();
    bbs.heard();
    bbs.say('\x1b[2J\x1b[1;1HWelcome\r\n\xda\xc4\xc4\xbf\r\n\x1b[5;10HX\x1b[1mbold\x1b[0m');
    frames(m, 30);
    const r = rows(m);
    expect(r[0].trimEnd()).toBe('Welcome');
    expect([...r[1].slice(0, 4)].map((c) => c.charCodeAt(0))).toEqual([0x18, 0x17, 0x17, 0x19]); // ┌──┐
    expect(r[4].slice(9, 14)).toBe('Xbold'); // row 5, column 10; colours ignored
    m.type('hi');
    frames(m, 10);
    expect(bbs.heard()).toBe('hi');
  });

  it('gets through Synchronet\'s terminal probe and reports the 40x24 corner', async () => {
    const { m, bbs } = await online();
    bbs.heard();
    // What Vertrauen sends first (recorded): save, attributes, an APC string,
    // far down and right, a report, restore, a UTF-8 BOM, another report.
    bbs.say('\r\n\x1b[s\x1b[0c\x1b_SyncTERM:Q;libsndfile\x1b\\\x1b[255B\x1b[255C\x1b[30;40m\b_\x1b[6n\x1b[u\x1b[!_\r\xef\xbb\xbf\x1b[6n\x1b[0m');
    frames(m, 20);
    // The corner, after BS and _; then column 4 after the 3-byte BOM (a CP437 terminal, not UTF-8).
    expect(bbs.heard()).toMatch(/^\x1b\[24;40R\x1b\[\d+;4R$/);
    expect(screen(m)).not.toContain('SyncTERM');
    bbs.say('\x1b(B\x1b[2JClean\x1b[5A\x1b[3DX');
    frames(m, 10);
    expect(rows(m)[0].trimEnd()).toBe('ClXan'); // up stops at row 1; left 3 from column 6
  });

  it('sends the arrows as ANSI and tells the BBS where the cursor is', async () => {
    const { m, bbs } = await online();
    const keys = new KeyInput(m.ppi);
    keys.table = KeyTable.find(BIOS.main);
    bbs.heard();
    keys.down('ArrowUp', 'ArrowUp');
    frames(m, 4);
    keys.up('ArrowUp');
    frames(m, 10);
    expect(bbs.heard()).toBe('\x1b[A');
    bbs.say('\x1b[255;255H\x1b[6n');
    frames(m, 10);
    expect(bbs.heard()).toBe('\x1b[24;40R');
  });

  it('shows 80 columns on an MSX2 and tells the BBS so', async () => {
    const msx2 = { main: file('src/roms/cbios_main_msx2.rom'), logo: file('src/roms/cbios_logo_msx2.rom'), sub: file('src/roms/cbios_sub.rom') };
    const bbs = new FakeBbs();
    const m = new Msx(msx2);
    const cart = new ModemCartridge(ROM, { dialer: bbs.dialer, phoneBook: () => [{ host: 'bbs.example.com', port: 23 }] });
    m.insert(1, cart);
    m.powerCycle();
    frames(m, 400);
    const v = m.vdp as V9938;
    expect(v.mode).toBe('T2');
    expect(cart.modem.windowSize()).toEqual([80, 24]);
    m.type('ATDT 1\r');
    frames(m, 30);
    await settle();
    frames(m, 30);
    bbs.heard();
    bbs.say('\x1b[255;255H\x1b[6n');
    frames(m, 10);
    expect(bbs.heard()).toBe('\x1b[24;80R');
  });
});
