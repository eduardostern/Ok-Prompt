/**
 * The printer port: data on port 91h, the strobe on bit 0 of port 90h
 * (the byte is taken when the strobe goes low), and on reading port 90h
 * bit 1 says busy (0: ready). The BIOS's LPTOUT does OUT (91h),A, then a
 * low and a high strobe. Our printer is always ready and keeps every byte.
 */
export class Printer {
  /** Everything printed since the last clear. */
  bytes: number[] = [];
  /** Called after each printed byte. */
  onPrint?: () => void;
  private data = 0;
  private strobe = 1;

  write(port: number, value: number): void {
    if (port === 0x91) this.data = value;
    else {
      const s = value & 1;
      if (this.strobe && !s) {
        this.bytes.push(this.data);
        this.onPrint?.();
      }
      this.strobe = s;
    }
  }

  /** Port 90h: always ready. */
  status(): number {
    return 0xfd;
  }

  clear(): void {
    this.bytes = [];
  }
}

/**
 * Printed bytes as text: CR LF, LF or a lone CR end a line (a CR not
 * followed by LF on a real printer goes back over the line; here the line
 * just ends), form feed starts a page, other control codes are dropped.
 * `char` turns MSX codes 80h and up into characters.
 */
export function printedText(bytes: number[], char: (code: number) => string): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d) {
      out += '\n';
      if (bytes[i + 1] === 0x0a) i++;
    } else if (b === 0x0a) out += '\n';
    else if (b === 0x0c) out += '\n\f\n';
    else if (b === 0x09) out += '\t';
    else if (b >= 0x20) out += char(b) || '?';
  }
  return out;
}
