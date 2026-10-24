/**
 * Runs MSX BASIC from a real machine's BIOS, which cannot be in the repo.
 * Skipped unless MSX_BIOS points at a dump, e.g.:
 *
 *   MSX_BIOS=~/Downloads/expert_1.1_basic-bios1.rom npx vitest run tests/real-bios.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KeyInput, KeyTable } from '../src/msx/keyboard';
import { checkBios, Msx } from '../src/msx/machine';
import { Tape } from '../src/msx/tape';

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
    expect(screen(boot())).toMatch(/^ ?Ok$/m); // the Expert 1.0 starts lines one column in
  });

  it('types into BASIC through the key buffer', () => {
    const m = boot();
    m.type('PRINT 6*7\r');
    frames(m, 60);
    expect(screen(m)).toMatch(/^ ? 42$/m);
  });

  it('types the characters of a PC keyboard through the BIOS key table', () => {
    const m = boot();
    const keys = new KeyInput(m.ppi);
    keys.table = KeyTable.find(main);
    expect(keys.table).not.toBeNull();
    const tap = (code: string, key: string) => { keys.down(code, key); frames(m, 3); keys.up(code); frames(m, 3); };
    // As a Brazilian PC keyboard sends them: letters by position, the rest by character.
    for (const ch of 'PRINT "') {
      if (ch === ' ') tap('Space', ' ');
      else if (/[A-Z]/.test(ch)) { keys.down('ShiftLeft', 'Shift'); tap(`Key${ch}`, ch); keys.up('ShiftLeft'); }
      else tap('Digit1', ch); // whatever PC key: the character decides
    }
    for (const ch of 'çãé@^:;?/[]') tap('Semicolon', ch);
    tap('Digit1', '"');
    tap('Enter', '\r');
    frames(m, 30);
    const shown = screen(m);
    // The MSX echoes the line and prints it, in this BIOS's character set.
    const out = String.fromCharCode(...[...'çãé@^:;?/[]'].map((ch) => keys.table!.codeFor(ch)));
    expect(out).not.toContain(String.fromCharCode(0xffff)); // every character has a key
    expect(shown).toContain('PRINT "' + out + '"');
    expect(shown.split('\n').map((l) => l.trim())).toContain(out);
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
    expect(screen(m)).toMatch(/^ ?OI DO TAPE$/m);
  });
});
