/**
 * An MSX keyboard on the page, for touch screens and for seeing the
 * layout, like K-Prompt's Spectrum keyboard. Its legends come from the key
 * table of the BIOS in use (keyboard.ts), so it shows that machine's own
 * keys: the international layout on C-BIOS, ç on its own key and the CODE
 * accents on a Gradiente Expert 1.1, the Hotbit's layout on a Hotbit.
 *
 * A key is down while it is held, so games can be played on it. SHIFT,
 * CTRL, GRAPH and CODE stay down (latched) until the next key, so one
 * finger can type a shifted key.
 */
import type { KeyTable } from '../msx/keyboard';

type Pos = [row: number, bit: number];

interface Key {
  pos: Pos;
  /** A fixed label; character keys take theirs from the key table. */
  label?: string;
  /** Width in key units. */
  w?: number;
  modifier?: boolean;
  cls?: string;
}

/** The matrix position of a letter (rows 2-5, A at row 2 bit 6). */
const letter = (ch: string): Pos => {
  const i = ch.charCodeAt(0) - 65;
  if (i < 2) return [2, 6 + i];
  if (i < 10) return [3, i - 2];
  if (i < 18) return [4, i - 10];
  return [5, i - 18];
};
const chars = (s: string) => [...s].map((ch): Key => ({ pos: letter(ch) }));

/** The rows of an MSX keyboard (international arrangement). */
const LAYOUT: Key[][] = [
  [
    { pos: [6, 5], label: 'F1', cls: 'fn' }, { pos: [6, 6], label: 'F2', cls: 'fn' }, { pos: [6, 7], label: 'F3', cls: 'fn' },
    { pos: [7, 0], label: 'F4', cls: 'fn' }, { pos: [7, 1], label: 'F5', cls: 'fn' },
    { pos: [7, 6], label: 'SELECT', cls: 'fn', w: 1.3 }, { pos: [7, 4], label: 'STOP', cls: 'fn stop', w: 1.3 },
    { pos: [8, 1], label: 'HOME', cls: 'fn' }, { pos: [8, 2], label: 'INS', cls: 'fn' }, { pos: [8, 3], label: 'DEL', cls: 'fn' },
  ],
  [
    { pos: [7, 2], label: 'ESC' },
    ...[1, 2, 3, 4, 5, 6, 7].map((n): Key => ({ pos: [0, n] })),
    { pos: [1, 0] }, { pos: [1, 1] }, { pos: [0, 0] },
    { pos: [1, 2] }, { pos: [1, 3] }, { pos: [1, 4] },
    { pos: [7, 5], label: 'BS', w: 1.3 },
  ],
  [
    { pos: [7, 3], label: 'TAB', w: 1.5 },
    ...chars('QWERTYUIOP'),
    { pos: [1, 5] }, { pos: [1, 6] },
    { pos: [7, 7], label: 'RETURN', w: 1.8 },
  ],
  [
    { pos: [6, 1], label: 'CTRL', w: 1.8, modifier: true },
    ...chars('ASDFGHJKL'),
    { pos: [1, 7] }, { pos: [2, 0] }, { pos: [2, 1] },
    { pos: [7, 7], label: '↵', w: 1.5 },
  ],
  [
    { pos: [6, 0], label: 'SHIFT', w: 2.2, modifier: true },
    ...chars('ZXCVBNM'),
    { pos: [2, 2] }, { pos: [2, 3] }, { pos: [2, 4] }, { pos: [2, 5] },
    { pos: [6, 0], label: 'SHIFT', w: 2.1, modifier: true },
  ],
  [
    { pos: [6, 3], label: 'CAPS', w: 1.3 },
    { pos: [6, 2], label: 'GRAPH', w: 1.3, modifier: true },
    { pos: [8, 0], label: '', w: 6.5, cls: 'space' },
    { pos: [6, 4], label: 'CODE', w: 1.3, modifier: true },
    { pos: [8, 4], label: '←', cls: 'arrow' }, { pos: [8, 5], label: '↑', cls: 'arrow' },
    { pos: [8, 6], label: '↓', cls: 'arrow' }, { pos: [8, 7], label: '→', cls: 'arrow' },
  ],
];

/** International legends when the BIOS has no key table to read. */
const FALLBACK: Record<string, [string, string]> = {
  '0,0': ['0', ')'], '0,1': ['1', '!'], '0,2': ['2', '@'], '0,3': ['3', '#'], '0,4': ['4', '$'], '0,5': ['5', '%'],
  '0,6': ['6', '^'], '0,7': ['7', '&'], '1,0': ['8', '*'], '1,1': ['9', '('], '1,2': ['-', '_'], '1,3': ['=', '+'],
  '1,4': ['\\', '|'], '1,5': ['[', '{'], '1,6': [']', '}'], '1,7': [';', ':'], '2,0': ["'", '"'], '2,1': ['`', '~'],
  '2,2': [',', '<'], '2,3': ['.', '>'], '2,4': ['/', '?'], '2,5': ['', ''],
};

/** Shortest time a tap holds a key: the BIOS does not scan every interrupt. */
const MIN_HOLD_MS = 120;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export interface KeyboardDeps {
  key(row: number, bit: number, down: boolean): void;
  /** Whether the MSX is on (keys do nothing before). */
  running(): boolean;
}

export class MsxKeyboard {
  private latched = new Map<string, Pos>();
  /** Keys held by pointer id, with when they went down. */
  private held = new Map<number, { pos: Pos; mods: Pos[]; at: number; el: HTMLElement }>();

  constructor(private readonly root: HTMLElement, private readonly deps: KeyboardDeps) {
    root.addEventListener('pointerdown', (e) => this.down(e));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      root.addEventListener(t, (e) => this.up(e), true);
    }
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Draws the keys with the legends of `table` (null: the international ones). */
  draw(table: KeyTable | null): void {
    this.root.replaceChildren(...LAYOUT.map((row) => {
      const r = document.createElement('div');
      r.className = 'kbd-row';
      for (const k of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `kbd-key ${k.cls ?? ''}${k.modifier ? ' mod' : ''}`;
        b.dataset.pos = k.pos.join(',');
        b.style.flexGrow = String(k.w ?? 1);
        if (k.label !== undefined) {
          b.innerHTML = `<span class="main">${esc(k.label)}</span>`;
          b.setAttribute('aria-label', k.label || 'SPACE');
        } else {
          const [row, bit] = k.pos;
          const l = table?.legend(row, bit);
          const plain = l ? l.plain : FALLBACK[`${row},${bit}`]?.[0] ?? '';
          const shift = l ? l.shift : FALLBACK[`${row},${bit}`]?.[1] ?? '';
          const code = l?.code && !/^[\x20-\x7e]$/.test(l.code) ? l.code : '';
          const isLetter = /^[a-z]$/i.test(plain);
          b.innerHTML = isLetter
            ? `<span class="main">${esc(plain.toUpperCase())}</span><span class="code">${esc(code)}</span>`
            : `<span class="shift">${esc(shift === plain ? '' : shift)}</span><span class="main">${esc(plain)}</span><span class="code">${esc(code)}</span>`;
          b.setAttribute('aria-label', plain || 'dead key');
        }
        r.append(b);
      }
      return r;
    }));
    this.showLatched();
  }

  private down(e: PointerEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.kbd-key');
    if (!b || !this.deps.running()) return;
    e.preventDefault();
    const pos = b.dataset.pos!.split(',').map(Number) as Pos;
    if (b.classList.contains('mod')) {
      const id = pos.join(',');
      if (this.latched.has(id)) this.latched.delete(id);
      else this.latched.set(id, pos);
      this.showLatched();
      return;
    }
    const mods = [...this.latched.values()];
    for (const m of mods) this.deps.key(m[0], m[1], true);
    this.deps.key(pos[0], pos[1], true);
    b.classList.add('down');
    b.setPointerCapture?.(e.pointerId);
    this.held.set(e.pointerId, { pos, mods, at: performance.now(), el: b });
    this.latched.clear();
    this.showLatched();
  }

  private up(e: PointerEvent): void {
    const h = this.held.get(e.pointerId);
    if (!h) return;
    this.held.delete(e.pointerId);
    const release = () => {
      this.deps.key(h.pos[0], h.pos[1], false);
      for (const m of h.mods) this.deps.key(m[0], m[1], false);
      h.el.classList.remove('down');
    };
    const left = MIN_HOLD_MS - (performance.now() - h.at);
    if (left > 0) setTimeout(release, left);
    else release();
  }

  private showLatched(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('.kbd-key.mod')) {
      b.classList.toggle('latched', this.latched.has(b.dataset.pos!));
    }
  }
}
