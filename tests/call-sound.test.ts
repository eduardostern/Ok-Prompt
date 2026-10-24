import { describe, expect, it } from 'vitest';
import type { Dialer, LinkHandlers } from '../src/msx/modem';
import { withCallSound } from '../src/ui/call-sound';

describe('the call sound on a dialer', () => {
  it('connects only after the ring, and holds the BBS until the handshake ends', async () => {
    let rang!: () => void;
    let shook!: () => void;
    const sound = {
      rung: () => new Promise<void>((r) => { rang = r; }),
      answered: () => new Promise<void>((r) => { shook = r; }),
      failed: () => {},
      stop: () => {},
    };
    let bbs: LinkHandlers | undefined;
    const inner: Dialer = (_t, h) => { bbs = h; return { send: () => {}, close: () => {} }; };
    const seen: string[] = [];
    withCallSound(inner, () => sound)({ host: 'bbs', port: 23 }, {
      onOpen: () => seen.push('CONNECT'),
      onData: (b) => seen.push(String.fromCharCode(...b)),
      onClose: () => seen.push('closed'),
    });
    expect(bbs).toBeUndefined(); // dial tone and digits: no connection yet, the BBS's clock not started
    rang();
    await Promise.resolve();
    await Promise.resolve();
    expect(bbs).toBeDefined();
    bbs!.onOpen();
    bbs!.onData(Uint8Array.from([0x1b, 0x5b, 0x36, 0x6e])); // ESC[6n during the handshake
    expect(seen).toEqual([]);
    shook();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['CONNECT', '\x1b[6n']);
  });
});
