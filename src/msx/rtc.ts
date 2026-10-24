/**
 * The RP5C01 real-time clock of the MSX2, on I/O B4h (register number) and
 * B5h (data, 4 bits; reads give the nibble with the high bits set). Four
 * blocks of 13 registers, picked by the mode register (0Dh, bits 0-1):
 *
 *   block 0  the time: seconds, minutes, hours, day of week, day, month,
 *            year, one BCD digit per register (from the host's clock)
 *   block 1  alarm, the 12/24-hour switch (0Ah) and the leap-year count
 *   block 2  RAM: the BIOS keeps its settings here (screen, width, colours)
 *   block 3  RAM: the boot title or password
 *
 * Writes to the time are kept as an offset from the host's clock. The RAM
 * blocks survive power-off on a real MSX (battery); `onRamChange` lets the
 * page keep them.
 */
export class Rtc {
  private reg = 0;
  private mode = 0;
  /** Blocks 1-3 (13 nibbles each), and block 0 as last written. */
  readonly blocks = [new Uint8Array(13), new Uint8Array(13), new Uint8Array(13), new Uint8Array(13)];
  /** Milliseconds added to the host clock (from writes to the time). */
  private offset = 0;
  onRamChange?: (ram: Uint8Array) => void;

  constructor(readonly now: () => Date = () => new Date()) {
    this.blocks[1][0x0a] = 1; // 24-hour clock
  }

  /** Blocks 2 and 3, 26 nibbles, for saving. */
  get ram(): Uint8Array {
    const r = new Uint8Array(26);
    r.set(this.blocks[2], 0);
    r.set(this.blocks[3], 13);
    return r;
  }

  loadRam(ram: Uint8Array): void {
    this.blocks[2].set(ram.subarray(0, 13));
    this.blocks[3].set(ram.subarray(13, 26));
  }

  select(value: number): void {
    this.reg = value & 0x0f;
  }

  read(): number {
    return 0xf0 | this.nibble(this.reg);
  }

  write(value: number): void {
    const v = value & 0x0f;
    const r = this.reg;
    if (r === 0x0d) { this.mode = v; return; }
    if (r > 0x0d) return; // test and reset registers
    const block = this.mode & 3;
    if (block === 0) {
      // Setting the clock: keep the difference from the host's time.
      const digits = this.timeDigits();
      digits[r] = v;
      const t = this.fromDigits(digits);
      if (t) this.offset = t.getTime() - this.now().getTime();
      return;
    }
    this.blocks[block][r] = v;
    if (block >= 2) this.onRamChange?.(this.ram);
  }

  private nibble(r: number): number {
    if (r === 0x0d) return this.mode;
    if (r > 0x0d) return 0;
    const block = this.mode & 3;
    if (block === 0) return this.timeDigits()[r];
    return this.blocks[block][r];
  }

  /** The time as 13 BCD digits (block 0's layout). */
  private timeDigits(): number[] {
    const t = new Date(this.now().getTime() + this.offset);
    const two = (n: number) => [n % 10, Math.floor(n / 10) % 10];
    const year = t.getFullYear() % 100;
    return [
      ...two(t.getSeconds()), ...two(t.getMinutes()), ...two(t.getHours()),
      t.getDay(), ...two(t.getDate()), ...two(t.getMonth() + 1), ...two(year),
    ];
  }

  private fromDigits(d: number[]): Date | null {
    const n = (i: number) => d[i] + d[i + 1] * 10;
    const year = 2000 + n(11);
    const t = new Date(year >= 2080 ? year - 100 : year, n(9) - 1, n(7), n(4), n(2), n(0));
    return Number.isNaN(t.getTime()) ? null : t;
  }
}
