/**
 * The Konami SCC (051649), the wave-table sound chip inside Konami's SCC
 * cartridges: five channels, each playing a 32-step wave of signed bytes.
 * Channels 4 and 5 share one wave.
 *
 * It shows up at 9800h-9FFFh only while the cartridge's 8000h bank register
 * (written at 9000h) holds 3Fh; the 256-byte register block repeats through
 * that 2K:
 *
 *   00-7F  waves of channels 1-4, 32 bytes each (channel 5 plays channel 4's)
 *   80-89  periods, 12 bits, low then high byte, channels 1-5
 *   8A-8E  volumes (4 bits)
 *   8F     channel enable, bits 0-4
 *   90-9F  mirror of 80-8F
 *   A0-DF  read: channel 4/5's wave again; writes are ignored
 *   E0-FF  deformation register (bit 5: a period write restarts the wave)
 *
 * A channel steps through its wave once every 32 x (period + 1) CPU cycles.
 * Sound is rendered in step with CPU time as the PSG does: `advanceTo`
 * before each register write and at the end of the frame.
 */

export const SCC_CLOCK = 3_579_545;

/** Periods below this step faster than the chip can; they are silent. */
const MIN_PERIOD = 9;
/** Output for one channel at full volume and full wave. */
const CHANNEL_LEVEL = 0.15;

export class Scc {
  readonly wave = new Int8Array(128);
  readonly period = new Uint16Array(5);
  readonly volume = new Uint8Array(5);
  enable = 0;
  deform = 0;

  /** The CPU cycle count now; the machine points it at the Z80. */
  now: () => number = () => 0;

  private phase = new Float64Array(5);
  private samplePos = 0;
  private out: number[] = [];

  constructor(public sampleRate = 44100, readonly cpuClock = SCC_CLOCK) {}

  reset(): void {
    this.wave.fill(0);
    this.period.fill(0);
    this.volume.fill(0);
    this.enable = 0;
    this.deform = 0;
    this.phase.fill(0);
    this.samplePos = 0;
    this.out = [];
  }

  read(addr: number): number {
    const a = addr & 0xff;
    if (a < 0x80) return this.wave[a] & 0xff;
    if (a >= 0xa0 && a < 0xe0) return this.wave[0x60 | (a & 0x1f)] & 0xff;
    return 0xff; // the other registers are write-only
  }

  write(addr: number, value: number): void {
    this.advanceTo(this.now());
    const a = addr & 0xff;
    if (a < 0x80) {
      this.wave[a] = value; // stored as signed
    } else if (a < 0xa0) {
      const r = a & 0x0f;
      if (r < 0x0a) {
        const ch = r >> 1;
        this.period[ch] = r & 1
          ? (this.period[ch] & 0x0ff) | ((value & 0x0f) << 8)
          : (this.period[ch] & 0xf00) | value;
        if (this.deform & 0x20) this.phase[ch] = 0;
      } else if (r < 0x0f) {
        this.volume[r - 0x0a] = value & 0x0f;
      } else {
        this.enable = value & 0x1f;
      }
    } else if (a >= 0xe0) {
      this.deform = value;
    }
  }

  /** Renders samples up to CPU cycle `cycles`. */
  advanceTo(cycles: number): void {
    const want = Math.floor(((cycles - this.samplePos) * this.sampleRate) / this.cpuClock);
    if (want <= 0) return;
    this.samplePos += (want * this.cpuClock) / this.sampleRate;
    for (let i = 0; i < want; i++) this.out.push(this.sample());
  }

  /** Adds the samples rendered so far onto `into`; any beyond its length wait. */
  mixInto(into: Float32Array): void {
    const n = Math.min(into.length, this.out.length);
    for (let i = 0; i < n; i++) into[i] += this.out[i];
    this.out.splice(0, n);
  }

  /** Takes the samples rendered so far. */
  take(): Float32Array<ArrayBuffer> {
    const a = new Float32Array(this.out);
    this.out = [];
    return a;
  }

  /** Rebases the cycle count (the machine wraps it every frame). */
  rebase(by: number): void {
    this.samplePos -= by;
  }

  private sample(): number {
    let sum = 0;
    for (let ch = 0; ch < 5; ch++) {
      const p = this.period[ch];
      if (p < MIN_PERIOD) continue;
      const pos = Math.floor(this.phase[ch]) & 31;
      this.phase[ch] = (this.phase[ch] + this.cpuClock / ((p + 1) * this.sampleRate)) % 32;
      if (!((this.enable >> ch) & 1)) continue;
      const w = this.wave[(ch === 4 ? 3 : ch) * 32 + pos];
      sum += w * this.volume[ch];
    }
    return (sum / (128 * 15)) * CHANNEL_LEVEL;
  }
}
