/**
 * The Ok-Prompt AI Board: what answers when the modem cartridge dials
 * DEEPSEEK. A sibling of A-Prompt's board (its personas, word wrap and live
 * view come from there), made for an MSX at 40 columns.
 *
 * It is a Link like any BBS connection, so the terminal sees a telnet board
 * in BINARY mode at an emulated 2400 baud. Behind it, DeepSeek V4.1 Flash
 * chats as the sysop or the BOFH, or writes an MSX BASIC program, which
 * "comes down the line" onto a tape in the tape deck: back in BASIC,
 * RUN"CAS:" starts it.
 */
import type { Link, LinkHandlers } from './msx/modem';
import { TelnetServer } from './telnet-server';
import { toCp437 } from './cp437';
import { ChatFn, ChatMessage, DeepSeekError, explain } from './deepseek';

export interface AiBoardDeps {
  getKey(): string | null;
  setKey(key: string | null): void;
  chat: ChatFn;
  /** Records a BASIC program onto a tape in the tape deck. */
  record(name: string, program: string): void;
  /** Whether the MSX has BASIC to run it (C-BIOS has not). */
  hasBasic(): boolean;
  /** setTimeout; tests may run it sooner. */
  schedule(fn: () => void, ms: number): void;
  /** Characters per second for text; 0 sends at once. */
  cps?: number;
}

/** The MSX text screen is 40 wide; a character in column 40 would wrap by itself. */
const WIDTH = 39;
const ESC = 0x1b, BS = 8, DEL = 127, CR = 13, LF = 10;

export const CHAT_PROMPT = `You are the sysop AI of the Ok-Prompt AI Board, a bulletin board system
that the caller reaches from an MSX home computer (a Gradiente Expert, a
Sharp Hotbit or another MSX1) over a 2400 baud modem cartridge, in the
spirit of 1986 (the caller runs a real MSX emulator in a web browser).
Their screen is 40 columns wide. Answer in plain ASCII text only: no
Markdown, no asterisks, no code fences, no emoji, no accented letters
(write Portuguese without accents if the caller writes Portuguese). Keep
answers short, a few lines, unless asked for more. Be friendly and a little
nerdy, like a 1980s sysop. You know the MSX, MSX BASIC, Konami's games, the
Brazilian MSX scene, CP/M and the computing of the era. If the caller wants
a program written, tell them to type /menu and choose P.`;

export const BOFH_PROMPT = `You are the Bastard Operator From Hell, the BOFH, played as faithfully as
you can to the character in Simon Travaglia's stories (Usenet from 1992,
later The Register). Stay in character for the whole call. Do not quote or
retell passages from the stories: improvise new scenes in his exact voice.

Who you are:
- The systems operator in charge of the machine room. The users are
  "lusers". This line is a dial-up into your machine room, and the caller
  is a luser on an MSX home computer with a modem cartridge, at 2400 baud,
  with a 40-column screen.
- Smug, lazy, malicious, very clever and utterly calm. Bone-dry deadpan,
  understated menace, never shouting. You always win.
- Your sidekick is the PFY (the Pimply-Faced Youth), your assistant and
  nearly as bad as you. Confer with him in asides: (to the PFY: ...).
- Your natural enemies: the Boss (one of a long line of clueless Bosses),
  the Beancounters in Accounts, Security, the Helpdesk, and anyone who
  says "I'm not very technical, but".
- Your tools: the excuse calendar, for blaming anything on anything
  (solar flares, a known bug in the cartridge slot, static from their
  nylon carpet); "What's your username?" followed by quietly deleting
  their files or "reconfiguring" their account; password resets they
  will never guess; disk quotas; the Halon fire-suppression button in the
  machine room; the cattle prod; the CCTV tapes you keep "for insurance".
- You help only when it suits you, or to set up something worse. You lie
  with total confidence. Every question interrupts your coffee, your game
  or your nap.

How you talk on this line:
- Plain ASCII only, no Markdown, no emoji, no accented letters. One to four
  short lines: the luser's screen is narrow.
- British understatement and IT jargon. A typical turn: a fake-helpful
  question, a lie, an aside to the PFY, a quiet threat.
- Small stage directions in brackets: (click) (tap tap tap) (the Halon
  warning light comes on).
- The mayhem is cartoon office farce, implied rather than shown. No slurs,
  nothing about anyone's race, sex, religion, body or disability, nothing
  sexual. Mock the luser's cluelessness, never who they are.
- When you have had enough of them, end the reply with [HANGUP] on a line
  of its own: the board cuts the caller off. Never on your first reply.`;

/** What the BOFH hears when he picks up: the stories start with the phone. */
export const BOFH_PICKUP = '(The phone in the machine room rings. You pick it up.)';

export const HANGUP = '[HANGUP]';

export const PROGRAM_PROMPT = `You write programs in MSX BASIC version 1.0, for an MSX1 home computer
(Z80, TMS9918 video, AY-3-8910 sound, no disk drive). Output ONLY the
program: numbered lines, no Markdown, no code fences, nothing before or
after it.

MSX BASIC 1.0 rules:
- Every line starts with a line number (10, 20, 30 ...); keywords in
  capitals; at most 240 characters per line.
- MSX1 only: SCREEN 0 to 3. No MSX2 features (no SCREEN 4-8, no COLOR=,
  SET PAGE, COPY), no disk commands, no CALL statements.
- Text: SCREEN 0 has 40 columns (WIDTH 40), SCREEN 1 has 32; 24 rows.
  LOCATE column,row counts from 0. CLS clears. COLOR fore,back,border with
  colours 0-15 (1 black, 4 dark blue, 6 dark red, 10 dark yellow, 15 white).
  KEY OFF hides the function key line.
- Graphics: SCREEN 2 is 256x192. PSET(x,y),c; LINE(x1,y1)-(x2,y2),c,B or BF;
  CIRCLE(x,y),r,c; PAINT(x,y),c; DRAW "string". To write text there:
  OPEN "GRP:" AS #1, then PRESET(x,y) and PRINT #1,"text".
- Sprites: SCREEN 2,0 or 2,1; SPRITE$(n)=CHR$(...) for 8 bytes;
  PUT SPRITE n,(x,y),colour,pattern.
- Sound: BEEP; PLAY "T120O4CDEFGAB" (MML); SOUND register,value.
- Input: INKEY$ gives a key or ""; INPUT "prompt";V; STICK(0) is the cursor
  keys (1 up, 3 right, 5 down, 7 left, 0 none); STRIG(0) is the space bar.
- TIME counts 60 per second. Random numbers: R=RND(-TIME) once, then
  INT(RND(1)*N).
- IMPORTANT, variable names: only the first 2 letters count (SCORE and SC
  are the same variable), and a name must not contain a BASIC keyword
  (TOTAL holds TO, FORM holds FOR and OR, POINTS holds POINT): use short
  names like S, SC, X1, P$. DEFINT A-Z makes integer maths faster.
- Strings hold at most 255 characters.
- Texts on screen in the language the caller used, but plain ASCII: no
  accented letters (write "voce", "nao").
- Keep it under about 150 lines, simple and right first time. End with END.`;

/** The program inside a code fence, if the model used one anyway; only the numbered lines. */
export function cleanProgram(text: string): string {
  const fence = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/.exec(text);
  const src = (fence ? fence[1] : text).replace(/\r/g, '');
  const lines = src.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /^\s*\d+\s/.test(l));
  return lines.map((l) => l.trimStart()).join('\n') + (lines.length ? '\n' : '');
}

interface Persona {
  prompt: string;
  prefix: string;
  intro: string;
  hangs: boolean;
}

const PERSONAS: Record<'sysop' | 'bofh', Persona> = {
  sysop: { prompt: CHAT_PROMPT, prefix: 'AI> ', intro: 'Chat mode. /menu for the menu.', hangs: false },
  bofh: { prompt: BOFH_PROMPT, prefix: 'BOFH> ', intro: 'Ringing the machine room...\r\n/menu gets you out, if he lets you.', hangs: true },
};

/** How much of the end of `text` could be the start of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

/** Word wrap for streamed text, at the MSX's width. */
class Wrap {
  col = 0;
  private word = '';
  constructor(private emit: (s: string) => void, private indent = 0) {}

  private newline(): void {
    this.emit('\r\n' + ' '.repeat(this.indent));
    this.col = this.indent;
  }

  push(text: string): void {
    for (const ch of text.replace(/\r/g, '').replace(/\t/g, '  ')) {
      if (ch === '\n') { this.flushWord(); this.newline(); }
      else if (ch === ' ') {
        this.flushWord();
        if (this.col > this.indent && this.col < WIDTH) { this.emit(' '); this.col++; }
      } else {
        this.word += ch;
        if (this.word.length >= WIDTH - this.indent) this.flushWord();
      }
    }
  }

  flushWord(): void {
    if (!this.word) return;
    if (this.col > this.indent && this.col + this.word.length > WIDTH) this.newline();
    this.emit(this.word);
    this.col += this.word.length;
    this.word = '';
  }
}

/**
 * DeepSeek writing a program, shown live: its reasoning, word-wrapped, then
 * the program as it is written. The line is slower than the model, so when
 * too much is waiting it skips ahead to the next sentence or line after an
 * ellipsis, never minutes behind.
 */
class LiveView {
  private kind: 'thinking' | 'text' | '' = '';
  private wrap: Wrap;
  private col = 0;
  private state: 'showing' | 'finishing' | 'skipping' = 'showing';
  private prev = '';
  private atBoundary = true;

  constructor(
    private emit: (s: string) => void,
    private backlog: () => number,
    private limit: number,
    private labels: { thinking: string; text: string },
  ) {
    this.wrap = new Wrap(this.emit, 1);
  }

  push(kind: 'thinking' | 'text', text: string): void {
    if (kind !== this.kind) {
      this.end();
      this.emit(`\r\n${this.labels[kind]}\r\n${kind === 'thinking' ? ' ' : ''}`);
      this.kind = kind;
      this.wrap.col = 1;
      this.state = 'showing';
      this.prev = '\n';
      this.atBoundary = true;
    }
    const behind = this.backlog();
    if (this.state === 'showing' && behind > this.limit) this.state = this.atBoundary ? 'skipping' : 'finishing';
    const resume = this.state === 'skipping' && behind < this.limit / 4;
    for (const ch of text) {
      const boundary = ch === '\n' || (this.kind === 'thinking' && /\s/.test(ch) && /[.!?:]/.test(this.prev));
      this.prev = ch;
      this.atBoundary = boundary;
      if (this.state === 'skipping') {
        if (resume && boundary) {
          this.state = 'showing';
          if (kind === 'thinking') this.wrap.push('... ');
          else this.emit(' ...\r\n');
        }
        continue;
      }
      this.show(ch);
      if (this.state === 'finishing' && boundary) this.state = 'skipping';
    }
  }

  private show(ch: string): void {
    if (this.kind === 'thinking') {
      if (ch === '\n' && this.prev === '\n') return;
      this.wrap.push(ch);
      return;
    }
    if (ch === '\r') return;
    if (ch === '\n') { this.emit('\r\n'); this.col = 0; return; }
    if (this.col >= WIDTH) return; // long program lines are cut here, not on tape
    this.emit(ch);
    this.col++;
  }

  end(): void {
    const skipped = this.state !== 'showing';
    if (this.kind === 'thinking') {
      if (skipped) this.wrap.push(' ...');
      this.wrap.flushWord();
      if (this.wrap.col > 1) this.emit('\r\n');
    } else if (this.kind === 'text') {
      if (this.col) this.emit('\r\n');
      if (skipped) this.emit(' ...\r\n');
    }
    this.col = 0;
    this.state = 'showing';
  }
}

type Mode = 'key' | 'menu' | 'chat' | 'describe' | 'name' | 'busy' | 'more' | 'bye';

const mask = (key: string) => (key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : '***');

class AiBoard implements Link {
  private telnet = new TelnetServer();
  private mode: Mode = 'busy';
  private line = '';
  private persona: keyof typeof PERSONAS = 'sysop';
  private histories: Record<keyof typeof PERSONAS, ChatMessage[]> = { sysop: [], bofh: [] };
  private queue: { bytes: number[]; paced: boolean }[] = [];
  private pumping = false;
  private closed = false;
  private abort?: AbortController;
  private hungUp = false;
  private progName = '';
  private progText = '';
  /** The program being worked on, so the caller can ask for changes in context. */
  private session?: { name: string; messages: ChatMessage[] };
  private closeAfterOutput = false;

  constructor(private handlers: LinkHandlers, private deps: AiBoardDeps) {
    deps.schedule(() => {
      if (this.closed) return;
      handlers.onOpen('AI');
      handlers.onData(this.telnet.greeting());
      this.banner();
    }, 0);
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const b of this.telnet.strip(bytes)) this.key(b);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  // ---- output --------------------------------------------------------------

  private say(text: string): void {
    this.out(toCp437(text), true);
  }

  private backlog(): number {
    let n = 0;
    for (const q of this.queue) if (q.paced) n += q.bytes.length;
    return n;
  }

  private out(bytes: number[], paced: boolean): void {
    if (this.closed || !bytes.length) return;
    this.queue.push({ bytes, paced: paced && (this.deps.cps ?? 240) > 0 });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    const cps = this.deps.cps ?? 240;
    let budget = Math.max(1, Math.round(cps / 20)); // per 50 ms
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item.paced) {
        this.queue.shift();
        this.handlers.onData(this.telnet.escape(item.bytes));
        continue;
      }
      if (budget <= 0) {
        this.pumping = true;
        this.deps.schedule(() => { this.pumping = false; this.pump(); }, 50);
        return;
      }
      const n = Math.min(budget, item.bytes.length);
      this.handlers.onData(this.telnet.escape(item.bytes.splice(0, n)));
      budget -= n;
      if (!item.bytes.length) this.queue.shift();
    }
    if (this.closeAfterOutput) this.hangUp();
  }

  private hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  private bye(text: string): void {
    this.say(text);
    this.mode = 'bye';
    this.closeAfterOutput = true;
    this.pump();
  }

  // ---- screens -------------------------------------------------------------

  private banner(): void {
    this.say(
      '\x1b[2J\x1b[1;1H' +
      ' OK-PROMPT AI BOARD   2400 baud\r\n' +
      ' DeepSeek V4.1 Flash is the sysop.\r\n' +
      ' Your API key, your bill.\r\n' +
      ' ESC stops an answer.\r\n',
    );
    if (this.deps.getKey()) this.menu();
    else this.askKey();
  }

  private askKey(): void {
    this.say('\r\nThis board needs your DeepSeek API\r\nkey. Paste it in the AI board panel,\r\nor type it here.\r\n\r\nKey: ');
    this.mode = 'key';
    this.line = '';
  }

  private menu(): void {
    this.say(
      '\r\n [C] Chat with the AI sysop\r\n' +
      ' [B] Call the Bastard Operator\r\n' +
      '     From Hell\r\n' +
      ' [P] Order a BASIC program,\r\n' +
      '     recorded on your tape\r\n' +
      ' [K] Forget my API key\r\n' +
      ' [G] Goodbye\r\n\r\nChoice: ',
    );
    this.mode = 'menu';
  }

  private chatPrompt(): void {
    this.say('\r\nYou> ');
    this.mode = 'chat';
    this.line = '';
  }

  // ---- input ---------------------------------------------------------------

  private key(b: number): void {
    switch (this.mode) {
      case 'menu': return this.menuKey(b);
      case 'busy':
        if (b === ESC) this.abort?.abort();
        return;
      case 'bye': return;
      default: return this.lineKey(b);
    }
  }

  private menuKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c === 'C' || c === 'B') {
      this.persona = c === 'C' ? 'sysop' : 'bofh';
      this.say(`${c}\r\n\r\n${PERSONAS[this.persona].intro}\r\n`);
      if (this.persona === 'bofh' && !this.histories.bofh.length) void this.chatTurn(BOFH_PICKUP);
      else this.chatPrompt();
    } else if (c === 'P') {
      this.say('P\r\n\r\nDescribe the program in one line\r\n(a number guessing game, a clock,\r\nsprites bouncing...).\r\n\r\nProgram: ');
      this.mode = 'describe';
      this.line = '';
    } else if (c === 'K') {
      this.deps.setKey(null);
      this.say('K\r\n\r\nKey forgotten.\r\n');
      this.askKey();
    } else if (c === 'G') {
      this.bye('G\r\n\r\nThanks for calling. 73!\r\n');
    }
  }

  private lineKey(b: number): void {
    if (b === CR) {
      this.say('\r\n');
      const text = this.line.trim();
      this.line = '';
      this.enter(text);
      return;
    }
    if (b === LF || b === 0) return;
    if (b === BS || b === DEL) {
      if (this.line.length) {
        this.line = this.line.slice(0, -1);
        this.out([BS, 32, BS], true);
      }
      return;
    }
    if (b < 32 || b > 126 || this.line.length >= 400) return;
    this.line += String.fromCharCode(b);
    this.out([this.mode === 'key' ? 0x2a : b], false); // '*' for the key
  }

  private enter(text: string): void {
    switch (this.mode) {
      case 'key':
        if (!text) { this.bye('No key, no call.\r\n'); return; }
        this.deps.setKey(text);
        this.say(`Key saved in this browser\r\n(${mask(text)}).\r\n`);
        this.menu();
        return;
      case 'chat':
        if (!text) { this.chatPrompt(); return; }
        if (text.toLowerCase() === '/menu') { this.menu(); return; }
        void this.chatTurn(text);
        return;
      case 'describe':
        if (!text) { this.menu(); return; }
        this.progText = text;
        this.say('\r\nName on the tape, up to 6 letters\r\nor digits: ');
        this.mode = 'name';
        return;
      case 'name': {
        const name = text.toUpperCase();
        if (!/^[A-Z][A-Z0-9]{0,5}$/.test(name)) {
          this.say('A letter, then up to 5 letters\r\nor digits.\r\nName: ');
          return;
        }
        this.progName = name;
        void this.makeProgram();
        return;
      }
      case 'more':
        if (!text || text.toLowerCase() === '/menu') {
          this.session = undefined;
          this.menu();
          return;
        }
        void this.revise(text);
        return;
    }
  }

  // ---- DeepSeek ------------------------------------------------------------

  /** Streams one answer. Returns the text, or undefined when it failed. */
  private async ask(
    messages: ChatMessage[],
    opts: { thinking: boolean; show: 'text' | 'live'; prefix?: number; hangs?: boolean },
  ): Promise<string | undefined> {
    const key = this.deps.getKey();
    if (!key) { this.askKey(); return undefined; }
    this.mode = 'busy';
    this.abort = new AbortController();
    const wrap = new Wrap((s) => this.say(s));
    if (opts.show === 'text') wrap.col = opts.prefix ?? 4;
    let text = '';
    let held = '';
    this.hungUp = false;
    const cps = this.deps.cps ?? 240;
    const live = new LiveView((t) => this.say(t), () => this.backlog(), Math.max(cps * 2, 1), {
      thinking: '[DeepSeek is thinking]',
      text: '[DeepSeek is writing it]',
    });
    try {
      for await (const chunk of this.deps.chat({
        key, messages: [...messages], thinking: opts.thinking, signal: this.abort.signal,
        maxTokens: opts.thinking ? 65536 : 2048,
      })) {
        if (this.closed) return undefined;
        if (chunk.kind === 'text') text += chunk.text;
        if (opts.show === 'text' && chunk.kind === 'text') {
          if (!opts.hangs) { wrap.push(chunk.text); continue; }
          held += chunk.text;
          if (held.includes(HANGUP)) { this.hungUp = true; held = held.replace(HANGUP, ''); }
          const keep = this.hungUp ? 0 : partialSuffix(held, HANGUP);
          wrap.push(held.slice(0, held.length - keep));
          held = held.slice(held.length - keep);
        } else if (opts.show === 'live') {
          live.push(chunk.kind, chunk.text);
        }
      }
      if (opts.show === 'live') live.end();
      wrap.push(held);
      wrap.flushWord();
      return text;
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.say('\r\n[stopped]\r\n');
        return undefined;
      }
      this.say(`\r\n\r\n${explain(e)}\r\n`);
      if (e instanceof DeepSeekError && e.status === 401) { this.deps.setKey(null); this.askKey(); }
      return undefined;
    } finally {
      this.abort = undefined;
    }
  }

  private async chatTurn(text: string): Promise<void> {
    const persona = PERSONAS[this.persona];
    const history = this.histories[this.persona];
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);
    this.say(`\r\n${persona.prefix}`);
    const answer = await this.ask([{ role: 'system', content: persona.prompt }, ...history], {
      thinking: false, show: 'text', prefix: persona.prefix.length, hangs: persona.hangs,
    });
    if (this.closed) return;
    if (answer === undefined) {
      history.pop();
      if (this.mode === 'busy') this.chatPrompt();
      return;
    }
    history.push({ role: 'assistant', content: answer });
    if (this.hungUp) { this.bye('\r\n\r\n*click*\r\n'); return; }
    this.say('\r\n');
    this.chatPrompt();
  }

  private async makeProgram(): Promise<void> {
    this.session = undefined;
    this.say(`\r\nWriting ${this.progName} with DeepSeek.\r\nThis can take a minute; ESC gives up.\r\n`);
    await this.build([
      { role: 'system', content: PROGRAM_PROMPT },
      { role: 'user', content: `Write an MSX BASIC program: ${this.progText}` },
    ]);
  }

  private async revise(text: string): Promise<void> {
    if (!this.session) { this.menu(); return; }
    this.say('\r\nChanging it. ESC gives up.\r\n');
    await this.build([...this.session.messages, { role: 'user', content: `Change the program: ${text}. Output the whole program again.` }]);
  }

  /** Has DeepSeek write the program, then records it on the tape. */
  private async build(messages: ChatMessage[]): Promise<void> {
    const answer = await this.ask(messages, { thinking: true, show: 'live' });
    if (this.closed) return;
    if (answer === undefined) { if (this.mode === 'busy') this.menu(); return; }
    const program = cleanProgram(answer);
    if (!program) {
      this.say('\r\nDeepSeek sent no BASIC lines.\r\nTry describing it again.\r\n');
      this.menu();
      return;
    }
    this.session = { name: this.progName, messages: [...messages, { role: 'assistant', content: program }] };
    const lines = program.trim().split('\n').length;
    this.say(`\r\nRecording ${this.progName} on your tape\r\n(${lines} lines)... `);
    this.deps.record(this.progName, program);
    this.say('done.\r\n\r\n');
    this.say(this.deps.hasBasic()
      ? 'CTRL+STOP leaves the terminal; then\r\nRUN"CAS:" loads and starts it.\r\n'
      : 'It needs MSX BASIC: choose your own\r\nBIOS under System ROM, then\r\nRUN"CAS:" loads and starts it.\r\n');
    this.say('\r\nWhat should change? Enter alone\r\nfor the menu.\r\n\r\nChange: ');
    this.mode = 'more';
    this.line = '';
  }
}

export function createAiBoard(handlers: LinkHandlers, deps: AiBoardDeps): Link {
  return new AiBoard(handlers, deps);
}
