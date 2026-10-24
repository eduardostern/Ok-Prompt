/**
 * Puts the modem speaker on a dialer: the dial tone, the digits and a ring
 * play first, and only then is the connection opened, so the BBS's clock
 * starts when a real modem's would; when it answers, CONNECT waits for the
 * (short) handshake, holding whatever the BBS sends meanwhile. BBSes probe
 * the terminal a few seconds after connecting and give up on a late answer.
 * A call that fails gets the busy signal.
 */
import type { DialTarget, Dialer, Link } from '../msx/modem';
import type { CallSound } from './modem-audio';

export function withCallSound(inner: Dialer, start: (target: DialTarget) => CallSound | undefined): Dialer {
  return (target, handlers) => {
    const sound = start(target);
    if (!sound) return inner(target, handlers);
    let open = false;
    let over = false;
    const held: Uint8Array[] = [];
    let link: Link | undefined;
    const connect = () => inner(target, {
      onOpen: (info) => {
        void sound.answered().then(() => {
          if (over) return;
          open = true;
          handlers.onOpen(info);
          for (const b of held) handlers.onData(b);
          held.length = 0;
        });
      },
      onData: (bytes) => {
        if (open) handlers.onData(bytes);
        else if (!over) held.push(bytes);
      },
      onClose: () => {
        if (over) return;
        over = true;
        if (open) sound.stop();
        else sound.failed();
        handlers.onClose();
      },
    });
    void sound.rung().then(() => {
      if (!over) link = connect();
    });
    return {
      send: (bytes) => link?.send(bytes),
      close: () => {
        // After the far end hung up, the modem closes too: let the busy signal play.
        if (!over) sound.stop();
        over = true;
        link?.close();
      },
    };
  };
}
