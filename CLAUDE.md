# Ok-Prompt — notes for Claude

MSX1 emulator for the browser in TypeScript. Static site (Vite). Sibling of
A-Prompt (`~/cpm`, CP/M), whose Z80 core it uses. Game-like UI: the monitor
in the centre, the cartridge deck under it, panels on both sides.

## Commands

```bash
npm run dev                      # http://localhost:5173
npm test                         # vitest (zex tests skipped)
npx tsc --noEmit                 # typecheck (npm run build also runs it)
npm run build                    # static site in dist/
npm run deploy                   # build + wrangler deploy to ok-prompt.stern.workers.dev
npm run okmodem                  # reassemble src/roms/okmodem.asm into okmodem.rom (commit both)
npx tsc -p worker                # typecheck the relay Worker (npm run build runs it)
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~2.5 min
MSX_BIOS=~/Downloads/expert_1.1_basic-bios1.rom npx vitest run tests/real-bios.test.ts
                                 # MSX BASIC from a real BIOS dump (never in the repo)
```

Run `npx tsc --noEmit` and `npm test` before every commit. Rerun the zex
exerciser after any change to `src/z80.ts`.

## Workflow

- Commit straight to `main` (single-developer repo); push only when the user
  says so. Commit style: `feat:`, `fix:`, `docs:` with a body that says why.
- Every bug fix gets a regression test that fails on the old code.

## Layout

| Path | Role |
| --- | --- |
| `src/z80.ts` | Z80 from A-Prompt; memory through `read`/`write`, EI delay, `interrupt()` returns whether taken |
| `src/msx/machine.ts` | The MSX1: wiring, ports, `runFrame()` (262/313 lines of 228 cycles) |
| `src/msx/slots.ts` | Primary slots, `Rom`, `Ram`, `EMPTY` |
| `src/msx/cartridge.ts` | Plain and MegaROM mappers, `guessMapper` |
| `src/msx/vdp.ts` | TMS9918A, `renderLine` per picture line, `vblank` |
| `src/msx/psg.ts` | AY-3-8910, `advanceTo(cycles)`, joystick on R14 |
| `src/msx/scc.ts` | Konami SCC wave chip, owned by `konamiscc` cartridges, mixed in `Msx.takeAudio()` |
| `src/msx/tape.ts` | `.cas` images: block markers, read/write, first file's kind and load command |
| `src/msx/modem.ts`, `modem-cart.ts` | A-Prompt's Hayes modem; the cartridge puts it on ports 04h/05h |
| `src/roms/okmodem.asm` | The modem cartridge's Z80 terminal (CALL TERM, ANSI to the MSX screen, CP437 table) |
| `scripts/z80asm.ts`, `build-okmodem.ts` | Our Z80 assembler; the ROM build, CP437 box table found from the font |
| `src/aiboard.ts`, `src/deepseek.ts` | The AI board behind ATDT DEEPSEEK; programs go to tape (`asciiCas`) |
| `src/ui/modem-line.ts`, `call-sound.ts`, `modem-audio.ts` | Dialing (WebSocket gateway or /relay), call sounds, DeepSeek key |
| `worker/` | The relay Worker: /relay WebSocket to telnet, phone book only (`src/phonebook.ts`) |
| `src/msx/ppi.ts` | 8255: slot register, keyboard rows, click |
| `src/msx/keyboard.ts` | PC `KeyboardEvent.code` to the MSX matrix |
| `src/main.ts` | Page wiring, frame loop, cartridges, keys, gamepad |
| `history.html`, `src/history.css` | The MSX history page (second Vite entry); facts sourced or measured on real ROMs |
| `src/ui/` | Audio, power switch (from A-Prompt), sound output, IndexedDB store (slots, shelf, own BIOS), confirm dialog |
| `src/roms/` | C-BIOS MSX1 main and logo ROMs, with their licence |

## MSX facts that are easy to get wrong

- Slots: port A8h picks a slot per 16K page; the BIOS runs from slot 0 and
  switches pages to scan cartridges (header `AB` at 4000h or 8000h).
- The VDP holds the interrupt line until the status register (99h) is read;
  the machine retries `cpu.interrupt()` each instruction while `vdp.irq`.
- VDP control port: two writes; the second with bit 7 set is a register
  write, else an address (bit 6 = write mode). Read mode pre-fetches a byte.
- C-BIOS uses SCREEN 1 (Graphics I) with names at 1800h; find text in VRAM
  through register 2, not at 0000h.
- PSG tone frequency is clock / (16 x period) with clock = CPU / 2.
- The SCC appears at 9800h-9FFFh only while 3Fh is in the 8000h bank
  register (written at 9000h); its frequency is CPU / (32 x (period + 1)).
- Tapes: the machine traps the BIOS tape entries 00E1h-00F3h (only while
  slot 0 is at page 0) and RETs itself. `Msx.type()` writes into the key
  buffer (FBF0h, PUTPNT/GETPNT) when the program next calls CHGET (009Fh).
- MSX BASIC calls CHGET's body (the JP target at 009Fh, 10CBh in Microsoft
  BIOSes), not 009Fh; the machine traps both.
- Key tables: six 48-byte tables (plain, SHIFT, GRAPH, GRAPH+SHIFT, CODE,
  CODE+SHIFT) found by "0123456789" (0DA5h in Microsoft BIOSes). C-BIOS
  decodes only plain and SHIFT. The Expert 1.0 font (CGTABL at 0004h) has
  ç/Ç on 60h/7Eh and tilde letters on the umlaut codes (`detectCharset`).
- BBSes probe the terminal (ESC[6n, ESC _ strings) as soon as the
  connection opens: the call sound plays the whole call, handshake
  included, before connecting and holds nothing after, or the answers come
  too late and the board goes DUMB. Same code as A-Prompt and K-Prompt.
- MSX ASCII tapes: header EAh x 10 + name, then 256-byte blocks, CR LF
  lines, 1Ah padding (asciiCas matches the Expert's SAVE"CAS:" exactly).
- C-BIOS only starts cartridges: no BASIC, no disk. MSX BASIC and MSX-DOS
  ROMs are copyrighted; never add them to the repo.

## Testing tips

- `tests/msx.test.ts` boots C-BIOS headless; `helloCart()` builds a 16K
  cartridge that prints through the BIOS's CHPUT.
- Browser checks: `npm run build`, `npx vite preview --port 4180`, then
  `playwright-cli` from the scratchpad. A fresh page waits at the power
  switch: press a key, or set localStorage `ok-prompt.settings` to
  `{"autoPower":true}`.
