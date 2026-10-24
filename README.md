# Ok-Prompt

**An MSX in your browser. Drop in a cartridge and play.**

Ok-Prompt is an MSX1 emulator in TypeScript: a Z80 at 3.58 MHz, the
TMS9918A video chip, the AY-3-8910 sound chip, the 8255 PPI with the
keyboard, and the MSX slot system with cartridges. It boots
[C-BIOS](http://cbios.sourceforge.net/), the free MSX BIOS, so nothing
copyrighted ships with it: plug in a game ROM and it starts.

The name comes from MSX BASIC, which answers every command with `Ok`, as
[A-Prompt](https://a-prompt.stern.workers.dev), its CP/M sibling, is named
after `A>`. The Z80 core comes from A-Prompt, where zexdoc and zexall pass.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest; ZEX=1 npx vitest run tests/zex.test.ts for the Z80 exercisers
npm run build      # static site in dist/
```

## Playing

- Press a key or click the screen to power on (browsers allow sound only
  after that). *Power on by itself* skips it.
- Drop a `.rom` (or a `.zip` with one inside) anywhere on the page, or
  click a cartridge slot. Slots are remembered in this browser.
- Every ROM you load stays on the shelf under the slots: click it to put
  it back in slot 1, or on its 2 for slot 2.
- *System ROM* swaps C-BIOS for a BIOS dump of your own (16K-64K, such as
  the Gradiente Expert's 32K ROM) to boot into MSX BASIC. It stays in your
  browser; Ok-Prompt never ships copyrighted ROMs.
- Tapes (`.cas`) go in the tape deck under the slots. With your own BIOS,
  *Load* resets the MSX and types `BLOAD"CAS:",R`, `CLOAD` or `RUN"CAS:"`
  for you. *Blank* gives a tape to `CSAVE` on; download it with ⤓. Games
  with their own turbo loaders do not load this way.
- The bank-switching scheme of big cartridges is guessed from the code;
  change it under the cartridge if a game does not start.
- The PC keyboard is the MSX keyboard: GRAPH is left Alt, CODE right Alt,
  STOP F7, SELECT F8, F6-F10 are Shift + F1-F5. A gamepad is joystick 1.

## What is emulated

| Part | State |
| --- | --- |
| Z80 | Complete, Zilog timing, interrupt modes 0-2 and NMI, the EI delay |
| Slots | Four primary slots: BIOS, two cartridge ports, 64K RAM |
| TMS9918A | Graphics I and II, multicolour, text; sprites with the 4-per-line limit, 5S and collision flags; drawn a line at a time |
| AY-3-8910 | Three tones, noise, envelope, joystick port; rendered in step with CPU time |
| PPI | Slot select, keyboard matrix, CAPS lamp, key click |
| Cartridges | Plain ROMs up to 64K; Konami, Konami SCC, ASCII 8K and 16K MegaROMs |
| Cassette | `.cas` tapes through the BIOS tape routines: load, record, download |
| SCC | Konami's five-channel wave-table chip in SCC cartridges, mixed with the PSG |

## Next

- Disk drives and MSX-DOS (which runs CP/M programs, like A-Prompt's).
- Expanded slots, MSX2 (V9938).
- Save states, touch controls, a WebGL CRT shader.
- A modem cartridge on A-Prompt's telnet relay, to call the same BBSes.

## Credits and licence

- Ok-Prompt: MIT, © 2026 Eduardo Stern (`LICENSE`). The Z80 core and the
  power switch come from A-Prompt.
- C-BIOS 0.29: BSD-style licence, `src/roms/C-BIOS-LICENSE.txt`.
- zexdoc/zexall: Frank Cringle's public-domain Z80 exercisers.
- MSX is a trademark of MSX Licensing Corporation; Ok-Prompt is not
  affiliated with it.
