/**
 * The Yamaha YM2413 (OPLL), the FM chip of MSX-MUSIC (FM-PAC, built into
 * many MSX2+ machines): nine two-operator channels, or six plus five
 * rhythm sounds, fifteen fixed instruments and one user instrument.
 *
 * Ports: 7Ch selects a register, 7Dh writes it. The chip runs at the CPU
 * clock (3.58 MHz) and makes one sample every 72 clocks (~49716 Hz); we
 * render at that rate in step with CPU time and resample linearly to the
 * output rate. As with the SCC: `advanceTo` before each register write
 * and at the end of the frame, `rebase` when the machine wraps its cycle
 * count, `mixInto` to add the samples onto the frame's buffer.
 *
 * A TypeScript port of emu2413 v1.6.3 by Mitsutaka Okazaki
 * (https://github.com/digital-sound-antiques/emu2413), YM2413 patch set
 * only. Dropped: VRC7/YMF281B patches, stereo pan, channel masks and the
 * sinc rate converter (replaced by linear interpolation).
 *
 * emu2413 is under the MIT License:
 *
 * Copyright (c) 2001-2019 Mitsutaka Okazaki
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const YM2413_CLOCK = 3_579_545;

/** CPU clocks per chip sample. */
const CLOCKS_PER_SAMPLE = 72;
/** Output per unit of emu2413's mix: a melodic channel peaks near ±2048. */
const LEVEL = 0.15 / 2048;

/* The YM2413 instruments, 8 bytes each: 0 user, 1-15, then the rhythm
   patches (bass drum, hi-hat/snare, tom/cymbal). */
// prettier-ignore
const DEFAULT_INST = [
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, // 0: User
  0x71,0x61,0x1e,0x17,0xd0,0x78,0x00,0x17, // 1: Violin
  0x13,0x41,0x1a,0x0d,0xd8,0xf7,0x23,0x13, // 2: Guitar
  0x13,0x01,0x99,0x00,0xf2,0xc4,0x21,0x23, // 3: Piano
  0x11,0x61,0x0e,0x07,0x8d,0x64,0x70,0x27, // 4: Flute
  0x32,0x21,0x1e,0x06,0xe1,0x76,0x01,0x28, // 5: Clarinet
  0x31,0x22,0x16,0x05,0xe0,0x71,0x00,0x18, // 6: Oboe
  0x21,0x61,0x1d,0x07,0x82,0x81,0x11,0x07, // 7: Trumpet
  0x33,0x21,0x2d,0x13,0xb0,0x70,0x00,0x07, // 8: Organ
  0x61,0x61,0x1b,0x06,0x64,0x65,0x10,0x17, // 9: Horn
  0x41,0x61,0x0b,0x18,0x85,0xf0,0x81,0x07, // A: Synthesizer
  0x33,0x01,0x83,0x11,0xea,0xef,0x10,0x04, // B: Harpsichord
  0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12, // C: Vibraphone
  0x61,0x50,0x0c,0x05,0xd2,0xf5,0x40,0x42, // D: Synthesizer Bass
  0x01,0x01,0x55,0x03,0xe9,0x90,0x03,0x02, // E: Acoustic Bass
  0x41,0x41,0x89,0x03,0xf1,0xe4,0xc0,0x13, // F: Electric Guitar
  0x01,0x01,0x18,0x0f,0xdf,0xf8,0x6a,0x6d, // R: Bass Drum
  0x01,0x01,0x00,0x00,0xc8,0xd8,0xa7,0x68, // R: High-Hat(M) / Snare Drum(C)
  0x05,0x01,0x00,0x00,0xf8,0xaa,0x59,0x55, // R: Tom-tom(M) / Top Cymbal(C)
];

/* phase increment counter */
const DP_BITS = 19;
const DP_WIDTH = 1 << DP_BITS;
const PG_BITS = 10;
const PG_WIDTH = 1 << PG_BITS;
const DP_BASE_BITS = DP_BITS - PG_BITS;

/* envelope */
const EG_STEP = 0.375;
const EG_BITS = 7;
const EG_MUTE = (1 << EG_BITS) - 1;
const EG_MAX = EG_MUTE - 4;
const DAMPER_RATE = 12;

/* exp_table[x] = round((exp2(x / 256) - 1) * 1024) */
// prettier-ignore
const EXP_TABLE = new Uint16Array([
  0,    3,    6,    8,    11,   14,   17,   20,   22,   25,   28,   31,   34,   37,   40,   42,
  45,   48,   51,   54,   57,   60,   63,   66,   69,   72,   75,   78,   81,   84,   87,   90,
  93,   96,   99,   102,  105,  108,  111,  114,  117,  120,  123,  126,  130,  133,  136,  139,
  142,  145,  148,  152,  155,  158,  161,  164,  168,  171,  174,  177,  181,  184,  187,  190,
  194,  197,  200,  204,  207,  210,  214,  217,  220,  224,  227,  231,  234,  237,  241,  244,
  248,  251,  255,  258,  262,  265,  268,  272,  276,  279,  283,  286,  290,  293,  297,  300,
  304,  308,  311,  315,  318,  322,  326,  329,  333,  337,  340,  344,  348,  352,  355,  359,
  363,  367,  370,  374,  378,  382,  385,  389,  393,  397,  401,  405,  409,  412,  416,  420,
  424,  428,  432,  436,  440,  444,  448,  452,  456,  460,  464,  468,  472,  476,  480,  484,
  488,  492,  496,  501,  505,  509,  513,  517,  521,  526,  530,  534,  538,  542,  547,  551,
  555,  560,  564,  568,  572,  577,  581,  585,  590,  594,  599,  603,  607,  612,  616,  621,
  625,  630,  634,  639,  643,  648,  652,  657,  661,  666,  670,  675,  680,  684,  689,  693,
  698,  703,  708,  712,  717,  722,  726,  731,  736,  741,  745,  750,  755,  760,  765,  770,
  774,  779,  784,  789,  794,  799,  804,  809,  814,  819,  824,  829,  834,  839,  844,  849,
  854,  859,  864,  869,  874,  880,  885,  890,  895,  900,  906,  911,  916,  921,  927,  932,
  937,  942,  948,  953,  959,  964,  969,  975,  980,  986,  991,  996, 1002, 1007, 1013, 1018,
]);

/* First quarter of fullsin_table[x] = round(-log2(sin((x + 0.5) * PI / (PG_WIDTH / 4) / 2)) * 256) */
// prettier-ignore
const SIN_QUARTER = [
  2137, 1731, 1543, 1419, 1326, 1252, 1190, 1137, 1091, 1050, 1013, 979,  949,  920,  894,  869,
  846,  825,  804,  785,  767,  749,  732,  717,  701,  687,  672,  659,  646,  633,  621,  609,
  598,  587,  576,  566,  556,  546,  536,  527,  518,  509,  501,  492,  484,  476,  468,  461,
  453,  446,  439,  432,  425,  418,  411,  405,  399,  392,  386,  380,  375,  369,  363,  358,
  352,  347,  341,  336,  331,  326,  321,  316,  311,  307,  302,  297,  293,  289,  284,  280,
  276,  271,  267,  263,  259,  255,  251,  248,  244,  240,  236,  233,  229,  226,  222,  219,
  215,  212,  209,  205,  202,  199,  196,  193,  190,  187,  184,  181,  178,  175,  172,  169,
  167,  164,  161,  159,  156,  153,  151,  148,  146,  143,  141,  138,  136,  134,  131,  129,
  127,  125,  122,  120,  118,  116,  114,  112,  110,  108,  106,  104,  102,  100,  98,   96,
  94,   92,   91,   89,   87,   85,   83,   82,   80,   78,   77,   75,   74,   72,   70,   69,
  67,   66,   64,   63,   62,   60,   59,   57,   56,   55,   53,   52,   51,   49,   48,   47,
  46,   45,   43,   42,   41,   40,   39,   38,   37,   36,   35,   34,   33,   32,   31,   30,
  29,   28,   27,   26,   25,   24,   23,   23,   22,   21,   20,   20,   19,   18,   17,   17,
  16,   15,   15,   14,   13,   13,   12,   12,   11,   10,   10,   9,    9,    8,    8,    7,
  7,    7,    6,    6,    5,    5,    5,    4,    4,    4,    3,    3,    3,    2,    2,    2,
  2,    1,    1,    1,    1,    1,    1,    1,    0,    0,    0,    0,    0,    0,    0,    0,
];

/** Both waves in one table: full sine at 0, half sine at PG_WIDTH. */
const WAVE = new Uint16Array(PG_WIDTH * 2);
{
  const q = PG_WIDTH / 4;
  for (let x = 0; x < q; x++) {
    WAVE[x] = SIN_QUARTER[x];
    WAVE[q + x] = SIN_QUARTER[q - x - 1];
  }
  for (let x = 0; x < PG_WIDTH / 2; x++) WAVE[PG_WIDTH / 2 + x] = 0x8000 | WAVE[x];
  for (let x = 0; x < PG_WIDTH / 2; x++) WAVE[PG_WIDTH + x] = WAVE[x];
  for (let x = PG_WIDTH / 2; x < PG_WIDTH; x++) WAVE[PG_WIDTH + x] = 0xfff;
}

/* pitch modulator: offset to fnum, rough approximation of 14 cents depth */
// prettier-ignore
const PM_TABLE = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 1, 0, 0, 0, -1, 0,
  0, 1, 2, 1, 0, -1, -2, -1,
  0, 1, 3, 1, 0, -1, -3, -1,
  0, 2, 4, 2, 0, -2, -4, -2,
  0, 2, 5, 2, 0, -2, -5, -2,
  0, 3, 6, 3, 0, -3, -6, -3,
  0, 3, 7, 3, 0, -3, -7, -3,
]);

/* amplitude LFO, verified on a real YM2413; each element lasts 64 samples */
const AM_TABLE = (() => {
  const a: number[] = [];
  for (let v = 0; v <= 12; v++) for (let i = 0; i < 8; i++) a.push(v);
  a.push(13, 13, 13);
  for (let v = 12; v >= 1; v--) for (let i = 0; i < 8; i++) a.push(v);
  for (let i = 0; i < 7; i++) a.push(0);
  return new Uint8Array(a); // 210 entries
})();

/* envelope decay increment steps (andete's research) */
// prettier-ignore
const EG_STEP_TABLES = new Uint8Array([
  0, 1, 0, 1, 0, 1, 0, 1,
  0, 1, 0, 1, 1, 1, 0, 1,
  0, 1, 1, 1, 0, 1, 1, 1,
  0, 1, 1, 1, 1, 1, 1, 1,
]);

const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3, DAMP = 4;

const ML_TABLE = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);

/* key scale level: tll_table[(block << 4) | fnum >> 5][KL] flattened */
const TLL_TABLE = (() => {
  const kl = [0, 9, 12, 13.875, 15, 16.125, 16.875, 17.625, 18, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21]
    .map((d) => d * 2);
  const t = new Uint16Array(8 * 16 * 4);
  for (let fnum = 0; fnum < 16; fnum++) {
    for (let block = 0; block < 8; block++) {
      for (let k = 1; k < 4; k++) {
        const tmp = Math.trunc(kl[fnum] - 6 * (7 - block));
        t[(((block << 4) | fnum) << 2) | k] = tmp <= 0 ? 0 : Math.trunc((tmp >> (3 - k)) / EG_STEP);
      }
    }
  }
  return t;
})();

/* key scale rate: rks_table[blk_fnum >> 8][KR] = KR ? blk_fnum >> 8 : block >> 1 */
function rksOf(blkFnum: number, kr: number): number {
  const i = blkFnum >> 8;
  return kr ? i : i >> 2;
}

const SLOT_BD1 = 12, SLOT_HH = 14, SLOT_SD = 15, SLOT_TOM = 16, SLOT_CYM = 17;

const UPDATE_WS = 1, UPDATE_TLL = 2, UPDATE_RKS = 4, UPDATE_EG = 8, UPDATE_ALL = 255;

/** Patches: 19 instruments x (modulator, carrier). */
const NPATCH = 38;

const PATCH_FIELDS = ['pAM', 'pPM', 'pEG', 'pKR', 'pML', 'pKL', 'pTL', 'pWS', 'pFB', 'pAR', 'pDR', 'pSL', 'pRR'] as const;
const SLOT_FIELDS = [
  'type', 'pgKeep', 'wave', 'pgPhase', 'out0', 'out1', 'egState', 'egShift', 'rks', 'tll',
  'keyFlag', 'susFlag', 'blkFnum', 'blk', 'fnum', 'volume', 'pgOut', 'egRateH', 'egRateL',
  'egOut', 'update', 'patch',
] as const;
const SCALARS = [
  'adr', 'pmPhase', 'amPhase', 'noise', 'shortNoise', 'testFlag', 'lfoAm', 'rhythmMode',
  'slotKeyStatus', 'egCounter', 'outT', 'curT', 'prev', 'cur',
] as const;

export class Ym2413 {
  /** The CPU cycle count now; the machine points it at the Z80. */
  now: () => number = () => 0;

  /* registers and chip-wide state */
  readonly reg = new Uint8Array(0x40);
  readonly patchNumber = new Uint8Array(9);
  private adr = 0;
  private pmPhase = 0;
  private amPhase = 0;
  private noise = 1;
  private shortNoise = 0;
  private testFlag = 0;
  private lfoAm = 0;
  private rhythmMode = 0;
  private slotKeyStatus = 0;
  private egCounter = 0;
  private chOut = new Int32Array(14);

  /* patches, one array per field */
  private pAM = new Uint8Array(NPATCH);
  private pPM = new Uint8Array(NPATCH);
  private pEG = new Uint8Array(NPATCH);
  private pKR = new Uint8Array(NPATCH);
  private pML = new Uint8Array(NPATCH);
  private pKL = new Uint8Array(NPATCH);
  private pTL = new Uint8Array(NPATCH);
  private pWS = new Uint8Array(NPATCH);
  private pFB = new Uint8Array(NPATCH);
  private pAR = new Uint8Array(NPATCH);
  private pDR = new Uint8Array(NPATCH);
  private pSL = new Uint8Array(NPATCH);
  private pRR = new Uint8Array(NPATCH);

  /* the 18 slots (operators), one array per field; even = modulator */
  private type = new Uint8Array(18);
  private pgKeep = new Uint8Array(18);
  private wave = new Uint16Array(18); // offset into WAVE: 0 or PG_WIDTH
  private pgPhase = new Int32Array(18);
  private out0 = new Int32Array(18);
  private out1 = new Int32Array(18);
  private egState = new Uint8Array(18);
  private egShift = new Uint8Array(18);
  private rks = new Int32Array(18);
  private tll = new Int32Array(18);
  private keyFlag = new Uint8Array(18);
  private susFlag = new Uint8Array(18);
  private blkFnum = new Int32Array(18);
  private blk = new Uint8Array(18);
  private fnum = new Int32Array(18);
  private volume = new Uint8Array(18);
  private pgOut = new Int32Array(18);
  private egRateH = new Uint8Array(18);
  private egRateL = new Uint8Array(18);
  private egOut = new Uint8Array(18);
  private update = new Uint8Array(18);
  private patch = new Uint8Array(18);

  /* resampling: chip samples `prev` (at curT - 72) and `cur` (at curT) */
  private outT = 0;
  private curT = 0;
  private prev = 0;
  private cur = 0;
  private out = new Float32Array(4096);
  private outLen = 0;

  constructor(public sampleRate = 44100, readonly cpuClock = YM2413_CLOCK) {
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < NPATCH; i++) this.dumpToPatch(i >> 1, i);
    this.adr = 0;
    this.reg.fill(0);
    this.pmPhase = 0;
    this.amPhase = 0;
    this.noise = 1;
    this.shortNoise = 0;
    this.testFlag = 0;
    this.lfoAm = 0;
    this.rhythmMode = 0;
    this.slotKeyStatus = 0;
    this.egCounter = 0;
    for (let i = 0; i < 18; i++) this.resetSlot(i);
    for (let i = 0; i < 9; i++) this.setPatch(i, 0);
    for (let i = 0; i < 0x40; i++) this.writeReg(i, 0);
    this.chOut.fill(0);
    this.outT = 0;
    this.curT = 0;
    this.prev = 0;
    this.cur = 0;
    this.outLen = 0;
  }

  /** Port 7Ch. */
  selectRegister(v: number): void {
    this.adr = v & 0xff;
  }

  /** Port 7Dh. */
  writeData(v: number): void {
    this.advanceTo(this.now());
    this.writeReg(this.adr, v & 0xff);
  }

  /** Renders samples up to CPU cycle `cycles`. */
  advanceTo(cycles: number): void {
    const step = this.cpuClock / this.sampleRate;
    let outT = this.outT;
    if (outT + step > cycles) return;
    let curT = this.curT, prev = this.prev, cur = this.cur;
    while (outT + step <= cycles) {
      outT += step;
      while (curT < outT) {
        prev = cur;
        cur = this.calc();
        curT += CLOCKS_PER_SAMPLE;
      }
      const f = (outT - (curT - CLOCKS_PER_SAMPLE)) / CLOCKS_PER_SAMPLE;
      if (this.outLen === this.out.length) {
        const bigger = new Float32Array(this.out.length * 2);
        bigger.set(this.out);
        this.out = bigger;
      }
      this.out[this.outLen++] = (prev + (cur - prev) * f) * LEVEL;
    }
    this.outT = outT;
    this.curT = curT;
    this.prev = prev;
    this.cur = cur;
  }

  /** Rebases the cycle count (the machine wraps it every frame). */
  rebase(by: number): void {
    this.outT -= by;
    this.curT -= by;
  }

  /** Adds the samples rendered so far onto `into`; any beyond its length wait. */
  mixInto(into: Float32Array): void {
    const n = Math.min(into.length, this.outLen);
    const out = this.out;
    for (let i = 0; i < n; i++) into[i] += out[i];
    out.copyWithin(0, n, this.outLen);
    this.outLen -= n;
  }

  /** Takes the samples rendered so far. */
  take(): Float32Array<ArrayBuffer> {
    const a = this.out.slice(0, this.outLen);
    this.outLen = 0;
    return a;
  }

  /** The whole state, structured-clonable. */
  save(): Ym2413State {
    const s: Record<string, unknown> = {};
    for (const k of SCALARS) s[k] = this[k];
    for (const k of PATCH_FIELDS) s[k] = this[k].slice();
    for (const k of SLOT_FIELDS) s[k] = this[k].slice();
    s.reg = this.reg.slice();
    s.patchNumber = this.patchNumber.slice();
    s.chOut = this.chOut.slice();
    s.out = this.out.slice(0, this.outLen);
    return s as Ym2413State;
  }

  load(state: object): void {
    const s = state as Record<string, unknown>;
    for (const k of SCALARS) this[k] = s[k] as number;
    for (const k of PATCH_FIELDS) this[k].set(s[k] as Uint8Array);
    for (const k of SLOT_FIELDS) this[k].set(s[k] as ArrayLike<number>);
    this.reg.set(s.reg as Uint8Array);
    this.patchNumber.set(s.patchNumber as Uint8Array);
    this.chOut.set(s.chOut as Int32Array);
    const out = s.out as Float32Array;
    if (this.out.length < out.length) this.out = new Float32Array(out.length * 2);
    this.out.set(out);
    this.outLen = out.length;
  }

  // ---- emu2413 ----

  private dumpToPatch(inst: number, p: number): void {
    const d = inst * 8;
    const car = p & 1;
    const b0 = DEFAULT_INST[d + car];
    this.pAM[p] = (b0 >> 7) & 1;
    this.pPM[p] = (b0 >> 6) & 1;
    this.pEG[p] = (b0 >> 5) & 1;
    this.pKR[p] = (b0 >> 4) & 1;
    this.pML[p] = b0 & 15;
    this.pKL[p] = (DEFAULT_INST[d + 2 + car] >> 6) & 3;
    this.pTL[p] = car ? 0 : DEFAULT_INST[d + 2] & 63;
    this.pFB[p] = car ? 0 : DEFAULT_INST[d + 3] & 7;
    this.pWS[p] = (DEFAULT_INST[d + 3] >> (car ? 4 : 3)) & 1;
    this.pAR[p] = (DEFAULT_INST[d + 4 + car] >> 4) & 15;
    this.pDR[p] = DEFAULT_INST[d + 4 + car] & 15;
    this.pSL[p] = (DEFAULT_INST[d + 6 + car] >> 4) & 15;
    this.pRR[p] = DEFAULT_INST[d + 6 + car] & 15;
  }

  private resetSlot(i: number): void {
    this.type[i] = i % 2;
    this.pgKeep[i] = 0;
    this.wave[i] = 0;
    this.pgPhase[i] = 0;
    this.out0[i] = 0;
    this.out1[i] = 0;
    this.egState[i] = RELEASE;
    this.egShift[i] = 0;
    this.rks[i] = 0;
    this.tll[i] = 0;
    this.keyFlag[i] = 0;
    this.susFlag[i] = 0;
    this.blkFnum[i] = 0;
    this.blk[i] = 0;
    this.fnum[i] = 0;
    this.volume[i] = 0;
    this.pgOut[i] = 0;
    this.egRateH[i] = 0;
    this.egRateL[i] = 0;
    this.egOut[i] = EG_MUTE;
    this.update[i] = 0;
    this.patch[i] = 0;
  }

  private parameterRate(i: number): number {
    if ((this.type[i] & 1) === 0 && this.keyFlag[i] === 0) return 0;
    const p = this.patch[i];
    switch (this.egState[i]) {
      case ATTACK: return this.pAR[p];
      case DECAY: return this.pDR[p];
      case SUSTAIN: return this.pEG[p] ? 0 : this.pRR[p];
      case RELEASE:
        if (this.susFlag[i]) return 5;
        return this.pEG[p] ? this.pRR[p] : 7;
      case DAMP: return DAMPER_RATE;
      default: return 0;
    }
  }

  private commitSlotUpdate(i: number): void {
    const req = this.update[i];
    const p = this.patch[i];
    if (req & UPDATE_WS) this.wave[i] = this.pWS[p] * PG_WIDTH;
    if (req & UPDATE_TLL) {
      const tl = (this.type[i] & 1) === 0 ? this.pTL[p] : this.volume[i];
      this.tll[i] = TLL_TABLE[((this.blkFnum[i] >> 5) << 2) | this.pKL[p]] + (tl << 1);
    }
    if (req & UPDATE_RKS) this.rks[i] = rksOf(this.blkFnum[i], this.pKR[p]);
    if (req & (UPDATE_RKS | UPDATE_EG)) {
      const rate = this.parameterRate(i);
      if (rate === 0) {
        this.egShift[i] = 0;
        this.egRateH[i] = 0;
        this.egRateL[i] = 0;
      } else {
        const h = Math.min(15, rate + (this.rks[i] >> 2));
        this.egRateH[i] = h;
        this.egRateL[i] = this.rks[i] & 3;
        if (this.egState[i] === ATTACK) this.egShift[i] = h > 0 && h < 12 ? 13 - h : 0;
        else this.egShift[i] = h < 13 ? 13 - h : 0;
      }
    }
    this.update[i] = 0;
  }

  private slotOn(i: number): void {
    this.keyFlag[i] = 1;
    this.egState[i] = DAMP;
    this.update[i] |= UPDATE_EG;
  }

  private slotOff(i: number): void {
    this.keyFlag[i] = 0;
    if (this.type[i] & 1) {
      this.egState[i] = RELEASE;
      this.update[i] |= UPDATE_EG;
    }
  }

  private updateKeyStatus(): void {
    const r14 = this.reg[0x0e];
    let status = 0;
    for (let ch = 0; ch < 9; ch++) if (this.reg[0x20 + ch] & 0x10) status |= 3 << (ch * 2);
    if (r14 & 0x20) {
      if (r14 & 0x10) status |= 3 << SLOT_BD1;
      if (r14 & 0x01) status |= 1 << SLOT_HH;
      if (r14 & 0x08) status |= 1 << SLOT_SD;
      if (r14 & 0x04) status |= 1 << SLOT_TOM;
      if (r14 & 0x02) status |= 1 << SLOT_CYM;
    }
    const changed = this.slotKeyStatus ^ status;
    if (changed) {
      for (let i = 0; i < 18; i++) {
        if ((changed >> i) & 1) {
          if ((status >> i) & 1) this.slotOn(i);
          else this.slotOff(i);
        }
      }
    }
    this.slotKeyStatus = status;
  }

  private setPatch(ch: number, num: number): void {
    this.patchNumber[ch] = num;
    this.patch[ch * 2] = num * 2;
    this.patch[ch * 2 + 1] = num * 2 + 1;
    this.update[ch * 2] |= UPDATE_ALL;
    this.update[ch * 2 + 1] |= UPDATE_ALL;
  }

  private setSusFlag(ch: number, flag: number): void {
    const c = ch * 2 + 1, m = ch * 2;
    this.susFlag[c] = flag;
    this.update[c] |= UPDATE_EG;
    if (this.type[m] & 1) {
      this.susFlag[m] = flag;
      this.update[m] |= UPDATE_EG;
    }
  }

  private setSlotVolume(i: number, volume: number): void {
    this.volume[i] = volume;
    this.update[i] |= UPDATE_TLL;
  }

  private setFnumber(ch: number, fnum: number): void {
    for (let i = ch * 2; i <= ch * 2 + 1; i++) {
      this.fnum[i] = fnum;
      this.blkFnum[i] = (this.blkFnum[i] & 0xe00) | (fnum & 0x1ff);
      this.update[i] |= UPDATE_EG | UPDATE_RKS | UPDATE_TLL;
    }
  }

  private setBlock(ch: number, blk: number): void {
    for (let i = ch * 2; i <= ch * 2 + 1; i++) {
      this.blk[i] = blk;
      this.blkFnum[i] = ((blk & 7) << 9) | (this.blkFnum[i] & 0x1ff);
      this.update[i] |= UPDATE_EG | UPDATE_RKS | UPDATE_TLL;
    }
  }

  private updateRhythmMode(): void {
    const mode = (this.reg[0x0e] >> 5) & 1;
    if (this.rhythmMode !== mode) {
      if (mode) {
        this.type[SLOT_HH] = 3;
        this.pgKeep[SLOT_HH] = 1;
        this.type[SLOT_SD] = 3;
        this.type[SLOT_TOM] = 3;
        this.type[SLOT_CYM] = 3;
        this.pgKeep[SLOT_CYM] = 1;
        this.setPatch(6, 16);
        this.setPatch(7, 17);
        this.setPatch(8, 18);
        this.setSlotVolume(SLOT_HH, ((this.reg[0x37] >> 4) & 15) << 2);
        this.setSlotVolume(SLOT_TOM, ((this.reg[0x38] >> 4) & 15) << 2);
      } else {
        this.type[SLOT_HH] = 0;
        this.pgKeep[SLOT_HH] = 0;
        this.type[SLOT_SD] = 1;
        this.type[SLOT_TOM] = 0;
        this.type[SLOT_CYM] = 1;
        this.pgKeep[SLOT_CYM] = 0;
        this.setPatch(6, this.reg[0x36] >> 4);
        this.setPatch(7, this.reg[0x37] >> 4);
        this.setPatch(8, this.reg[0x38] >> 4);
      }
    }
    this.rhythmMode = mode;
  }

  /** Requests `flag` on the modulators (car = 0) or carriers (1) using the user patch. */
  private touchUser(car: number, flag: number): void {
    for (let ch = 0; ch < 9; ch++) if (this.patchNumber[ch] === 0) this.update[ch * 2 + car] |= flag;
  }

  writeReg(r: number, data: number): void {
    if (r >= 0x40) return;
    if ((r >= 0x19 && r <= 0x1f) || (r >= 0x29 && r <= 0x2f) || (r >= 0x39 && r <= 0x3f)) r -= 9;
    this.reg[r] = data;
    switch (r) {
      case 0x00:
      case 0x01:
        this.pAM[r] = (data >> 7) & 1;
        this.pPM[r] = (data >> 6) & 1;
        this.pEG[r] = (data >> 5) & 1;
        this.pKR[r] = (data >> 4) & 1;
        this.pML[r] = data & 15;
        this.touchUser(r, UPDATE_RKS | UPDATE_EG);
        break;
      case 0x02:
        this.pKL[0] = (data >> 6) & 3;
        this.pTL[0] = data & 63;
        this.touchUser(0, UPDATE_TLL);
        break;
      case 0x03:
        this.pKL[1] = (data >> 6) & 3;
        this.pWS[1] = (data >> 4) & 1;
        this.pWS[0] = (data >> 3) & 1;
        this.pFB[0] = data & 7;
        this.touchUser(0, UPDATE_WS);
        this.touchUser(1, UPDATE_WS | UPDATE_TLL);
        break;
      case 0x04:
      case 0x05:
        this.pAR[r - 4] = (data >> 4) & 15;
        this.pDR[r - 4] = data & 15;
        this.touchUser(r - 4, UPDATE_EG);
        break;
      case 0x06:
      case 0x07:
        this.pSL[r - 6] = (data >> 4) & 15;
        this.pRR[r - 6] = data & 15;
        this.touchUser(r - 6, UPDATE_EG);
        break;
      case 0x0e:
        this.updateRhythmMode();
        this.updateKeyStatus();
        break;
      case 0x0f:
        this.testFlag = data;
        break;
      default:
        if (r >= 0x10 && r <= 0x18) {
          const ch = r - 0x10;
          this.setFnumber(ch, data + ((this.reg[0x20 + ch] & 1) << 8));
        } else if (r >= 0x20 && r <= 0x28) {
          const ch = r - 0x20;
          this.setFnumber(ch, ((data & 1) << 8) + this.reg[0x10 + ch]);
          this.setBlock(ch, (data >> 1) & 7);
          this.setSusFlag(ch, (data >> 5) & 1);
          this.updateKeyStatus();
        } else if (r >= 0x30 && r <= 0x38) {
          const ch = r - 0x30;
          if (this.reg[0x0e] & 32 && r >= 0x36) {
            if (r === 0x37) this.setSlotVolume(14, ((data >> 4) & 15) << 2);
            else if (r === 0x38) this.setSlotVolume(16, ((data >> 4) & 15) << 2);
          } else {
            this.setPatch(ch, (data >> 4) & 15);
          }
          this.setSlotVolume(ch * 2 + 1, (data & 15) << 2);
        }
    }
  }

  private calcPhase(i: number, reset: number): void {
    const p = this.patch[i];
    const pm = this.pPM[p] ? PM_TABLE[(((this.fnum[i] >> 6) & 7) << 3) | ((this.pmPhase >> 10) & 7)] : 0;
    if (reset) this.pgPhase[i] = 0;
    const inc = ((((this.fnum[i] & 0x1ff) * 2 + pm) * ML_TABLE[this.pML[p]]) << this.blk[i]) >>> 2;
    const ph = (this.pgPhase[i] + inc) & (DP_WIDTH - 1);
    this.pgPhase[i] = ph;
    this.pgOut[i] = ph >> DP_BASE_BITS;
  }

  private attackStep(i: number, counter: number): number {
    const l = this.egRateL[i] << 3;
    switch (this.egRateH[i]) {
      case 12: return 4 - EG_STEP_TABLES[l | ((counter & 0xc) >> 1)];
      case 13: return 3 - EG_STEP_TABLES[l | ((counter & 0xc) >> 1)];
      case 14: return 2 - EG_STEP_TABLES[l | ((counter & 0xc) >> 1)];
      case 0:
      case 15: return 0;
      default: return EG_STEP_TABLES[l | ((counter >> this.egShift[i]) & 7)] ? 4 : 0;
    }
  }

  private decayStep(i: number, counter: number): number {
    const l = this.egRateL[i] << 3;
    switch (this.egRateH[i]) {
      case 0: return 0;
      case 13: return EG_STEP_TABLES[l | ((counter & 0xc) >> 1) | (counter & 1)];
      case 14: return EG_STEP_TABLES[l | ((counter & 0xc) >> 1)] + 1;
      case 15: return 2;
      default: return EG_STEP_TABLES[l | ((counter >> this.egShift[i]) & 7)];
    }
  }

  private startEnvelope(i: number): void {
    if (Math.min(15, this.pAR[this.patch[i]] + (this.rks[i] >> 2)) === 15) {
      this.egState[i] = DECAY;
      this.egOut[i] = 0;
    } else {
      this.egState[i] = ATTACK;
    }
    this.update[i] |= UPDATE_EG;
  }

  private calcEnvelope(i: number, buddy: number, counter: number, test: number): void {
    const state = this.egState[i];
    if (!test && (state === SUSTAIN || state === RELEASE) && (this.egOut[i] >= EG_MUTE || this.egRateH[i] === 0)) {
      return;
    }
    const mask = (1 << this.egShift[i]) - 1;
    const eg = this.egOut[i];
    if (state === ATTACK) {
      if (eg > 0 && this.egRateH[i] > 0 && (counter & mask & ~3) === 0) {
        const s = this.attackStep(i, counter);
        if (s > 0) this.egOut[i] = Math.max(0, eg - (eg >> s) - 1);
      }
    } else if (this.egRateH[i] > 0 && (counter & mask) === 0) {
      this.egOut[i] = Math.min(EG_MUTE, eg + this.decayStep(i, counter));
    }
    switch (state) {
      case DAMP:
        if (this.egOut[i] >= EG_MAX && (counter & mask) === 0) {
          this.startEnvelope(i);
          if (this.type[i] & 1) {
            if (!this.pgKeep[i]) this.pgPhase[i] = 0;
            if (buddy >= 0 && !this.pgKeep[buddy]) this.pgPhase[buddy] = 0;
          }
        }
        break;
      case ATTACK:
        if (this.egOut[i] === 0) {
          this.egState[i] = DECAY;
          this.update[i] |= UPDATE_EG;
        }
        break;
      case DECAY:
        if (this.egOut[i] >> 3 === this.pSL[this.patch[i]]) {
          this.egState[i] = SUSTAIN;
          this.update[i] |= UPDATE_EG;
        }
        break;
    }
    if (test) this.egOut[i] = 0;
  }

  /** Attenuation `h` (log-sine plus sign) through the envelope to a linear value. */
  private toLinear(h: number, i: number, am: number): number {
    const eg = this.egOut[i];
    if (eg > EG_MAX) return 0;
    const x = h + (Math.min(EG_MUTE, eg + this.tll[i] + am) << 4);
    const res = (EXP_TABLE[(x & 0xff) ^ 0xff] + 1024) >> ((x & 0x7f00) >> 8);
    return (x & 0x8000 ? ~res : res) << 1;
  }

  private calcCar(ch: number, fm: number): number {
    const i = ch * 2 + 1;
    const am = this.pAM[this.patch[i]] ? this.lfoAm : 0;
    this.out1[i] = this.out0[i];
    const v = this.toLinear(WAVE[this.wave[i] + ((this.pgOut[i] + 2 * (fm >> 1)) & (PG_WIDTH - 1))], i, am);
    this.out0[i] = v;
    return v;
  }

  private calcMod(ch: number): number {
    const i = ch * 2;
    const p = this.patch[i];
    const fb = this.pFB[p];
    const fm = fb > 0 ? (this.out1[i] + this.out0[i]) >> (9 - fb) : 0;
    const am = this.pAM[p] ? this.lfoAm : 0;
    this.out1[i] = this.out0[i];
    const v = this.toLinear(WAVE[this.wave[i] + ((this.pgOut[i] + fm) & (PG_WIDTH - 1))], i, am);
    this.out0[i] = v;
    return v;
  }

  private calcTom(): number {
    const i = 16;
    return this.toLinear(WAVE[this.wave[i] + this.pgOut[i]], i, 0);
  }

  private calcSnare(): number {
    const i = 15;
    const phase = (this.pgOut[i] >> (PG_BITS - 2)) & 1
      ? (this.noise & 1 ? 0x300 : 0x200)
      : (this.noise & 1 ? 0x000 : 0x100);
    return this.toLinear(WAVE[this.wave[i] + phase], i, 0);
  }

  private calcCym(): number {
    const i = 17;
    return this.toLinear(WAVE[this.wave[i] + (this.shortNoise ? 0x300 : 0x100)], i, 0);
  }

  private calcHat(): number {
    const i = 14;
    const phase = this.shortNoise
      ? (this.noise & 1 ? 0x2d0 : 0x234)
      : (this.noise & 1 ? 0x34 : 0xd0);
    return this.toLinear(WAVE[this.wave[i] + phase], i, 0);
  }

  private updateNoise(cycles: number): void {
    let n = this.noise;
    for (let i = 0; i < cycles; i++) {
      if (n & 1) n ^= 0x800200;
      n >>>= 1;
    }
    this.noise = n;
  }

  /** One chip sample (emu2413's update_output + mix_output). */
  private calc(): number {
    // update_ampm
    if (this.testFlag & 2) {
      this.pmPhase = 0;
      this.amPhase = 0;
    } else {
      this.pmPhase = (this.pmPhase + (this.testFlag & 8 ? 1024 : 1)) >>> 0;
      this.amPhase = (this.amPhase + (this.testFlag & 8 ? 64 : 1)) >>> 0;
    }
    this.lfoAm = AM_TABLE[(this.amPhase >>> 6) % 210];

    // update_short_noise
    const hh = this.pgOut[SLOT_HH], cym = this.pgOut[SLOT_CYM];
    const h2 = (hh >> 2) & 1, h7 = (hh >> 7) & 1, h3 = (hh >> 3) & 1;
    const c3 = (cym >> 3) & 1, c5 = (cym >> 5) & 1;
    this.shortNoise = (h2 ^ h7) | (h3 ^ c5) | (c3 ^ c5);

    // update_slots
    const counter = (this.egCounter = (this.egCounter + 1) & 0xffff);
    const test = this.testFlag & 1, reset = this.testFlag & 4;
    for (let i = 0; i < 18; i++) {
      const t = this.type[i];
      const buddy = t === 0 ? i + 1 : t === 1 ? i - 1 : -1;
      if (this.update[i]) this.commitSlotUpdate(i);
      this.calcEnvelope(i, buddy, counter, test);
      this.calcPhase(i, reset);
    }

    const out = this.chOut;
    for (let ch = 0; ch < 6; ch++) out[ch] = -this.calcCar(ch, this.calcMod(ch)) >> 1;
    if (!this.rhythmMode) {
      out[6] = -this.calcCar(6, this.calcMod(6)) >> 1;
      this.updateNoise(14);
      out[7] = -this.calcCar(7, this.calcMod(7)) >> 1;
      this.updateNoise(2);
      out[8] = -this.calcCar(8, this.calcMod(8)) >> 1;
      this.updateNoise(2);
    } else {
      out[9] = this.calcCar(6, this.calcMod(6));
      this.updateNoise(14);
      out[10] = this.calcHat();
      out[11] = this.calcSnare();
      this.updateNoise(2);
      out[12] = this.calcTom();
      out[13] = this.calcCym();
      this.updateNoise(2);
    }
    let sum = 0;
    for (let i = 0; i < 14; i++) sum += out[i];
    return sum;
  }
}

export type Ym2413State = Record<string, number | ArrayLike<number>>;
