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
ZEX=1 npx vitest run tests/zex.test.ts   # zexdoc + zexall, ~2.5 min
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
| `src/msx/ppi.ts` | 8255: slot register, keyboard rows, click |
| `src/msx/keyboard.ts` | PC `KeyboardEvent.code` to the MSX matrix |
| `src/main.ts` | Page wiring, frame loop, cartridges, keys, gamepad |
| `src/ui/` | Audio, power switch (from A-Prompt), sound output, IndexedDB cartridges, confirm dialog |
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
- C-BIOS only starts cartridges: no BASIC, no disk. MSX BASIC and MSX-DOS
  ROMs are copyrighted; never add them to the repo.

## Testing tips

- `tests/msx.test.ts` boots C-BIOS headless; `helloCart()` builds a 16K
  cartridge that prints through the BIOS's CHPUT.
- Browser checks: `npm run build`, `npx vite preview --port 4180`, then
  `playwright-cli` from the scratchpad. A fresh page waits at the power
  switch: press a key, or set localStorage `ok-prompt.settings` to
  `{"autoPower":true}`.
