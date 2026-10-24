/**
 * Runs MSX BASIC from a real machine's BIOS, which cannot be in the repo.
 * Skipped unless MSX_BIOS points at a dump, e.g.:
 *
 *   MSX_BIOS=~/Downloads/expert_1.1_basic-bios1.rom npx vitest run tests/real-bios.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KeyInput, KeyTable, msxText } from '../src/msx/keyboard';
import { printedText } from '../src/msx/printer';
import { biosLabel, checkBios, Msx } from '../src/msx/machine';
import { asciiCas, Tape } from '../src/msx/tape';
import { ModemCartridge } from '../src/msx/modem-cart';

const path = process.env.MSX_BIOS?.replace(/^~/, process.env.HOME ?? '~');
const main = path ? new Uint8Array(readFileSync(path)) : new Uint8Array(0);

const screen = (m: Msx) => {
  const nt = (m.vdp.regs[2] & 0x0f) << 10;
  const cols = m.vdp.regs[1] & 0x10 ? 40 : 32;
  const v = m.vdp.vram;
  const lines: string[] = [];
  for (let y = 0; y < 24; y++) lines.push(String.fromCharCode(...v.subarray(nt + y * cols, nt + (y + 1) * cols)).trimEnd());
  return lines.join('\n');
};
const frames = (m: Msx, n: number) => { for (let i = 0; i < n; i++) m.runFrame(); };

function boot(): Msx {
  const m = new Msx({ main });
  m.powerCycle();
  frames(m, 400);
  return m;
}

describe.skipIf(!path)('a real MSX BIOS (MSX_BIOS)', () => {
  it('passes the BIOS check and boots to MSX BASIC', () => {
    expect(() => checkBios(main)).not.toThrow();
    expect(biosLabel(main)).toMatch(/^(Gradiente Expert|Sharp Hotbit|MSX BASIC) \d\.\d$/);
    expect(screen(boot())).toMatch(/^ *Ok$/m); // some BIOSes start lines a column or two in
  });

  it('types into BASIC through the key buffer', () => {
    const m = boot();
    m.type('PRINT 6*7\r');
    frames(m, 60);
    expect(screen(m)).toMatch(/^ * 42$/m);
  });

  it('types the characters of a PC keyboard through the BIOS key table', () => {
    const m = boot();
    const keys = new KeyInput(m.ppi);
    keys.table = KeyTable.find(main);
    expect(keys.table).not.toBeNull();
    keys.inject = (code) => m.type(String.fromCharCode(code));
    const tap = (code: string, key: string) => { keys.down(code, key); frames(m, 3); keys.up(code); frames(m, 3); };
    // The Hotbit's BIOS turns CAPS on at power-up (and its CAPS capitalises ç too).
    if (m.ppi.capsLamp) tap('CapsLock', 'CapsLock');
    expect(m.ppi.capsLamp).toBe(false);
    // As a Brazilian PC keyboard sends them: letters by position, the rest by character.
    for (const ch of 'PRINT "') {
      if (ch === ' ') tap('Space', ' ');
      else if (/[A-Z]/.test(ch)) { keys.down('ShiftLeft', 'Shift'); tap(`Key${ch}`, ch); keys.up('ShiftLeft'); }
      else tap('Digit1', ch); // whatever PC key: the character decides
    }
    // Accented letters come from the letter's own PC key, as after a dead key.
    const typed: [string, string][] = [['Semicolon', 'ç'], ['KeyA', 'ã'], ['KeyE', 'é'], ['KeyO', 'õ'],
      ...[...'@^:;?/[]'].map((ch): [string, string] => ['Quote', ch])];
    for (const [code, ch] of typed) tap(code, ch);
    tap('Digit1', '"');
    tap('Enter', '\r');
    frames(m, 30);
    const shown = screen(m);
    // The MSX echoes the line and prints it, in this BIOS's character set:
    // through its keys, or straight into the key buffer if no key gives it.
    const out = String.fromCharCode(...typed.map(([, ch]) => keys.table!.charCode(ch)));
    expect(out).not.toContain(String.fromCharCode(0xffff)); // every character exists
    expect(shown).toContain('PRINT "' + out + '"');
    expect(shown.split('\n').map((l) => l.trim())).toContain(out);
  });

  it('runs the modem cartridge\'s terminal with CALL TERM, and CTRL+STOP leaves it', () => {
    const m = new Msx({ main });
    const cart = new ModemCartridge(new Uint8Array(readFileSync(new URL('../src/roms/okmodem.rom', import.meta.url))));
    m.insert(2, cart);
    m.powerCycle();
    frames(m, 400);
    expect(screen(m)).toMatch(/^ *Ok$/m); // BASIC starts as usual
    m.type('CALL TERM\r');
    frames(m, 60);
    expect(screen(m)).toContain('Ok-Modem');
    m.type('AT\r');
    frames(m, 30);
    expect(screen(m)).toMatch(/^ *OK$/m);
    m.ppi.key(6, 1, true); // CTRL
    m.ppi.key(7, 4, true); // STOP
    frames(m, 10);
    m.ppi.key(7, 4, false);
    m.ppi.key(6, 1, false);
    frames(m, 60);
    expect(screen(m)).toContain('Back to BASIC');
    m.type('PRINT 6*7\r');
    frames(m, 60);
    expect(screen(m)).toMatch(/^ * 42$/m);
  });

  it('runs a BASIC program put on tape as text (the AI board\'s way) with RUN"CAS:"', () => {
    const m = boot();
    m.tape = new Tape(asciiCas('OI', '10 CLS\n20 PRINT "OI DA FITA"\n30 END\n'), 'oi.cas');
    m.type('RUN"CAS:"\r');
    frames(m, 120);
    expect(screen(m)).toMatch(/^ *OI DA FITA$/m);
  });

  it('saves to a blank tape with CSAVE and loads it back with CLOAD', () => {
    const m = boot();
    m.tape = new Tape(new Uint8Array(0), 'test.cas');
    m.type('10 PRINT "OI DO TAPE"\rCSAVE "PROG"\r');
    frames(m, 120);
    expect(m.tape.first()).toEqual({ kind: 'basic', name: 'PROG' });
    m.type('NEW\r');
    frames(m, 30);
    m.tape.rewind();
    m.type('CLOAD\rRUN\r');
    frames(m, 120);
    expect(screen(m)).toMatch(/^ *OI DO TAPE$/m);
  });

  it('takes a pasted program: every line typed, then RUN', () => {
    const m = boot();
    const lines = Array.from({ length: 30 }, (_, i) => `${(i + 1) * 10} A=A+${i + 1}`);
    m.type(msxText([...lines, `${310} PRINT "SOMA";A`, 'RUN', ''].join('\n')));
    for (let i = 0; i < 3000 && m.typing; i++) frames(m, 1);
    frames(m, 60);
    expect(m.typing).toBe(false);
    expect(screen(m)).toMatch(/^ *SOMA 465 *$/m);
  });

  it('prints to the printer with LPRINT', () => {
    const m = boot();
    m.type('LPRINT "OI DA IMPRESSORA"\r');
    frames(m, 60);
    expect(printedText(m.printer.bytes, (c) => String.fromCharCode(c))).toContain('OI DA IMPRESSORA\n');
  });
});

