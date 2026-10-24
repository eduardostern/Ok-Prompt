/**
 * The MSX2 memory mapper: RAM in 16K segments, any segment in any page. The
 * segment for page n is set by writing I/O port FCh + n; reading it back
 * gives the segment with the unused high bits set (as most mappers do,
 * openMSX's "largest"). At power-on the BIOS sets pages 3, 2, 1, 0 to
 * segments 0, 1, 2, 3; we start that way too.
 */
import type { SlotDevice } from './slots';

export class MapperRam implements SlotDevice {
  readonly data: Uint8Array;
  readonly segments: number;
  private readonly pages = [3, 2, 1, 0];

  constructor(kilobytes = 512) {
    this.segments = kilobytes / 16;
    if (this.segments & (this.segments - 1)) throw new Error('mapper size must be a power of two');
    this.data = new Uint8Array(kilobytes * 1024);
  }

  reset(): void {
    this.pages.splice(0, 4, 3, 2, 1, 0);
  }

  /** Port FCh-FFh. */
  setPage(page: number, segment: number): void {
    this.pages[page & 3] = segment & 0xff;
  }

  getPage(page: number): number {
    return (this.pages[page & 3] & (this.segments - 1)) | (~(this.segments - 1) & 0xff);
  }

  private offset(addr: number): number {
    return ((this.pages[addr >> 14] & (this.segments - 1)) << 14) | (addr & 0x3fff);
  }

  read(addr: number): number {
    return this.data[this.offset(addr)];
  }

  write(addr: number, value: number): void {
    this.data[this.offset(addr)] = value;
  }
}
