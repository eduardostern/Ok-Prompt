/**
 * A small two-pass Z80 assembler, enough to build Ok-Prompt's own ROMs
 * (the modem cartridge's terminal) from source kept in the repo.
 *
 * Syntax: `label: MNEMONIC operands ; comment`, case-insensitive. Labels may
 * also stand alone (with or without the colon when at column 0). Directives:
 * ORG, EQU (`name EQU expr`), DB (numbers and 'strings' or "strings"), DW,
 * DS count[,fill]. Numbers: 123, 0x7B, 7Bh, $7B, &H7B, %1111011, 'c'.
 * Expressions: + - * / % & | ^ << >> ~, unary -, parentheses, $ for the
 * current address. The documented Z80 instruction set, with IX and IY.
 */

export interface AsmResult {
  /** The bytes from the first ORG (or 0) to the end. */
  bytes: Uint8Array;
  origin: number;
  symbols: Map<string, number>;
}

export class AsmError extends Error {
  constructor(readonly line: number, message: string) {
    super(`line ${line}: ${message}`);
  }
}

const R8: Record<string, number> = { b: 0, c: 1, d: 2, e: 3, h: 4, l: 5, '(hl)': 6, a: 7 };
const R16: Record<string, number> = { bc: 0, de: 1, hl: 2, sp: 3 };
const R16AF: Record<string, number> = { bc: 0, de: 1, hl: 2, af: 3 };
const CC: Record<string, number> = { nz: 0, z: 1, nc: 2, c: 3, po: 4, pe: 5, p: 6, m: 7 };
const ALU: Record<string, number> = { add: 0, adc: 1, sub: 2, sbc: 3, and: 4, xor: 5, or: 6, cp: 7 };
const ROT: Record<string, number> = { rlc: 0, rrc: 1, rl: 2, rr: 3, sla: 4, sra: 5, sll: 6, srl: 7 };
const SIMPLE: Record<string, number[]> = {
  nop: [0x00], halt: [0x76], di: [0xf3], ei: [0xfb], exx: [0xd9],
  rlca: [0x07], rrca: [0x0f], rla: [0x17], rra: [0x1f], daa: [0x27], cpl: [0x2f], scf: [0x37], ccf: [0x3f],
  neg: [0xed, 0x44], reti: [0xed, 0x4d], retn: [0xed, 0x45], rld: [0xed, 0x6f], rrd: [0xed, 0x67],
  ldi: [0xed, 0xa0], ldir: [0xed, 0xb0], ldd: [0xed, 0xa8], lddr: [0xed, 0xb8],
  cpi: [0xed, 0xa1], cpir: [0xed, 0xb1], cpd: [0xed, 0xa9], cpdr: [0xed, 0xb9],
  ini: [0xed, 0xa2], inir: [0xed, 0xb2], ind: [0xed, 0xaa], indr: [0xed, 0xba],
  outi: [0xed, 0xa3], otir: [0xed, 0xb3], outd: [0xed, 0xab], otdr: [0xed, 0xbb],
};

/** An operand, classified. */
type Op =
  | { k: 'r8'; r: number }                      // B C D E H L (HL) A
  | { k: 'idx'; p: number; d: string }           // (IX+d) / (IY+d): p = DD/FD, d an expression
  | { k: 'r16'; name: string }                   // BC DE HL SP AF IX IY
  | { k: 'ind16'; name: string }                 // (BC) (DE) (SP) (IX) (IY) (C)
  | { k: 'mem'; e: string }                      // (nn)
  | { k: 'imm'; e: string }                      // nn
  | { k: 'name'; name: string };                 // I R AF' and condition names

function classify(raw: string): Op {
  const s = raw.trim();
  const l = s.toLowerCase().replace(/\s+/g, '');
  if (l in R8) return { k: 'r8', r: R8[l] };
  if (['bc', 'de', 'hl', 'sp', 'af', 'ix', 'iy'].includes(l)) return { k: 'r16', name: l };
  if (["af'", 'i', 'r'].includes(l)) return { k: 'name', name: l };
  if (['(bc)', '(de)', '(sp)', '(ix)', '(iy)', '(c)'].includes(l)) return { k: 'ind16', name: l.slice(1, -1) };
  const m = /^\((ix|iy)([+-].*)\)$/.exec(l);
  if (m) return { k: 'idx', p: m[1] === 'ix' ? 0xdd : 0xfd, d: m[2] };
  if (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) return { k: 'mem', e: s.slice(1, -1) };
  return { k: 'imm', e: s };
}

/** Whether the parentheses of `s` balance, so "(1)+(2)" is not taken as memory. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Splits operands on commas outside quotes and parentheses. */
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      // An apostrophe right after AF is the AF' register, not a quote.
      if (ch === "'" && /af$/i.test(cur.trim())) cur += ch;
      else { quote = ch; cur += ch; }
    } else if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Strips a comment, minding quotes. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" && /af$/i.test(line.slice(0, i))) continue; // AF'
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';') return line.slice(0, i);
  }
  return line;
}

// ---- expressions ------------------------------------------------------------

class Expr {
  private i = 0;
  private toks: string[];
  constructor(src: string, private readonly sym: (name: string) => number, private readonly here: number) {
    this.toks = src.match(/'(?:[^'\\]|\\.)'|"[^"]*"|<<|>>|&H[0-9a-f]+|\$[0-9a-f]+|%[01]+|[0-9][0-9a-f]*h\b|0x[0-9a-f]+|[0-9]+|[a-z_.?@][\w.?@]*|\$|[-+*/%&|^~()]/gi) ?? [];
    const joined = this.toks.join('');
    if (joined.replace(/\s/g, '') !== src.replace(/\s/g, '')) throw new Error(`bad expression "${src}"`);
  }
  static eval(src: string, sym: (name: string) => number, here: number): number {
    const e = new Expr(src, sym, here);
    const v = e.or();
    if (e.i < e.toks.length) throw new Error(`unexpected "${e.toks[e.i]}" in "${src}"`);
    return v;
  }
  private peek(): string | undefined { return this.toks[this.i]; }
  private or(): number { let v = this.xor(); while (this.peek() === '|') { this.i++; v |= this.xor(); } return v; }
  private xor(): number { let v = this.and(); while (this.peek() === '^') { this.i++; v ^= this.and(); } return v; }
  private and(): number { let v = this.shift(); while (this.peek() === '&') { this.i++; v &= this.shift(); } return v; }
  private shift(): number {
    let v = this.sum();
    for (let t = this.peek(); t === '<<' || t === '>>'; t = this.peek()) { this.i++; const r = this.sum(); v = t === '<<' ? v << r : v >> r; }
    return v;
  }
  private sum(): number {
    let v = this.prod();
    for (let t = this.peek(); t === '+' || t === '-'; t = this.peek()) { this.i++; const r = this.prod(); v = t === '+' ? v + r : v - r; }
    return v;
  }
  private prod(): number {
    let v = this.unary();
    for (let t = this.peek(); t === '*' || t === '/' || t === '%'; t = this.peek()) {
      this.i++;
      const r = this.unary();
      v = t === '*' ? v * r : t === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  }
  private unary(): number {
    const t = this.peek();
    if (t === '-') { this.i++; return -this.unary(); }
    if (t === '+') { this.i++; return this.unary(); }
    if (t === '~') { this.i++; return ~this.unary(); }
    return this.atom();
  }
  private atom(): number {
    const t = this.toks[this.i++];
    if (t === undefined) throw new Error('expression ends too soon');
    if (t === '(') { const v = this.or(); if (this.toks[this.i++] !== ')') throw new Error('missing )'); return v; }
    if (t === '$') return this.here;
    if (/^'.+'$/.test(t)) return t.slice(1, -1).replace(/^\\/, '').charCodeAt(0);
    if (/^&h/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^\$/.test(t)) return parseInt(t.slice(1), 16);
    if (/^%/.test(t)) return parseInt(t.slice(1), 2);
    if (/^0x/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^[0-9][0-9a-f]*h$/i.test(t)) return parseInt(t.slice(0, -1), 16);
    if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
    return this.sym(t.toLowerCase());
  }
}

// ---- the assembler -----------------------------------------------------------

export function assemble(source: string): AsmResult {
  const symbols = new Map<string, number>();
  let result: AsmResult | null = null;
  // Pass 1 sizes everything with unknown symbols as 0; pass 2 has them all.
  for (const pass of [1, 2]) {
    let pc = 0;
    let origin = -1;
    const out: number[] = [];
    const lines = source.split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const lineNo = n + 1;
      try {
        let text = stripComment(lines[n]).replace(/\s+$/, '');
        if (!text.trim()) continue;
        // A label: "name:" anywhere at the start, or a bare word at column 0.
        let label: string | null = null;
        const lm = /^\s*([a-z_.?@][\w.?@]*):/i.exec(text) ?? /^([a-z_.?@][\w.?@]*)(?=\s|$)/i.exec(text);
        if (lm && !(lm[1].toLowerCase() in SIMPLE) && !isMnemonic(lm[1]) ) {
          label = lm[1].toLowerCase();
          text = text.slice(lm[0].length);
        }
        const m = /^\s*([a-z]+)\s*(.*)$/i.exec(text);
        const mnem = m?.[1].toLowerCase() ?? '';
        const rest = m?.[2] ?? '';
        const sym = (name: string) => {
          const v = symbols.get(name);
          if (v === undefined) {
            if (pass === 2) throw new Error(`unknown symbol "${name}"`);
            return 0;
          }
          return v;
        };
        const ev = (e: string) => Expr.eval(e, sym, pc);
        if (mnem === 'equ') {
          if (!label) throw new Error('EQU needs a name');
          symbols.set(label, ev(rest));
          continue;
        }
        if (label) {
          if (pass === 1 && symbols.has(label)) throw new Error(`"${label}" defined twice`);
          symbols.set(label, pc);
        }
        if (!mnem) continue;
        if (mnem === 'org') {
          const at = ev(rest);
          if (origin < 0) origin = at;
          else while (pc < at) { out.push(0xff); pc++; }
          pc = at;
          continue;
        }
        if (origin < 0) origin = 0;
        const bytes = encode(mnem, splitOperands(rest), ev, pc, pass === 2);
        for (const b of bytes) out.push(b & 0xff);
        pc += bytes.length;
      } catch (e) {
        if (e instanceof AsmError) throw e;
        throw new AsmError(lineNo, (e as Error).message);
      }
    }
    result = { bytes: Uint8Array.from(out), origin: Math.max(0, origin), symbols };
  }
  return result!;
}

const MNEMONICS = new Set([
  ...Object.keys(SIMPLE), ...Object.keys(ALU), ...Object.keys(ROT),
  'ld', 'push', 'pop', 'ex', 'inc', 'dec', 'bit', 'set', 'res', 'jp', 'jr', 'djnz', 'call', 'ret', 'rst',
  'in', 'out', 'im', 'db', 'dw', 'ds', 'defb', 'defw', 'defs', 'defm', 'org', 'equ',
]);
const isMnemonic = (w: string) => MNEMONICS.has(w.toLowerCase());

/** Encodes one line; `check` is off in pass 1, where forward symbols still read 0. */
function encode(mnem: string, ops: string[], ev: (e: string) => number, pc: number, check: boolean): number[] {
  const n8 = (e: string) => { const v = ev(e); if (check && (v < -128 || v > 255)) throw new Error(`${v} does not fit a byte`); return v & 0xff; };
  const n16 = (e: string) => { const v = ev(e); return [v & 0xff, (v >> 8) & 0xff]; };
  const disp = (e: string) => { const v = ev(e); if (check && (v < -128 || v > 127)) throw new Error(`index ${v} out of range`); return v & 0xff; };
  const rel = (e: string) => {
    const off = ev(e) - (pc + 2);
    if (check && (off < -128 || off > 127)) throw new Error(`jump of ${off} out of range`);
    return off & 0xff;
  };
  const bad = () => new Error(`cannot ${mnem.toUpperCase()} ${ops.join(',')}`);
  const O = ops.map(classify);
  const [a, b] = O;
  /** IX/IY prefix and the HL-slot code for a 16-bit register name. */
  const ixy = (name: string) => (name === 'ix' ? 0xdd : name === 'iy' ? 0xfd : 0);

  if (mnem in SIMPLE && ops.length === 0) return SIMPLE[mnem];

  switch (mnem) {
    case 'db': case 'defb': case 'defm': {
      const out: number[] = [];
      for (const o of ops) {
        if (/^".*"$/.test(o) || (/^'.*'$/.test(o) && o.length > 3)) for (const ch of o.slice(1, -1)) out.push(ch.charCodeAt(0) & 0xff);
        else out.push(n8(o));
      }
      return out;
    }
    case 'dw': case 'defw': return ops.flatMap((o) => n16(o));
    case 'ds': case 'defs': return new Array(ev(ops[0])).fill(ops[1] ? n8(ops[1]) : 0);

    case 'ld': {
      if (!a || !b) throw bad();
      // 8-bit
      if (a.k === 'r8' && b.k === 'r8') { if (a.r === 6 && b.r === 6) throw bad(); return [0x40 | (a.r << 3) | b.r]; }
      if (a.k === 'r8' && b.k === 'idx') { if (a.r === 6) throw bad(); return [b.p, 0x46 | (a.r << 3), disp(b.d)]; }
      if (a.k === 'idx' && b.k === 'r8') { if (b.r === 6) throw bad(); return [a.p, 0x70 | b.r, disp(a.d)]; }
      if (a.k === 'idx' && b.k === 'imm') return [a.p, 0x36, disp(a.d), n8(b.e)];
      if (a.k === 'r8' && b.k === 'imm') return [0x06 | (a.r << 3), n8(b.e)];
      if (a.k === 'r8' && a.r === 7 && b.k === 'ind16' && (b.name === 'bc' || b.name === 'de')) return [b.name === 'bc' ? 0x0a : 0x1a];
      if (a.k === 'ind16' && (a.name === 'bc' || a.name === 'de') && b.k === 'r8' && b.r === 7) return [a.name === 'bc' ? 0x02 : 0x12];
      if (a.k === 'r8' && a.r === 7 && b.k === 'mem') return [0x3a, ...n16(b.e)];
      if (a.k === 'mem' && b.k === 'r8' && b.r === 7) return [0x32, ...n16(a.e)];
      if (a.k === 'r8' && a.r === 7 && b.k === 'name' && b.name === 'i') return [0xed, 0x57];
      if (a.k === 'r8' && a.r === 7 && b.k === 'name' && b.name === 'r') return [0xed, 0x5f];
      if (a.k === 'name' && a.name === 'i' && b.k === 'r8' && b.r === 7) return [0xed, 0x47];
      if (a.k === 'name' && a.name === 'r' && b.k === 'r8' && b.r === 7) return [0xed, 0x4f];
      // 16-bit
      if (a.k === 'r16' && b.k === 'imm') {
        const p = ixy(a.name);
        if (p) return [p, 0x21, ...n16(b.e)];
        if (!(a.name in R16)) throw bad();
        return [0x01 | (R16[a.name] << 4), ...n16(b.e)];
      }
      if (a.k === 'r16' && b.k === 'mem') {
        const p = ixy(a.name);
        if (p) return [p, 0x2a, ...n16(b.e)];
        if (a.name === 'hl') return [0x2a, ...n16(b.e)];
        if (!(a.name in R16)) throw bad();
        return [0xed, 0x4b | (R16[a.name] << 4), ...n16(b.e)];
      }
      if (a.k === 'mem' && b.k === 'r16') {
        const p = ixy(b.name);
        if (p) return [p, 0x22, ...n16(a.e)];
        if (b.name === 'hl') return [0x22, ...n16(a.e)];
        if (!(b.name in R16)) throw bad();
        return [0xed, 0x43 | (R16[b.name] << 4), ...n16(a.e)];
      }
      if (a.k === 'r16' && a.name === 'sp' && b.k === 'r16') {
        if (b.name === 'hl') return [0xf9];
        const p = ixy(b.name);
        if (p) return [p, 0xf9];
      }
      throw bad();
    }

    case 'push': case 'pop': {
      if (a?.k !== 'r16') throw bad();
      const base = mnem === 'push' ? 0xc5 : 0xc1;
      const p = ixy(a.name);
      if (p) return [p, base | 0x20];
      if (!(a.name in R16AF)) throw bad();
      return [base | (R16AF[a.name] << 4)];
    }

    case 'ex': {
      const l = ops.join(',').toLowerCase().replace(/\s+/g, '');
      if (l === 'de,hl') return [0xeb];
      if (l === "af,af'") return [0x08];
      if (l === '(sp),hl') return [0xe3];
      if (l === '(sp),ix') return [0xdd, 0xe3];
      if (l === '(sp),iy') return [0xfd, 0xe3];
      throw bad();
    }

    case 'inc': case 'dec': {
      const dec = mnem === 'dec' ? 1 : 0;
      if (a?.k === 'r8') return [0x04 | (a.r << 3) | dec];
      if (a?.k === 'idx') return [a.p, 0x34 | dec, disp(a.d)];
      if (a?.k === 'r16') {
        const p = ixy(a.name);
        if (p) return [p, dec ? 0x2b : 0x23];
        if (a.name in R16) return [(dec ? 0x0b : 0x03) | (R16[a.name] << 4)];
      }
      throw bad();
    }

    case 'add': case 'adc': case 'sub': case 'sbc': case 'and': case 'xor': case 'or': case 'cp': {
      // 16-bit ADD/ADC/SBC
      if (O.length === 2 && a.k === 'r16' && b.k === 'r16') {
        const p = ixy(a.name);
        const src = (n: string) => (n === a.name && p ? 2 : R16[n]);
        if (mnem === 'add' && (a.name === 'hl' || p)) {
          if (!(b.name in R16) && b.name !== a.name) throw bad();
          if (p && b.name === 'hl') throw bad();
          return [...(p ? [p] : []), 0x09 | (src(b.name) << 4)];
        }
        if (a.name === 'hl' && b.name in R16 && (mnem === 'adc' || mnem === 'sbc')) {
          return [0xed, (mnem === 'adc' ? 0x4a : 0x42) | (R16[b.name] << 4)];
        }
        throw bad();
      }
      // 8-bit: "op A,x" or "op x"
      let src = b ?? a;
      if (b) { if (!(a.k === 'r8' && a.r === 7)) throw bad(); src = b; }
      const code = ALU[mnem];
      if (src.k === 'r8') return [0x80 | (code << 3) | src.r];
      if (src.k === 'idx') return [src.p, 0x86 | (code << 3), disp(src.d)];
      if (src.k === 'imm') return [0xc6 | (code << 3), n8(src.e)];
      throw bad();
    }

    case 'rlc': case 'rrc': case 'rl': case 'rr': case 'sla': case 'sra': case 'sll': case 'srl': {
      const code = ROT[mnem] << 3;
      if (a?.k === 'r8') return [0xcb, code | a.r];
      if (a?.k === 'idx') return [a.p, 0xcb, disp(a.d), code | 6];
      throw bad();
    }

    case 'bit': case 'set': case 'res': {
      const bit = ev(ops[0]);
      if (bit < 0 || bit > 7) throw bad();
      const base = mnem === 'bit' ? 0x40 : mnem === 'res' ? 0x80 : 0xc0;
      if (b?.k === 'r8') return [0xcb, base | (bit << 3) | b.r];
      if (b?.k === 'idx') return [b.p, 0xcb, disp(b.d), base | (bit << 3) | 6];
      throw bad();
    }

    case 'jp': {
      if (O.length === 1) {
        if (a.k === 'r8' && a.r === 6) return [0xe9];
        if (a.k === 'ind16' && (a.name === 'ix' || a.name === 'iy')) return [ixy(a.name), 0xe9];
        if (a.k === 'imm') return [0xc3, ...n16(a.e)];
      }
      const cc = CC[ops[0]?.toLowerCase()];
      if (O.length === 2 && cc !== undefined && b.k === 'imm') return [0xc2 | (cc << 3), ...n16(b.e)];
      throw bad();
    }
    case 'jr': {
      if (O.length === 1 && a.k === 'imm') return [0x18, rel(a.e)];
      const cc = CC[ops[0]?.toLowerCase()];
      if (O.length === 2 && cc !== undefined && cc < 4) return [0x20 | (cc << 3), rel(ops[1])];
      throw bad();
    }
    case 'djnz': return [0x10, rel(ops[0])];
    case 'call': {
      if (O.length === 1 && a.k === 'imm') return [0xcd, ...n16(a.e)];
      const cc = CC[ops[0]?.toLowerCase()];
      if (O.length === 2 && cc !== undefined) return [0xc4 | (cc << 3), ...n16(ops[1])];
      throw bad();
    }
    case 'ret': {
      if (O.length === 0) return [0xc9];
      const cc = CC[ops[0].toLowerCase()];
      if (cc !== undefined) return [0xc0 | (cc << 3)];
      throw bad();
    }
    case 'rst': {
      const v = ev(ops[0]);
      if (v & ~0x38) throw bad();
      return [0xc7 | v];
    }

    case 'in': {
      if (a?.k === 'r8' && a.r === 7 && b?.k === 'mem') return [0xdb, n8(b.e)];
      if (a?.k === 'r8' && a.r !== 6 && b?.k === 'ind16' && b.name === 'c') return [0xed, 0x40 | (a.r << 3)];
      throw bad();
    }
    case 'out': {
      if (a?.k === 'mem' && b?.k === 'r8' && b.r === 7) return [0xd3, n8(a.e)];
      if (a?.k === 'ind16' && a.name === 'c' && b?.k === 'r8' && b.r !== 6) return [0xed, 0x41 | (b.r << 3)];
      throw bad();
    }
    case 'im': {
      const v = ev(ops[0]);
      return [0xed, [0x46, 0x56, 0x5e][v] ?? (() => { throw bad(); })()];
    }
  }
  throw new Error(`unknown instruction ${mnem.toUpperCase()}`);
}
