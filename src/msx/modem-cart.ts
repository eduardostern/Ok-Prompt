/**
 * The Ok-Modem cartridge: a Hayes modem on I/O ports 04h (status; DTR on
 * write) and 05h (data), and in its ROM the terminal (okmodem.asm). The
 * modem itself is A-Prompt's (modem.ts); the page gives it a dialer.
 */
import { Cartridge } from './cartridge';
import { Modem, ModemOptions } from './modem';

export const MODEM_STATUS_PORT = 0x04;
export const MODEM_DATA_PORT = 0x05;
export const MODEM_CART_NAME = 'Ok-Modem';

export class ModemCartridge extends Cartridge {
  readonly modem: Modem;

  constructor(rom: Uint8Array, options: ModemOptions = {}) {
    super(rom, 'plain', MODEM_CART_NAME);
    // The terminal shows 40 columns, or 80 on an MSX2; BBSes that ask are told so.
    this.modem = new Modem({ windowSize: () => [this.screenColumns(), 24], terminalType: () => 'ANSI', ...options });
  }

  override ioIn(port: number): number {
    if (port === MODEM_STATUS_PORT) return this.modem.status();
    if (port === MODEM_DATA_PORT) return this.modem.read();
    return -1;
  }

  override ioOut(port: number, value: number): boolean {
    if (port === MODEM_STATUS_PORT) this.modem.control(value);
    else if (port === MODEM_DATA_PORT) this.modem.write(value);
    else return false;
    return true;
  }

  override reset(): void {
    super.reset();
    this.modem.hangup(false);
  }
}
