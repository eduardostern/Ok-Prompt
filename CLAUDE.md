# Ok-Prompt — notes for Claude

MSX1, MSX2 and MSX2+ emulator for the browser in TypeScript. Static site (Vite). Sibling of
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
                                 # MSX BASIC from a real BIOS dump (never in the repo);
                                 # add MSX_DISKROM=<disk ROM dump> for the Disk BASIC test
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
| `src/msx/vdp.ts` | TMS9918A (MSX1), `renderLine` per picture line, `vblank` |
| `src/msx/v9938.ts`, `v9938-cmd.ts` | V9938/V9958 (MSX2/2+) and its command engine; `docs/v9938.md` is the spec they follow |
| `src/msx/video.ts` | `VideoChip`, what the machine needs from either chip |
| `src/msx/mapper.ts`, `rtc.ts` | MSX2 memory mapper (ports FCh-FFh) and RP5C01 clock (B4h/B5h); `ExpandedSlot` is in slots.ts |
| `src/msx/psg.ts` | AY-3-8910, `advanceTo(cycles)`, joystick on R14 |
| `src/msx/scc.ts` | Konami SCC wave chip, owned by `konamiscc` cartridges, mixed in `Msx.takeAudio()` |
| `src/msx/tape.ts`, `tape-signal.ts` | `.cas`/`.tsx` tapes: block markers, read/write for the BIOS traps, first file's kind and load command; the pulse timeline played on the cassette input |
| `src/msx/disk.ts` | `.dsk` images, the disk ROM's slot (idle Philips FDC), DPBs, blank disks; the machine traps the ROM's jump table |
| `src/msx/ym2413.ts`, `music-rom.ts` | MSX-MUSIC: emu2413 port (MIT) on 7Ch/7Dh; our ROM with "APRLOPLL" for slot 3-3 |
| `src/msx/printer.ts`, `mouse.ts` | Printer port 90h/91h; the MSX mouse on a joystick port |
| `src/msx/state.ts` | Save states: `grab`/`put` copy each chip's plain data; `Msx.saveState`/`loadState` |
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
- The model comes from the main ROM's byte 002Dh (`biosModel`): MSX2/2+
  get C-BIOS's layout (main + logo in slot 0, SUB-ROM 3-0, 512K mapper 3-2),
  a V9938/V9958 (576x240 frame) and the BIOS's own 50/60 Hz (R#9 NT).
- V9938: the first control byte does not touch the address (unlike the
  TMS9918A); R#14 carries only with M4/M5 set; GRAPHIC6/7 interleave VRAM
  (physical = (L<<16 | L>>1) & 1FFFFh) for the CPU, commands and picture.
  Commands run at once; HMMC/LMMC take a pre-written R#44 as the first datum.
- Slot 3: MSX1 64K RAM; expanded (RAM 3-0) when a disk ROM (3-1) or
  MSX-MUSIC (3-3) is on; MSX2 SUB-ROM 3-0, mapper 3-2. Real BIOSes find
  their RAM in an expanded slot (tested: same free bytes).
- Disk: the machine traps 4010h DSKIO, 4013h DSKCHG, 4016h GETDPB, 401Ch
  DSKFMT while page 1 is slot 3-1; sectors bound for page 1 go to the RAM
  of page 3's slot. DSKIO returns B = sectors not done (0 on success).
- Tape signal: plays only while the PPI motor bit (port C bit 4) is 0;
  traps and signal share one place (`Tape.toBytes`/`level`). R14 bit 7.
- MSX-MUSIC detection is the string "APRLOPLL" at 4018h of some slot.
- The mouse answers PSG R15 pin 8 changes (bit 4 port 1): X hi, X lo,
  Y hi, Y lo; a pause over ~1 ms starts a new read; right/down negative.
- C-BIOS only starts cartridges: no BASIC, no disk. MSX BASIC and MSX-DOS
  ROMs are copyrighted; never add them to the repo.

## Testing tips

- `tests/msx.test.ts` boots C-BIOS headless; `helloCart()` builds a 16K
  cartridge that prints through the BIOS's CHPUT.
- Browser checks: `npm run build`, `npx vite preview --port 4180`, then
  `playwright-cli` from the scratchpad. A fresh page waits at the power
  switch: press a key, or set localStorage `ok-prompt.settings` to
  `{"autoPower":true}`.
