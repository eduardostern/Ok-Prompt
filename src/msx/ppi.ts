/**
 * The 8255 PPI at I/O A8h-ABh:
 *
 * - A8h, port A: the primary slot register (see slots.ts).
 * - A9h, port B (read): the keyboard row picked in port C; a 0 bit is a key
 *   held down.
 * - AAh, port C: bits 0-3 keyboard row, bit 4 cassette motor (0 = on),
 *   bit 5 cassette out, bit 6 CAPS lamp (0 = lit), bit 7 key click.
 * - ABh: control; with bit 7 clear it sets or resets one bit of port C.
 */
import type { Slots } from './slots';

export class Ppi {
  /** Eleven keyboard rows; bit clear = key down. */
  readonly rows = new Uint8Array(11).fill(0xff);
  portC = 0x70;
  /** Called when the key-click bit changes (the 1-bit sound). */
  onClick?: (level: number) => void;

  constructor(private slots: Slots) {}

  reset(): void {
    this.slots.primary = 0;
    this.portC = 0x70;
    this.rows.fill(0xff);
  }

  get capsLamp(): boolean {
    return (this.portC & 0x40) === 0;
  }

  in(port: number): number {
    switch (port & 3) {
      case 0: return this.slots.primary;
      case 1: {
        const row = this.portC & 0x0f;
        return row < this.rows.length ? this.rows[row] : 0xff;
      }
      case 2: return this.portC;
      default: return 0xff;
    }
  }

  out(port: number, value: number): void {
    switch (port & 3) {
      case 0: this.slots.primary = value; break;
      case 2: this.setC(value); break;
      case 3:
        if (!(value & 0x80)) {
          const bit = (value >> 1) & 7;
          this.setC(value & 1 ? this.portC | (1 << bit) : this.portC & ~(1 << bit));
        }
        break;
    }
  }

  private setC(value: number): void {
    const clicked = (value ^ this.portC) & 0x80;
    this.portC = value & 0xff;
    if (clicked) this.onClick?.(value >> 7);
  }

  /** Presses (down) or releases a key at matrix `row`, `bit`. */
  key(row: number, bit: number, down: boolean): void {
    if (down) this.rows[row] &= ~(1 << bit);
    else this.rows[row] |= 1 << bit;
  }
}
