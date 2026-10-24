/**
 * The MSX mouse, in a joystick port. The program drives pin 8 (PSG R15
 * bit 4 for port 1, bit 5 for port 2); at each change the mouse puts the
 * next 4 bits of its movement on pins 1-4 (R14 bits 0-3): X high, X low,
 * Y high, Y low. A change after a pause starts over at X high and takes
 * the movement since the last read. The buttons are the trigger pins
 * (R14 bit 4 left, bit 5 right), low when pressed. Movement right and
 * down counts negative, as the real mouse sends it.
 */

/** A pause longer than this (CPU cycles, about 1 ms) starts a new read. */
const TIMEOUT = 3600;

const enum Phase { XHigh, XLow, YHigh, YLow }

export class Mouse {
  /** Buttons held: bit 0 left, bit 1 right. */
  buttons = 0;
  private curX = 0;
  private curY = 0;
  private x = 0;
  private y = 0;
  private phase = Phase.YLow;
  private pin8 = 0;
  private last = -Infinity;

  /** The host mouse moved (in MSX mouse counts; right and down positive). */
  move(dx: number, dy: number): void {
    this.curX -= dx;
    this.curY -= dy;
  }

  /** Pin 8 set to `level` at CPU cycle `now` (a running count). */
  strobe(level: number, now: number): void {
    if (level === this.pin8) return;
    this.pin8 = level;
    if (now - this.last > TIMEOUT) this.phase = Phase.YLow;
    this.last = now;
    if (this.phase === Phase.YLow) {
      // A new read: take what moved since the last one.
      const clamp = (v: number) => Math.max(-128, Math.min(127, Math.round(v)));
      this.x = clamp(this.curX);
      this.y = clamp(this.curY);
      this.curX -= this.x;
      this.curY -= this.y;
      this.phase = Phase.XHigh;
    } else {
      this.phase++;
    }
  }

  /** The port's six input bits (R14 bits 0-5). */
  read(): number {
    const v = this.phase === Phase.XHigh ? this.x >> 4 : this.phase === Phase.XLow ? this.x
      : this.phase === Phase.YHigh ? this.y >> 4 : this.y;
    const buttons = (this.buttons & 1 ? 0 : 0x10) | (this.buttons & 2 ? 0 : 0x20);
    return buttons | (v & 0x0f);
  }
}
