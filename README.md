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
- Tapes (`.cas`) go in the tape deck under the slots. With your own BIOS,
  *Load* resets the MSX and types `BLOAD"CAS:",R`, `CLOAD` or `RUN"CAS:"`
  for you. *Blank* gives a tape to `CSAVE` on; download it with ⤓. Games
  with their own turbo loaders do not load this way.
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
  CODE right Alt, STOP F7, SELECT F8, F6-F10 are Shift + F1-F5. A gamepad
  is joystick 1.

## What is emulated

| Part | State |
| --- | --- |
| Z80 | Complete, Zilog timing, interrupt modes 0-2 and NMI, the EI delay |
| Slots | Four primary slots: BIOS, two cartridge ports, 64K RAM; on MSX2 slot 3 expanded (SUB-ROM in 3-0, a 512K memory mapper in 3-2) |
| V9938 / V9958 | MSX2 and MSX2+ video: 128K VRAM, palette, all ten modes (TEXT2 80 columns, SCREEN 5-8, YJK SCREEN 10-12), sprites mode 2, line interrupts, scroll, the command engine (spec in `docs/v9938.md`) |
| RTC | The MSX2's RP5C01 clock, its settings memory kept in the browser |
| TMS9918A | Graphics I and II, multicolour, text; sprites with the 4-per-line limit, 5S and collision flags; drawn a line at a time |
| AY-3-8910 | Three tones, noise, envelope, joystick port; rendered in step with CPU time |
| PPI | Slot select, keyboard matrix, CAPS lamp, key click |
| Cartridges | Plain ROMs up to 64K; Konami, Konami SCC, ASCII 8K and 16K MegaROMs |
| Cassette | `.cas` tapes through the BIOS tape routines: load, record, download |
| Modem | Ok-Modem cartridge: a Hayes modem on ports 04h/05h (A-Prompt's), a Z80 terminal in its ROM, real BBSes and the DeepSeek AI board |
| SCC | Konami's five-channel wave-table chip in SCC cartridges, mixed with the PSG |

## Next

- Disk drives and MSX-DOS (which runs CP/M programs, like A-Prompt's).
- Command engine timing (commands finish at once for now), MSX-MUSIC.
- Save states, touch controls, a WebGL CRT shader.

## Credits and licence

- Ok-Prompt: MIT, © 2026 Eduardo Stern (`LICENSE`). The Z80 core and the
  power switch come from A-Prompt.
- C-BIOS 0.29: BSD-style licence, `src/roms/C-BIOS-LICENSE.txt`.
- zexdoc/zexall: Frank Cringle's public-domain Z80 exercisers.
- MSX is a trademark of MSX Licensing Corporation; Ok-Prompt is not
  affiliated with it.
