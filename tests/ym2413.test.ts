import { describe, expect, it } from 'vitest';
import { Ym2413, YM2413_CLOCK } from '../src/msx/ym2413';

const RATE = 44100;
const FRAME = 59736; // CPU cycles in a 60 Hz frame (262 x 228)

/** A chip whose clock we drive by hand. */
function chip() {
  const ym = new Ym2413(RATE);
  let t = 0;
  ym.now = () => t;
  const write = (r: number, v: number) => {
    ym.selectRegister(r);
    ym.writeData(v);
  };
  /** Runs `seconds` of CPU time and returns the samples, frame by frame. */
  const run = (seconds: number): Float32Array => {
    const frames = Math.round(seconds * 60);
    const all = new Float32Array(Math.ceil(frames * FRAME * RATE / YM2413_CLOCK) + 16);
    let n = 0;
    for (let f = 0; f < frames; f++) {
      t = FRAME;
      ym.advanceTo(FRAME);
      ym.rebase(FRAME);
      t = 0;
      const a = ym.take();
      all.set(a, n);
      n += a.length;
    }
    return all.subarray(0, n);
  };
  return { ym, write, run, setTime: (c: number) => (t = c) };
}

function peak(a: Float32Array): number {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

/** Fundamental by autocorrelation, searching periods for 50 Hz-2 kHz. */
function pitch(a: Float32Array, rate: number): number {
  let mean = 0;
  for (const v of a) mean += v;
  mean /= a.length;
  const x = Float64Array.from(a, (v) => v - mean);
  const minLag = Math.floor(rate / 2000), maxLag = Math.ceil(rate / 50);
  const r = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    r[lag] = s / (x.length - lag);
  }
  // first strong peak after the correlation has gone down
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > 0.8 * r[0]) {
      best = lag;
      break;
    }
  }
  if (best < 0) return 0;
  // parabolic interpolation
  const y0 = r[best - 1], y1 = r[best], y2 = r[best + 1];
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
  return rate / (best + d);
}

describe('YM2413', () => {
  it('is silent after reset', () => {
    const { ym, run } = chip();
    ym.reset();
    const a = run(0.2);
    expect(a.length).toBeGreaterThan(8000);
    expect(peak(a)).toBe(0);
  });

  it('plays the violin at fnum x clock/72 / 2^(19 - block)', () => {
    const { write, run } = chip();
    const fnum = 0x16c, block = 4; // ~433 Hz
    write(0x30, 0x10); // violin, full volume
    write(0x10, fnum & 0xff);
    write(0x20, 0x10 | (block << 1) | (fnum >> 8)); // key on
    const a = run(0.5);
    const expected = (fnum * (YM2413_CLOCK / 72)) / 2 ** (19 - block);
    const tail = a.subarray(a.length - 8192);
    expect(Math.abs(pitch(tail, RATE) - expected) / expected).toBeLessThan(0.01);
    const p = peak(tail);
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeLessThan(0.3);
  });

  it('decays to silence after key-off', () => {
    const { write, run } = chip();
    write(0x30, 0x30); // piano
    write(0x10, 0xad);
    write(0x20, 0x10 | (4 << 1) | 1);
    expect(peak(run(0.2))).toBeGreaterThan(0.02);
    write(0x20, (4 << 1) | 1); // key off
    run(1.5);
    expect(peak(run(0.1))).toBeLessThan(0.001);
  });

  it('plays the bass drum in rhythm mode', () => {
    const { write, run } = chip();
    write(0x16, 0x20);
    write(0x26, 0x05); // block 2
    write(0x36, 0x00); // bass drum full volume
    write(0x0e, 0x20); // rhythm mode
    expect(peak(run(0.1))).toBeLessThan(0.01);
    write(0x0e, 0x30); // BD on
    const a = run(0.3);
    expect(peak(a)).toBeGreaterThan(0.05);
  });

  it('mixInto adds samples and keeps the leftover', () => {
    const { write, ym, setTime } = chip();
    write(0x30, 0x10);
    write(0x10, 0x6c);
    write(0x20, 0x19);
    setTime(FRAME);
    ym.advanceTo(FRAME);
    const ref = ym.save();
    const all = ym.take();
    expect(all.length).toBe(Math.floor((FRAME * RATE) / YM2413_CLOCK));
    ym.load(ref);
    const into = new Float32Array(300).fill(1);
    ym.mixInto(into);
    for (let i = 0; i < 300; i++) expect(into[i]).toBeCloseTo(1 + all[i], 6);
    const rest = new Float32Array(all.length);
    ym.mixInto(rest);
    expect(Array.from(rest.subarray(0, all.length - 300))).toEqual(Array.from(all.subarray(300)));
    expect(ym.take().length).toBe(0);
  });

  it('save/load round-trips to identical output', () => {
    const a = chip();
    a.write(0x0e, 0x20);
    a.write(0x30, 0x51);
    a.write(0x10, 0x81);
    a.write(0x20, 0x17);
    a.write(0x31, 0xa0);
    a.write(0x11, 0x41);
    a.write(0x21, 0x1d);
    a.write(0x0e, 0x3f);
    a.run(0.1);
    const state = structuredClone(a.ym.save());
    const ref = a.run(0.2);
    const b = chip();
    b.ym.load(state);
    expect(Array.from(b.run(0.2))).toEqual(Array.from(ref));
  });

  it('renders a second of nine channels quickly', () => {
    const { write, run } = chip();
    for (let ch = 0; ch < 9; ch++) {
      write(0x30 + ch, ((ch + 1) << 4) | 2);
      write(0x10 + ch, 0x80 + ch * 20);
      write(0x20 + ch, 0x10 | (3 << 1) | 1);
    }
    run(0.1); // warm up
    const t0 = performance.now();
    const a = run(1);
    const ms = performance.now() - t0;
    console.log(`YM2413: 1 s of 9 channels in ${ms.toFixed(1)} ms, peak ${peak(a).toFixed(3)}`);
    // About 26 ms alone; the limit leaves room for a busy machine running all the tests at once.
    expect(ms).toBeLessThan(500);
    expect(peak(a)).toBeLessThan(1.5);
  });
});
