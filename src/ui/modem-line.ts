/**
 * The modem cartridge's line out of the browser, as in A-Prompt: a BBS with
 * its own WebSocket gateway is called straight from the page; any other
 * board in the phone book goes through this site's Worker (/relay), which
 * opens the telnet connection. DEEPSEEK reaches the AI board, which lives in
 * the page. Dialing plays the dial tone, the beeps and the handshake.
 */
import { createAiBoard } from '../aiboard';
import { streamChat } from '../deepseek';
import type { Dialer, Link, LinkHandlers, ModemOptions } from '../msx/modem';
import { inPhoneBook } from '../phonebook';
import { withCallSound } from './call-sound';
import { startCallSound } from './modem-audio';

const DEEPSEEK_KEY = 'ok-prompt.deepseek-key';
const MODEM_PROFILE = 'ok-prompt.modem';

export function getDeepSeekKey(): string | null {
  try {
    return localStorage.getItem(DEEPSEEK_KEY);
  } catch {
    return null;
  }
}

/** Listeners for key changes (the panel shows whether one is saved). */
export const keyListeners: (() => void)[] = [];

export function setDeepSeekKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(DEEPSEEK_KEY, key);
    else localStorage.removeItem(DEEPSEEK_KEY);
  } catch {
    /* storage blocked: the key lasts for this call only */
  }
  for (const f of keyListeners) f();
}

/** A call over one WebSocket; `isRelay` waits for the relay's CONNECT frame. */
function wsCall(url: string, protocols: string[], isRelay: boolean, handlers: LinkHandlers): Link {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, protocols);
  } catch {
    queueMicrotask(() => handlers.onClose());
    return { send: () => {}, close: () => {} };
  }
  ws.binaryType = 'arraybuffer';
  if (!isRelay) ws.onopen = () => handlers.onOpen('DIRECT');
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') handlers.onData(new Uint8Array(e.data as ArrayBuffer));
    else if (isRelay && e.data === 'CONNECT') handlers.onOpen();
    else handlers.onData(Uint8Array.from(e.data, (c) => c.charCodeAt(0) & 0xff));
  };
  ws.onclose = () => handlers.onClose();
  return {
    send: (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); },
    close: () => ws.close(),
  };
}

/** Through the Worker relay (worker/index.ts) on the same origin. */
function relayCall(host: string, port: number, handlers: LinkHandlers): Link {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = `host=${encodeURIComponent(host)}&port=${port}`;
  return wsCall(`${scheme}://${location.host}/relay?${query}`, [], true, handlers);
}

export interface LineDeps {
  /** Records a program from the AI board onto a tape in the deck. */
  record(name: string, program: string): void;
  hasBasic(): boolean;
  /** The modem's speaker settings (ATM, ATL), read when a call starts. */
  speaker(): { on: boolean; volume: number };
}

/** The dialer: a BBS's gateway, else the relay; DEEPSEEK is the AI board. */
export function makeDialer(deps: LineDeps): Dialer {
  const dial: Dialer = (target, handlers) => {
    if (target.host === 'deepseek' || target.host === 'ai') {
      return createAiBoard(handlers, {
        getKey: getDeepSeekKey,
        setKey: setDeepSeekKey,
        chat: streamChat,
        record: deps.record,
        hasBasic: deps.hasBasic,
        schedule: (fn, ms) => { window.setTimeout(fn, ms); },
      });
    }
    if (!target.ws) return relayCall(target.host, target.port, handlers);
    let current: Link;
    let opened = false;
    let closed = false;
    current = wsCall(target.ws, ['binary'], false, {
      onOpen: (info) => { opened = true; handlers.onOpen(info); },
      onData: (bytes) => handlers.onData(bytes),
      onClose: () => {
        if (!opened && !closed && inPhoneBook(target.host, target.port)) {
          current = relayCall(target.host, target.port, handlers);
        } else {
          handlers.onClose();
        }
      },
    });
    return {
      send: (bytes) => current.send(bytes),
      close: () => { closed = true; current.close(); },
    };
  };
  return withCallSound(dial, (target) => {
    const s = deps.speaker();
    return s.on ? startCallSound(`${target.host}:${target.port}`, s.volume) : undefined;
  });
}

/** The modem's options for the page: dialer, saved AT&W profile, the AI board's number. */
export function modemOptions(deps: LineDeps): ModemOptions & { setup(m: import('../msx/modem').Modem): void } {
  return {
    dialer: makeDialer(deps),
    setup(m) {
      m.services = [{ number: 'DEEPSEEK', name: 'AI board: DeepSeek, your API key' }];
      try {
        const saved = localStorage.getItem(MODEM_PROFILE);
        if (saved) m.loadProfile(JSON.parse(saved));
      } catch {
        /* no saved profile */
      }
      m.onSaveProfile = (profile) => {
        try {
          localStorage.setItem(MODEM_PROFILE, JSON.stringify(profile));
        } catch {
          /* storage blocked */
        }
      };
    },
  };
}
