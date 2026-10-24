/**
 * The MSX international keyboard matrix, from the PC keyboard's physical
 * keys (KeyboardEvent.code), so the MSX does its own shifting just as the
 * real one did. Row and bit as the PPI reads them.
 *
 *   row 0  0 1 2 3 4 5 6 7
 *   row 1  8 9 - = \ [ ] ;
 *   row 2  ' ` , . / (dead) A B
 *   row 3  C D E F G H I J
 *   row 4  K L M N O P Q R
 *   row 5  S T U V W X Y Z
 *   row 6  SHIFT CTRL GRAPH CAPS CODE F1 F2 F3
 *   row 7  F4 F5 ESC TAB STOP BS SELECT RETURN
 *   row 8  SPACE HOME INS DEL LEFT UP DOWN RIGHT
 *
 * Keys the PC lacks: GRAPH = left Alt, CODE = right Alt, STOP = F7,
 * SELECT = F8.
 */

const MAP: Record<string, [number, number]> = {};
const row = (r: number, codes: string[]) => codes.forEach((c, bit) => { if (c) MAP[c] = [r, bit]; });

row(0, ['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7']);
row(1, ['Digit8', 'Digit9', 'Minus', 'Equal', 'Backslash', 'BracketLeft', 'BracketRight', 'Semicolon']);
row(2, ['Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash', 'KeyA', 'KeyB']);
row(3, ['KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ']);
row(4, ['KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR']);
row(5, ['KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ']);
row(6, ['ShiftLeft', 'ControlLeft', 'AltLeft', 'CapsLock', 'AltRight', 'F1', 'F2', 'F3']);
row(7, ['F4', 'F5', 'Escape', 'Tab', 'F7', 'Backspace', 'F8', 'Enter']);
row(8, ['Space', 'Home', 'Insert', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']);
MAP.ShiftRight = [6, 0];
MAP.ControlRight = [6, 1];
MAP.NumpadEnter = [7, 7];

/** The matrix position of a PC key, or undefined if the MSX has no such key. */
export function msxKey(code: string): [number, number] | undefined {
  return MAP[code];
}

/** The PC keys for the MSX-only ones, for the help panel. */
export const SPECIAL_KEYS: [string, string][] = [
  ['GRAPH', 'Left Alt'],
  ['CODE', 'Right Alt'],
  ['STOP', 'F7'],
  ['SELECT', 'F8'],
  ['F6-F10', 'Shift + F1-F5'],
];

// ---- typing by character ----------------------------------------------------
//
// MSX machines differ in what is printed on the keys (the Gradiente Expert's
// Brazilian keyboard, the Hotbit's, European ones), but each BIOS holds a
// table of what character every matrix key gives: six tables of 48 bytes
// (rows 0-5) for plain, SHIFT, GRAPH, GRAPH+SHIFT, CODE and CODE+SHIFT.
// Reading it from the BIOS in use lets a PC key type the character printed
// on the PC key, whatever the MSX layout: the PC's ç becomes the key and
// modifiers that give ç on that MSX.

/** MSX character codes 80h-BFh (the international set; Brazilian letters at B0h). */
const HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»ÃãĨĩÕõŨũĲĳ¾∽◇‰¶§';

/** The MSX character code of `ch` in the international set, or -1. */
export function msxCode(ch: string): number {
  const c = ch.codePointAt(0) ?? -1;
  if (ch.length === 1 && c >= 0x20 && c < 0x7f) return c;
  const i = HIGH.indexOf(ch);
  return i < 0 ? -1 : 0x80 + i;
}

/**
 * Character sets met in BIOS ROMs. The Gradiente Expert 1.0 has an early
 * Brazilian one: ç and Ç on 60h and 7Eh (where ` and ~ were, which moved to
 * 87h and 80h), and the tilde letters on the umlaut ones (ã on ä at 84h,
 * õ on ö, Ã on Ä, Õ on Ö, ũ ü, Ũ Ü, ĩ ï, ẽ ë, ỹ ÿ). The Expert 1.1 and later
 * went back to the international set.
 */
export type Charset = 'international' | 'brazil-1.0';

const BRAZIL_10: Record<string, number[]> = {
  ç: [0x60], Ç: [0x7e], '`': [0x87], '~': [0x80],
  ã: [0x84, 0xb1], õ: [0x94, 0xb5], Ã: [0x8e, 0xb0], Õ: [0x99, 0xb4],
  ũ: [0x81, 0xb7], Ũ: [0x9a, 0xb6], ĩ: [0x8b, 0xb3], ẽ: [0x89], ỹ: [0x98],
  ä: [], ö: [], Ä: [], Ö: [], ü: [], Ü: [], ï: [], ë: [], ÿ: [],
};

/** The character set of a BIOS, told by its font: the 1.0 set draws a tilde over 84h. */
export function detectCharset(rom: Uint8Array): Charset {
  const font = rom[4] | (rom[5] << 8); // CGTABL
  const g = font + 0x84 * 8;
  return g + 8 <= rom.length && rom[g] === 0x50 && rom[g + 1] === 0xa0 ? 'brazil-1.0' : 'international';
}

/** The codes that may stand for `ch` in a character set, best first. */
export function msxCodes(ch: string, charset: Charset = 'international'): number[] {
  if (charset === 'brazil-1.0' && ch in BRAZIL_10) return BRAZIL_10[ch];
  const c = msxCode(ch);
  return c < 0 ? [] : [c];
}

/** A matrix key and the modifiers held with it. */
export interface Combo { row: number; bit: number; shift: boolean; graph: boolean; code: boolean }

const TABLE_MODS: [shift: boolean, graph: boolean, code: boolean][] = [
  [false, false, false], [true, false, false], [false, true, false],
  [true, true, false], [false, false, true], [true, false, true],
];
/** Which table wins when a character is in several: plain, shift, code, then graph. */
const PREFERENCE = [0, 1, 4, 5, 2, 3];

export class KeyTable {
  private byCode = new Map<number, Combo>();

  constructor(tables: Uint8Array, readonly charset: Charset = 'international') {
    for (const t of PREFERENCE) {
      const [shift, graph, code] = TABLE_MODS[t];
      for (let k = 0; k < 48; k++) {
        const v = tables[t * 48 + k];
        if (v === undefined || v === 0 || this.byCode.has(v)) continue;
        this.byCode.set(v, { row: k >> 3, bit: k & 7, shift, graph, code });
      }
    }
  }

  /** Finds the key tables in a BIOS ROM: "0123456789" opening the plain one, a/A where row 2 ends. */
  static find(rom: Uint8Array): KeyTable | null {
    const sig = [...'0123456789'].map((c) => c.charCodeAt(0));
    for (let i = 0; i + 96 <= rom.length; i++) {
      if (!sig.every((b, j) => rom[i + j] === b)) continue;
      if (rom[i + 22] !== 0x61 || rom[i + 48 + 22] !== 0x41) continue; // 'a' plain, 'A' shifted
      return new KeyTable(rom.subarray(i, Math.min(rom.length, i + 6 * 48)), detectCharset(rom));
    }
    return null;
  }

  /** The code this BIOS types for `ch`, or -1 if no key gives it. */
  codeFor(ch: string): number {
    return msxCodes(ch, this.charset).find((c) => this.byCode.has(c)) ?? -1;
  }

  lookup(ch: string): Combo | null {
    const c = this.codeFor(ch);
    return c < 0 ? null : this.byCode.get(c)!;
  }
}

const SHIFT: [number, number] = [6, 0];
const GRAPH: [number, number] = [6, 2];
const CODE: [number, number] = [6, 4];

/**
 * The PC keyboard driving the MSX matrix. Keys that type a character other
 * than a letter go through the BIOS's key table (when `table` is set);
 * letters, digits' positions for games, arrows, Enter, function keys and the
 * modifiers keep their places in the matrix, so games and the MSX's own
 * SHIFT and CAPS behave as on the real machine.
 */
export class KeyInput {
  /** The BIOS's key table; null types by position only. */
  table: KeyTable | null = null;
  private held = new Map<string, Combo | [number, number]>();
  /** PC modifier keys down, as the MSX should see them without a character key. */
  private phys = { shift: 0, graph: 0, code: 0 };
  /** The character key whose modifiers are in force. */
  private active: Combo | null = null;

  constructor(private readonly ppi: { key(row: number, bit: number, down: boolean): void }) {}

  /** A PC key went down. Returns whether the MSX uses it. */
  down(code: string, key: string, ctrl = false, alt = false): boolean {
    if (this.held.has(code)) return true; // auto-repeat: the MSX repeats by itself
    if (key === 'Dead') return true; // the accent comes with the next key
    const combo = this.table && !ctrl && !alt && !/^Key[A-Z]$/.test(code) && !code.startsWith('Numpad')
      ? this.table.lookup(key) : null;
    if (combo && key !== ' ') {
      this.held.set(code, combo);
      this.ppi.key(combo.row, combo.bit, true);
      this.active = combo;
      this.applyModifiers();
      return true;
    }
    const pos = msxKey(code);
    if (!pos) return false;
    this.held.set(code, pos);
    this.modifier(pos, 1);
    this.ppi.key(pos[0], pos[1], true);
    this.applyModifiers();
    return true;
  }

  /** A PC key came up. */
  up(code: string): boolean {
    const h = this.held.get(code);
    if (!h) return false;
    this.held.delete(code);
    if (Array.isArray(h)) {
      this.modifier(h, -1);
      this.ppi.key(h[0], h[1], false);
    } else {
      this.ppi.key(h.row, h.bit, false);
      if (this.active === h) {
        this.active = null;
        for (const o of this.held.values()) if (!Array.isArray(o)) this.active = o;
      }
    }
    this.applyModifiers();
    return true;
  }

  /** Lets go of everything (the window lost focus). */
  releaseAll(): void {
    for (const code of [...this.held.keys()]) this.up(code);
    this.phys = { shift: 0, graph: 0, code: 0 };
    this.active = null;
  }

  private modifier(pos: [number, number], d: number): void {
    if (pos[0] !== 6) return;
    if (pos[1] === SHIFT[1]) this.phys.shift += d;
    else if (pos[1] === GRAPH[1]) this.phys.graph += d;
    else if (pos[1] === CODE[1]) this.phys.code += d;
  }

  /** SHIFT, GRAPH and CODE as the active character needs them, else as held. */
  private applyModifiers(): void {
    const a = this.active;
    const set = (pos: [number, number], on: boolean) => this.ppi.key(pos[0], pos[1], on);
    set(SHIFT, a ? a.shift : this.phys.shift > 0);
    set(GRAPH, a ? a.graph : this.phys.graph > 0);
    set(CODE, a ? a.code : this.phys.code > 0);
  }
}
