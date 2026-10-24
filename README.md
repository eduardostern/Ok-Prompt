# Ok-Prompt

**An MSX in your browser. Drop in a cartridge and play.**
Live at **https://ok-prompt.stern.workers.dev**.

Ok-Prompt is an MSX1, MSX2 and MSX2+ emulator in TypeScript: a Z80 at
3.58 MHz, the TMS9918A video chip (and on MSX2 the V9938, on MSX2+ the
V9958), the AY-3-8910 sound chip, the 8255 PPI with the keyboard, and the
MSX slot system with cartridges. It boots
[C-BIOS](http://cbios.sourceforge.net/), the free MSX BIOS, so nothing
copyrighted ships with it: plug in a game ROM and it starts.

The name comes from MSX BASIC, which answers every command with `Ok`, as
[A-Prompt](https://a-prompt.stern.workers.dev), its CP/M sibling, is named
after `A>`. The Z80 core comes from A-Prompt, where zexdoc and zexall pass.
[K-Prompt](https://k-prompt.stern.workers.dev), the third sibling, runs it as a
ZX Spectrum, with Brazil's TK90X and TK95, and is named after the Spectrum's
K cursor.

A [history page](https://ok-prompt.stern.workers.dev/history.html) tells
where MSX came from, how an MSX1 works, Brazil's Gradiente Expert and Sharp
Hotbit (with what changed between Expert 1.0 and 1.1, measured on the
original ROMs), and how MSX-DOS met CP/M.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest; ZEX=1 npx vitest run tests/zex.test.ts for the Z80 exercisers
npm run build      # static site in dist/
npm run deploy     # build and publish to ok-prompt.stern.workers.dev (Cloudflare)
```

## Playing

- Press a key or click the screen to power on (browsers allow sound only
  after that). *Power on by itself* skips it.
- Drop a `.rom` (or a `.zip` with one inside) anywhere on the page, or
  click a cartridge slot. Slots are remembered in this browser.
- Every ROM you load stays on the shelf under the slots: click it to put
  it back in slot 1, or on its 2 for slot 2.
- *System ROM* picks the machine: C-BIOS MSX1, MSX2 or MSX2+ (built in),
  or BIOS dumps of your own to boot into MSX BASIC: a 32K ROM such as the
  Gradiente Expert's, or for an MSX2 its main ROM and SUB-ROM together (two
  files or a zip). They stay in your browser; Ok-Prompt never ships
  copyrighted ROMs. On an MSX2 the modem terminal shows 80 columns.
- Tapes (`.cas` or `.tsx`) go in the tape deck under the slots. With your
  own BIOS, *Load* resets the MSX and types `BLOAD"CAS:",R`, `CLOAD` or
  `RUN"CAS:"` for you. *Blank* gives a tape to `CSAVE` on; download it
  with ⤓. While the motor runs the tape also plays as a signal, so games
  with their own (turbo) loaders load too; a `.tsx` keeps its own timing.
- The disk drive: load a disk ROM of your own (16K, from a real drive or
  MSX) under *Disk drive*; a drive appears under the tape deck. Drop a
  `.dsk` on the page or click the drive; *Blank* gives an empty 720K disk;
  ⤓ downloads it with what was written. With MSX BASIC the MSX boots Disk
  BASIC or MSX-DOS from the disk.
- *FM sound* (Sound panel) puts MSX-MUSIC in the machine: games that know
  it play their FM music.
- *Save states* (Machine panel): four slots that keep everything, to come
  back to later.
- *Paste text* (or ⌘V) types your clipboard into the MSX: a BASIC listing
  becomes a program. `LPRINT` and `LLIST` print to the *Printer* panel.
- *Joystick port 1* can hold an MSX mouse: click the screen to take the
  pointer, Esc to give it back.
- The modem: put **☎ Ok-Modem** from the shelf in a slot; type `CALL TERM`
  in BASIC (with C-BIOS it starts by itself). `ATI` lists the BBSes,
  `ATDT 1` calls one, `ATDT DEEPSEEK` calls the AI board (your DeepSeek API
  key): chat with the sysop or the BOFH, or order a BASIC program that
  arrives on your tape for `RUN"CAS:"`. CTRL+STOP goes back to BASIC.
- The bank-switching scheme of big cartridges is guessed from the code;
  change it under the cartridge if a game does not start.
- Keys type what is printed on your PC keyboard: symbols and accents go
  through the key table of the BIOS in use, so a Brazilian PC keyboard
  types ç, ã and " correctly on a Gradiente Expert (1.0's own character set
  included). Letters, arrows and Space keep their MSX places for games; the
  Keyboard setting can put every key back in place. GRAPH is left Alt,
  CODE right Alt, STOP F7, SELECT F8, F6-F10 are Shift + F1-F5. The
  numeric keypad is the MSX's. A gamepad is joystick 1.

## What is emulated

| Part | State |
| --- | --- |
| Z80 | Complete, Zilog timing, interrupt modes 0-2 and NMI, the EI delay |
| Slots | Four primary slots: BIOS, two cartridge ports, 64K RAM; slot 3 expanded on MSX2 (SUB-ROM in 3-0, a 512K memory mapper in 3-2) and wherever there is a disk ROM (3-1) or MSX-MUSIC (3-3) |
| V9938 / V9958 | MSX2 and MSX2+ video: 128K VRAM, palette, all ten modes (TEXT2 80 columns, SCREEN 5-8, YJK SCREEN 10-12), sprites mode 2, line interrupts, scroll, the command engine with its timing (spec in `docs/v9938.md`) |
| RTC | The MSX2's RP5C01 clock, its settings memory kept in the browser |
| TMS9918A | Graphics I and II, multicolour, text; sprites with the 4-per-line limit, 5S and collision flags; drawn a line at a time |
| AY-3-8910 | Three tones, noise, envelope, joystick ports (gamepad or MSX mouse), cassette input; rendered in step with CPU time |
| YM2413 | MSX-MUSIC: a port of emu2413 (MIT), with our own small ROM that games find it by |
| PPI | Slot select, keyboard matrix with the numeric keypad, CAPS lamp, key click, cassette motor |
| Cartridges | Plain ROMs up to 64K; Konami, Konami SCC, ASCII 8K and 16K MegaROMs; ASCII with battery RAM (saves kept) |
| Cassette | `.cas` and `.tsx` tapes: through the BIOS tape routines (load, record, download) and as a signal for custom loaders |
| Disk | Drive A with your own disk ROM: its jump table done on `.dsk` images, so any controller's ROM works |
| Printer | The printer port; LPRINT/LLIST to a panel, downloadable |
| Save states | Everything, four slots in the browser |
| Modem | Ok-Modem cartridge: a Hayes modem on ports 04h/05h (A-Prompt's), a Z80 terminal in its ROM, real BBSes and the DeepSeek AI board |
| SCC | Konami's five-channel wave-table chip in SCC cartridges, mixed with the PSG |

## Next

- MSX turbo R (R800, PCM), Japanese machines (Kanji ROM).
- A second disk drive, touch controls, a WebGL CRT shader.

## Credits and licence

- Ok-Prompt: MIT, © 2026 Eduardo Stern (`LICENSE`). The Z80 core and the
  power switch come from A-Prompt.
- C-BIOS 0.29: BSD-style licence, `src/roms/C-BIOS-LICENSE.txt`.
- emu2413 by Mitsutaka Okazaki (MIT), ported in `src/msx/ym2413.ts`.
- zexdoc/zexall: Frank Cringle's public-domain Z80 exercisers.
- MSX is a trademark of MSX Licensing Corporation; Ok-Prompt is not
  affiliated with it.
