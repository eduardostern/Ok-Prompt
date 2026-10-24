import { describe, expect, it } from 'vitest';
import { assemble, AsmError } from '../scripts/z80asm';
import { Z80 } from '../src/z80';

const hex = (src: string) => [...assemble(src).bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

describe('Z80 assembler', () => {
  it('encodes the instruction set as Zilog does', () => {
    const cases: [string, string][] = [
      ['nop', '00'], ['halt', '76'], ['di', 'f3'], ['ei', 'fb'], ['exx', 'd9'], ['neg', 'ed 44'],
      ['ldir', 'ed b0'], ['otir', 'ed b3'], ['im 1', 'ed 56'], ['reti', 'ed 4d'],
      ['ld a,b', '78'], ['ld (hl),a', '77'], ['ld e,(hl)', '5e'], ['ld b,12h', '06 12'],
      ['ld a,(ix+5)', 'dd 7e 05'], ['ld (iy-2),c', 'fd 71 fe'], ['ld (ix+1),0ffh', 'dd 36 01 ff'],
      ['ld a,(bc)', '0a'], ['ld (de),a', '12'], ['ld a,(1234h)', '3a 34 12'], ['ld (1234h),a', '32 34 12'],
      ['ld hl,1234h', '21 34 12'], ['ld sp,0f380h', '31 80 f3'], ['ld ix,1', 'dd 21 01 00'],
      ['ld hl,(5)', '2a 05 00'], ['ld de,(5)', 'ed 5b 05 00'], ['ld (5),hl', '22 05 00'], ['ld (5),bc', 'ed 43 05 00'],
      ['ld (5),iy', 'fd 22 05 00'], ['ld sp,hl', 'f9'], ['ld a,i', 'ed 57'], ['ld r,a', 'ed 4f'],
      ['push af', 'f5'], ['pop bc', 'c1'], ['push ix', 'dd e5'], ['pop iy', 'fd e1'],
      ["ex af,af'", '08'], ['ex de,hl', 'eb'], ['ex (sp),hl', 'e3'],
      ['inc a', '3c'], ['dec (hl)', '35'], ['inc de', '13'], ['dec sp', '3b'], ['inc (ix+2)', 'dd 34 02'], ['dec iy', 'fd 2b'],
      ['add a,c', '81'], ['add 5', 'c6 05'], ['sub b', '90'], ['and 0fh', 'e6 0f'], ['xor a', 'af'], ['or (hl)', 'b6'],
      ['cp 20h', 'fe 20'], ['cp (iy+3)', 'fd be 03'], ['sbc a,e', '9b'], ['adc a,10', 'ce 0a'],
      ['add hl,de', '19'], ['add hl,hl', '29'], ['add ix,ix', 'dd 29'], ['add iy,bc', 'fd 09'],
      ['adc hl,sp', 'ed 7a'], ['sbc hl,de', 'ed 52'],
      ['rlc b', 'cb 00'], ['srl a', 'cb 3f'], ['rl (hl)', 'cb 16'], ['sla (ix+4)', 'dd cb 04 26'],
      ['bit 7,a', 'cb 7f'], ['set 0,(hl)', 'cb c6'], ['res 3,(iy+1)', 'fd cb 01 9e'],
      ['jp 1234h', 'c3 34 12'], ['jp nz,1234h', 'c2 34 12'], ['jp m,0', 'fa 00 00'], ['jp (hl)', 'e9'], ['jp (ix)', 'dd e9'],
      ['call 00a2h', 'cd a2 00'], ['call z,5', 'cc 05 00'], ['ret', 'c9'], ['ret nc', 'd0'], ['rst 38h', 'ff'],
      ['in a,(99h)', 'db 99'], ['in b,(c)', 'ed 40'], ['out (98h),a', 'd3 98'], ['out (c),e', 'ed 59'],
    ];
    for (const [src, want] of cases) expect(hex(src), src).toBe(want);
  });

  it('resolves labels forwards and backwards, relative jumps and $', () => {
    expect(hex(`
      org 4000h
start:  jr next      ; forward
        djnz start   ; backward
next    jp start
        jr $`)).toBe('18 02 10 fc c3 00 40 18 fe');
  });

  it('handles EQU, DB strings, DW, DS and expressions', () => {
    const r = assemble(`
CHPUT   equ 00a2h
        org 4000h
        db "AB", 'x', 0
        dw init, CHPUT + 1
        ds 3, 0aah
        db (CHPUT >> 8) | 1, -1, 'A'+1, %101, $10, &H20, 10 % 3
init:   ld a,low
low     equ init & 0ffh`);
    expect([...r.bytes].map((b) => b.toString(16))).toEqual(
      '41 42 78 0 12 40 a3 0 aa aa aa 1 ff 42 5 10 20 1 3e 12'.split(' '));
    expect(r.origin).toBe(0x4000);
    expect(r.symbols.get('init')).toBe(0x4012);
  });

  it('reports errors with the line number', () => {
    expect(() => assemble('nop\n  ld (hl),(hl)')).toThrow(AsmError);
    expect(() => assemble('nop\n  ld (hl),(hl)')).toThrow(/line 2/);
    expect(() => assemble('  jp nowhere')).toThrow(/unknown symbol "nowhere"/);
    expect(() => assemble('a: nop\na: nop')).toThrow(/twice/);
    expect(() => assemble('  jr far\n  ds 200\nfar: nop')).toThrow(/out of range/);
    expect(() => assemble('  ld a,300')).toThrow(/fit a byte/);
  });

  it('builds programs that run on the Z80 core', () => {
    // Sum 1..10 into HL, then store it at 8000h.
    const r = assemble(`
        org 0
        ld hl,0
        ld b,10
loop:   ld e,b
        ld d,0
        add hl,de
        djnz loop
        ld (8000h),hl
        halt`);
    const cpu = new Z80();
    cpu.mem.set(r.bytes, r.origin);
    for (let i = 0; i < 200 && !cpu.halted; i++) cpu.step();
    expect(cpu.halted).toBe(true);
    expect(cpu.mem[0x8000] | (cpu.mem[0x8001] << 8)).toBe(55);
  });
});
