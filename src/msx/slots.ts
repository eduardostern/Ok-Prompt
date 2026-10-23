/**
 * MSX memory: four primary slots, each a full 64K address space, of which
 * the CPU sees one per 16K page. The PPI's port A (I/O A8h) picks the slot
 * for each page: bits 1-0 page 0 (0000h), 3-2 page 1, 5-4 page 2, 7-6 page 3.
 *
 * An MSX1 like C-BIOS's: slot 0 holds the BIOS ROM, slots 1 and 2 are the
 * cartridge ports, slot 3 the 64K of RAM. Expanded slots (subslots behind
 * FFFFh) are an MSX2 matter and not modelled yet.
 */

/** Anything that can sit in a slot. Addresses are the full 0000h-FFFFh. */
export interface SlotDevice {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

/** Nothing plugged in: reads FFh, writes vanish. */
export const EMPTY: SlotDevice = {
  read: () => 0xff,
  write: () => {},
};

/** ROM images placed at fixed addresses; the rest of the slot is empty. */
export class Rom implements SlotDevice {
  private parts: { base: number; data: Uint8Array }[] = [];

  /** Places `data` at `base`. */
  place(base: number, data: Uint8Array): this {
    this.parts.push({ base, data });
    return this;
  }

  read(addr: number): number {
    for (const p of this.parts) {
      const off = addr - p.base;
      if (off >= 0 && off < p.data.length) return p.data[off];
    }
    return 0xff;
  }

  write(): void {}
}

/** Plain RAM over the whole slot. */
export class Ram implements SlotDevice {
  readonly data = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.data[addr];
  }
  write(addr: number, value: number): void {
    this.data[addr] = value;
  }
}

export class Slots {
  readonly devices: SlotDevice[] = [EMPTY, EMPTY, EMPTY, EMPTY];
  /** The device behind each 16K page, from the primary slot register. */
  private page: SlotDevice[] = [EMPTY, EMPTY, EMPTY, EMPTY];
  private reg = 0;

  get primary(): number {
    return this.reg;
  }

  set primary(value: number) {
    this.reg = value & 0xff;
    this.remap();
  }

  /** Puts a device in slot `n` (0-3). */
  insert(n: number, device: SlotDevice): void {
    this.devices[n] = device;
    this.remap();
  }

  /** Which slot page `p` (0-3) shows. */
  slotOf(p: number): number {
    return (this.reg >> (p * 2)) & 3;
  }

  read(addr: number): number {
    return this.page[addr >> 14].read(addr);
  }

  write(addr: number, value: number): void {
    this.page[addr >> 14].write(addr, value);
  }

  private remap(): void {
    for (let p = 0; p < 4; p++) this.page[p] = this.devices[this.slotOf(p)];
  }
}
