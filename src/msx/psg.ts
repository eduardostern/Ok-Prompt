/**
 * The AY-3-8910 PSG (a YM2149 in many MSXs): three square-wave tone
 * channels, one noise generator and one envelope, clocked at half the CPU
 * clock (1.79 MHz). I/O A0h selects a register, A1h writes it, A2h reads it.
 *
 * Registers: 0-5 tone periods (12 bits, A B C), 6 noise period (5 bits),
 * 7 mixer (bits 0-2 tone off, 3-5 noise off, 6-7 I/O port directions),
 * 8-10 volumes (bit 4: follow the envelope), 11-12 envelope period,
 * 13 envelope shape, 14 port A (in: joystick, cassette), 15 port B (out:
 * joystick select, pins, kana lamp).
 *
 * Sound is made in step with CPU time: `advanceTo(cycles)` renders the
 * samples up to that moment, and the machine calls it before every register
 * write and at the end of each frame, so a change lands where it happened.
 */

/** The AY's logarithmic volume steps, about 3 dB apart. */
const LEVEL = [
  0, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
  0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1,
];

export class Psg {
  readonly regs = new Uint8Array(16);
  private selected = 0;

  /** Joystick port A input (bit clear = pressed): up down left right A B. */
  joystick = [0x3f, 0x3f];
  /** The key-click level (PPI port C bit 7), mixed in. */
  click = 0;
  /** The cassette input (R14 bit 7): the tape's level now. */
  tapeIn?: () => number;

  private toneCount = [0, 0, 0];
  private toneOut = [0, 0, 0];
  private noiseCount = 0;
  private noiseLfsr = 1;
  private noiseOut = 0;
  private envCount = 0;
  private envStep = 0;
  private envHolding = false;
  private envVolume = 0;

  /** PSG ticks (clock/8) per output sample, and the fraction carried. */
  private readonly tickPerSample: number;
  private tickCarry = 0;
  private samplePos = 0; // CPU cycles already rendered
  private out: number[] = [];

  constructor(readonly cpuClock: number, readonly sampleRate: number) {
    this.tickPerSample = cpuClock / 2 / 8 / sampleRate;
  }

  reset(): void {
    this.regs.fill(0);
    this.regs[7] = 0xb8; // as the BIOS leaves it: port A in, port B out
    this.selected = 0;
    this.toneCount = [0, 0, 0];
    this.toneOut = [0, 0, 0];
    this.noiseLfsr = 1;
    this.envStep = 0;
    this.envHolding = false;
    this.samplePos = 0;
    this.tickCarry = 0;
    this.out = [];
  }

  select(value: number): void {
    this.selected = value & 0x0f;
  }

  write(value: number, cycles: number): void {
    this.advanceTo(cycles);
    const r = this.selected;
    this.regs[r] = value & 0xff;
    if (r === 13) {
      // A new shape restarts the envelope.
      this.envStep = 0;
      this.envCount = 0;
      this.envHolding = false;
    }
  }

  read(): number {
    const r = this.selected;
    if (r === 14) {
      // Port A: joystick 1 or 2 (picked by port B bit 6), keyboard layout
      // bit 6 = 1 (international), cassette input bit 7.
      const stick = this.joystick[(this.regs[15] >> 6) & 1];
      return (this.tapeIn?.() ? 0x80 : 0) | 0x40 | (stick & 0x3f);
    }
    return this.regs[r];
  }

  /** Renders samples up to CPU cycle `cycles`. */
  advanceTo(cycles: number): void {
    const want = Math.floor(((cycles - this.samplePos) * this.sampleRate) / this.cpuClock);
    if (want <= 0) return;
    this.samplePos += (want * this.cpuClock) / this.sampleRate;
    for (let i = 0; i < want; i++) this.out.push(this.sample());
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
    // Advance the generators by this sample's share of PSG ticks.
    this.tickCarry += this.tickPerSample;
    const ticks = Math.floor(this.tickCarry);
    this.tickCarry -= ticks;
    const r = this.regs;
    for (let t = 0; t < ticks; t++) {
      for (let c = 0; c < 3; c++) {
        const period = (r[c * 2] | ((r[c * 2 + 1] & 0x0f) << 8)) || 1;
        if (++this.toneCount[c] >= period) {
          this.toneCount[c] = 0;
          this.toneOut[c] ^= 1;
        }
      }
      // Tone: the output flips every `period` ticks, so f = clock / (16 * period).
      // Noise shifts its 17-bit LFSR every 2 * period ticks.
      const np = (r[6] & 0x1f) || 1;
      if (++this.noiseCount >= np * 2) {
        this.noiseCount = 0;
        const bit = (this.noiseLfsr ^ (this.noiseLfsr >> 3)) & 1;
        this.noiseLfsr = (this.noiseLfsr >> 1) | (bit << 16);
        this.noiseOut = this.noiseLfsr & 1;
      }
      // Envelope: f = clock / (256 * period) per 16-step ramp, so one step
      // every 2 * period ticks.
      const ep = (r[11] | (r[12] << 8)) || 1;
      if (++this.envCount >= ep * 2) {
        this.envCount = 0;
        this.stepEnvelope();
      }
    }
    const mix = r[7];
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const tone = (mix >> c) & 1 ? 1 : this.toneOut[c];
      const noise = (mix >> (c + 3)) & 1 ? 1 : this.noiseOut;
      if (!(tone & noise)) continue;
      const v = r[8 + c];
      sum += LEVEL[v & 0x10 ? this.envVolume : v & 0x0f];
    }
    return (sum / 3) * 0.6 + (this.click ? 0.08 : 0);
  }

  /** One envelope step, following the shape in R13 (CONT ATT ALT HOLD). */
  private stepEnvelope(): void {
    const shape = this.regs[13] & 0x0f;
    if (this.envHolding) return;
    const attack = (shape & 0x04) !== 0;
    const cycle = Math.floor(this.envStep / 16);
    const pos = this.envStep % 16;
    let rising = attack;
    if (shape & 0x02 && cycle % 2 === 1) rising = !rising; // alternate
    this.envVolume = rising ? pos : 15 - pos;
    this.envStep++;
    if (this.envStep % 16 === 0) {
      if (!(shape & 0x08)) {
        // One ramp, then silence.
        this.envVolume = 0;
        this.envHolding = true;
      } else if (shape & 0x01) {
        // Hold: stay at the end of this ramp (flipped if alternating).
        const end = rising ? 15 : 0;
        this.envVolume = shape & 0x02 ? 15 - end : end;
        this.envHolding = true;
      }
    }
  }
}
