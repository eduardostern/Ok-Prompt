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
