import { describe, expect, it } from 'vitest';
import { MapperRam } from '../src/msx/mapper';
import { Rtc } from '../src/msx/rtc';
import { ExpandedSlot, Ram, Rom, Slots } from '../src/msx/slots';

describe('expanded slots', () => {
  it('switch subslots per page through FFFFh, which reads back inverted', () => {
    const s = new Slots();
    const sub0 = new Rom().place(0, new Uint8Array(0x10000).fill(0x11));
    const sub2 = new Ram();
    const x = new ExpandedSlot().insert(0, sub0).insert(2, sub2);
    s.insert(3, x);
    s.primary = 0xc0; // page 3 from slot 3
    expect(s.read(0xffff)).toBe(0xff); // all pages on subslot 0: ~00h
    s.write(0xffff, 0b10_10_00_00); // pages 2 and 3 on subslot 2
    expect(s.read(0xffff)).toBe(0x5f);
    s.write(0xc000, 0x42);
    expect(sub2.data[0xc000]).toBe(0x42);
    s.primary = 0xc0 | 0x0c; // page 1 from slot 3 too: subslot 0 there
    expect(s.read(0x4000)).toBe(0x11);
    s.primary = 0x00; // page 3 elsewhere: FFFFh is plain memory of that slot
    expect(s.read(0xffff)).toBe(0xff);
  });
});

describe('memory mapper', () => {
  it('maps segments into pages and reads back with the high bits set', () => {
    const m = new MapperRam(512);
    expect(m.segments).toBe(32);
    m.write(0x0000, 1); // page 0 = segment 3
    expect(m.data[3 * 0x4000]).toBe(1);
    m.setPage(0, 7);
    m.write(0x0010, 2);
    expect(m.data[7 * 0x4000 + 0x10]).toBe(2);
    expect(m.getPage(0)).toBe(0xe7); // 32 segments: bits 7-5 read 1
    m.setPage(1, 0x27); // wraps at 32 segments
    expect(m.read(0x4010)).toBe(2);
  });
});

describe('RTC', () => {
  it('tells the host time in BCD, keeps set times as an offset, and has RAM', () => {
    const rtc = new Rtc(() => new Date(2026, 9, 24, 13, 45, 59));
    const rd = (r: number) => { rtc.select(r); return rtc.read() & 0x0f; };
    expect([rd(0), rd(1), rd(2), rd(3), rd(4), rd(5)]).toEqual([9, 5, 5, 4, 3, 1]);
    expect([rd(7), rd(8), rd(9), rd(10), rd(11), rd(12)]).toEqual([4, 2, 0, 1, 6, 2]);
    rtc.select(5); rtc.write(2); // hours tens: 13 -> 23
    expect(rd(5)).toBe(2);
    expect(rd(4)).toBe(3);
    let saved: Uint8Array | undefined;
    rtc.onRamChange = (r) => { saved = r; };
    rtc.select(0x0d); rtc.write(2); // block 2
    rtc.select(3); rtc.write(0xa);
    expect(rd(3)).toBe(0xa);
    expect(saved?.[3]).toBe(0xa);
    rtc.select(0x0d); rtc.write(0);
    expect(rd(3)).toBe(4); // back to the time
  });
});
