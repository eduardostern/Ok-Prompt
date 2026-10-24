/**
 * Ok-Prompt's page: the MSX in the monitor, its cartridge slots on the
 * console deck, and the panels for the machine, display, sound and controls.
 */
import './style.css';
import { unzipSync } from 'fflate';
import mainRomUrl from './roms/cbios_main_msx1.rom?url';
import logoRomUrl from './roms/cbios_logo_msx1.rom?url';
import main2RomUrl from './roms/cbios_main_msx2.rom?url';
import logo2RomUrl from './roms/cbios_logo_msx2.rom?url';
import main2pRomUrl from './roms/cbios_main_msx2+.rom?url';
import logo2pRomUrl from './roms/cbios_logo_msx2+.rom?url';
import subRomUrl from './roms/cbios_sub.rom?url';
import modemRomUrl from './roms/okmodem.rom?url';
import { Cartridge, MAPPERS, Mapper } from './msx/cartridge';
import { detectCharset, KeyInput, KeyTable, msxChar, msxText, SPECIAL_KEYS } from './msx/keyboard';
import { printedText } from './msx/printer';
import { Bios, biosLabel, biosModel, checkBios, CYCLES_PER_LINE, Msx, REGIONS, Region } from './msx/machine';
import { asciiCas, isTsx, loadCommand, Tape } from './msx/tape';
import { MODEM_CART_NAME, ModemCartridge } from './msx/modem-cart';
import { getDeepSeekKey, keyListeners, modemOptions, setDeepSeekKey } from './ui/modem-line';
import { HEIGHT, WIDTH } from './msx/vdp';
import { audioContext } from './ui/audio';
import { askConfirm } from './ui/confirm';
import { waitForPower, warmUp } from './ui/power';
import { SoundOut } from './ui/sound-out';
import { MsxKeyboard } from './ui/msx-keyboard';
import {
  loadAllBios, loadAllDiskRoms, loadCart, loadDisk, loadShelf, loadTape, removeBios, removeDiskRom, saveBios, saveCart,
  saveDisk, saveDiskRom, saveTape, shelve, StoredCart, unshelve,
} from './ui/store';
import { blankDisk, Disk, diskRomIn, SECTOR } from './msx/disk';

const SAMPLE_RATE = 44100;
const MAX_ROM = 4 * 1024 * 1024;
const SETTINGS_KEY = 'ok-prompt.settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- settings ---------------------------------------------------------------

interface Settings {
  region: Region;
  speed: number;
  smooth: boolean;
  scanlines: boolean;
  curve: boolean;
  flicker: boolean;
  humbar: boolean;
  volume: number;
  autoPower: boolean;
  /** The system ROM: 'cbios', 'cbios2', 'cbios2p' (built in) or the name of one of the player's own. */
  bios: string;
  /** Keys type the character on the PC key (through the BIOS's table), or stay where they are. */
  keymap: 'char' | 'position';
  /** The on-screen keyboard is open. */
  keyboard: boolean;
  /** The disk ROM in use ('' for no disk drive): the name of one of the player's own. */
  diskRom: string;
  /** MSX-MUSIC (the YM2413 FM chip) is in the machine. */
  fm: boolean;
}

const DEFAULTS: Settings = {
  region: 'ntsc', speed: 1, smooth: false, scanlines: true, curve: true,
  flicker: false, humbar: false, volume: 70, autoPower: false, bios: 'cbios', keymap: 'char', keyboard: false,
  fm: true,
  diskRom: '',
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this visit */
  }
};

// ---- start ------------------------------------------------------------------

async function bytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** Saves bytes as a file on the user's computer. */
function download(name: string, data: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data.slice()], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function start(): Promise<void> {
  const [main, logo, modemRom] = await Promise.all([bytes(mainRomUrl), bytes(logoRomUrl), bytes(modemRomUrl)]);
  const [main2, logo2, main2p, logo2p, sub] = await Promise.all(
    [main2RomUrl, logo2RomUrl, main2pRomUrl, logo2pRomUrl, subRomUrl].map(bytes));
  /** The built-in machines: C-BIOS MSX1, MSX2 and MSX2+. */
  const BUILT_IN: Record<string, Bios> = {
    cbios: { main, logo },
    cbios2: { main: main2, logo: logo2, sub },
    cbios2p: { main: main2p, logo: logo2p, sub },
  };
  const cbios = BUILT_IN.cbios;
  const msx = new Msx(cbios, SAMPLE_RATE);
  let biosList = await loadAllBios();
  if (settings.bios === 'own') settings.bios = biosList[0]?.name ?? 'cbios'; // the one BIOS of earlier versions
  /** The player's BIOS in use, or undefined for C-BIOS. */
  const ownBios = () => biosList.find((b) => b.name === settings.bios);
  /** The BIOS in use, built in or own. */
  const currentBios = (): Bios => {
    const own = ownBios();
    return own ? { main: own.data, sub: own.sub } : BUILT_IN[settings.bios] ?? cbios;
  };
  msx.setBios(currentBios());
  msx.setFm(settings.fm);
  // The MSX2 clock's memory (the BIOS's settings), kept as on a battery.
  const RTC_KEY = 'ok-prompt.rtc';
  try {
    const saved = localStorage.getItem(RTC_KEY);
    if (saved) msx.rtc.loadRam(Uint8Array.from(saved.match(/../g) ?? [], (h) => parseInt(h, 16)));
  } catch {
    /* no saved clock */
  }
  msx.rtc.onRamChange = (ram) => {
    try {
      localStorage.setItem(RTC_KEY, [...ram].map((b) => b.toString(16).padStart(2, '0')).join(''));
    } catch {
      /* storage blocked */
    }
  };
  const keys = new KeyInput(msx.ppi);
  // The keyboard on the page, with the legends of the BIOS in use.
  const screenKeys = new MsxKeyboard($('kbd'), {
    key: (row, bit, down) => msx.ppi.key(row, bit, down),
    running: () => running,
  });
  keys.inject = (code) => msx.type(String.fromCharCode(code));
  /** Reads the key table of the BIOS in use (when typing by character). */
  const useKeyTable = () => {
    const rom = currentBios().main;
    screenKeys.draw(KeyTable.find(rom));
    keys.table = settings.keymap === 'char' ? KeyTable.find(rom) : null;
    const note = document.getElementById('keymap-note');
    if (note) {
      note.textContent = settings.keymap === 'position'
        ? 'Every key stays in its place on the MSX keyboard, as the real one had them.'
        : keys.table
          ? `Symbols and accents follow your PC keyboard${keys.table.charset === 'brazil-1.0' ? ' (Expert 1.0 character set)' : ''}.`
          : 'This BIOS has no key table to read: keys stay in their places.';
    }
  };
  useKeyTable();
  const sound = new SoundOut(SAMPLE_RATE);
  const wrap = $('screen-wrap');
  const canvas = $<HTMLCanvasElement>('screen');
  const g = canvas.getContext('2d')!;
  let image = g.createImageData(WIDTH, HEIGHT);
  let pixels = new Uint32Array(image.data.buffer);
  let running = false;

  /** The canvas follows the video chip: 288x224 (MSX1) or 576x240 (MSX2). */
  const fitCanvas = () => {
    const { width, height } = msx.vdp;
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    image = g.createImageData(width, height);
    pixels = new Uint32Array(image.data.buffer);
    // MSX2 frames are twice as wide in pixels for the same picture.
    wrap.style.setProperty('--screen-aspect', `${width / (width > 400 ? 2 : 1)} / ${height}`);
  };
  const draw = () => {
    fitCanvas();
    pixels.set(msx.vdp.frame);
    g.putImageData(image, 0, 0);
  };
  const blank = () => {
    fitCanvas();
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
  };
  blank();

  // ---- display and sound settings ------------------------------------------

  const flags: (keyof Settings)[] = ['smooth', 'scanlines', 'curve', 'flicker', 'humbar'];
  const applyLook = () => {
    for (const f of flags) document.body.classList.toggle(f, Boolean(settings[f]));
    document.body.classList.toggle('pal', settings.region === 'pal');
    sound.volume = settings.volume / 100;
    msx.region = settings.region;
  };
  for (const f of flags) {
    const box = $<HTMLInputElement>(f);
    box.checked = Boolean(settings[f]);
    box.addEventListener('change', () => {
      (settings[f] as boolean) = box.checked;
      save();
      applyLook();
    });
  }
  const volume = $<HTMLInputElement>('volume');
  volume.value = String(settings.volume);
  volume.addEventListener('input', () => { settings.volume = Number(volume.value); save(); applyLook(); });
  const fmBox = $<HTMLInputElement>('fm');
  fmBox.checked = settings.fm;
  fmBox.addEventListener('change', () => {
    settings.fm = fmBox.checked;
    save();
    msx.setFm(settings.fm);
    // Software looks for the chip as it starts.
    if (running) msx.powerCycle();
  });
  const region = $<HTMLSelectElement>('region');
  region.value = settings.region;
  region.addEventListener('change', () => { settings.region = region.value as Region; save(); applyLook(); });
  const speed = $<HTMLSelectElement>('speed');
  speed.value = String(settings.speed);
  speed.addEventListener('change', () => { settings.speed = Number(speed.value); save(); });
  const autoPower = $<HTMLInputElement>('auto-power');
  autoPower.checked = settings.autoPower;
  autoPower.addEventListener('change', () => { settings.autoPower = autoPower.checked; save(); });
  applyLook();

  const keyList = $('special-keys');
  for (const [msxName, pc] of SPECIAL_KEYS) keyList.insertAdjacentHTML('beforeend', `<dt>${msxName}</dt><dd>${pc}</dd>`);

  $('fullscreen').addEventListener('click', () => {
    const monitor = document.querySelector<HTMLElement>('.monitor')!;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void monitor.requestFullscreen?.();
  });

  // ---- power ---------------------------------------------------------------

  const powerBtn = $('power');
  const showPower = () => {
    powerBtn.setAttribute('aria-pressed', String(running));
    $('power-lamp').classList.toggle('on', running);
  };
  const powerOn = async (warm = true) => {
    audioContext(); // the click or key that got here unlocks sound
    msx.powerCycle();
    if (warm) await warmUp(wrap, settings.region === 'pal');
    running = true;
    showPower();
  };
  const powerOff = () => {
    running = false;
    msx.ppi.rows.fill(0xff);
    blank();
    showPower();
  };
  powerBtn.addEventListener('click', () => (running ? powerOff() : void powerOn()));
  $('reset').addEventListener('click', () => { if (running) msx.reset(); });

  // ---- cartridges ----------------------------------------------------------

  const fileInput = $<HTMLInputElement>('rom-file');
  let loadSlot: 1 | 2 = 1;
  const slotEl = (n: 1 | 2) => document.querySelector<HTMLElement>(`.slot[data-slot="${n}"]`)!;

  const showSlot = (n: 1 | 2) => {
    const cart = msx.cartridges[n - 1];
    const el = slotEl(n);
    el.classList.toggle('full', Boolean(cart));
    el.querySelector('.cart-label')!.textContent = cart ? cart.name : 'Empty: click or drop a ROM';
    el.classList.toggle('modem', cart instanceof ModemCartridge);
    const sel = el.querySelector<HTMLSelectElement>('.mapper')!;
    if (cart) sel.value = cart.mapper;
  };

  // ---- the modem cartridge ---------------------------------------------------

  /** The modem in a slot, if one is plugged in. */
  const modem = () => msx.cartridges.find((c): c is ModemCartridge => c instanceof ModemCartridge)?.modem;
  const line = modemOptions({
    record: (name, program) => {
      const tape = { name: `${name}.cas`, data: asciiCas(name, program) };
      insertTape(tape);
      tapeNote.textContent = `${name} came from the AI board. In BASIC: RUN"CAS:"`;
      void shelve(tape).then(showShelf);
    },
    hasBasic: () => Boolean(ownBios()),
    columns: () => msx.vdp.textColumns() || 40,
    speaker: () => {
      const m = modem();
      return { on: (m?.speaker ?? 1) !== 0, volume: m?.volume ?? 2 };
    },
  });
  /** The shelf's built-in entry for the modem cartridge. */
  const MODEM_CART: StoredCart = { name: MODEM_CART_NAME, data: modemRom, mapper: 'modem' };
  const makeCart = (stored: StoredCart): Cartridge => {
    if (stored.mapper !== 'modem') return new Cartridge(stored.data, stored.mapper as Mapper | undefined, stored.name);
    const cart = new ModemCartridge(modemRom, line); // always the ROM of this version
    line.setup(cart.modem);
    return cart;
  };

  const insert = (n: 1 | 2, stored: StoredCart | null, persist = true) => {
    const old = msx.cartridges[n - 1];
    if (old instanceof ModemCartridge) old.modem.hangup(false);
    msx.insert(n, stored ? makeCart(stored) : null);
    if (persist) void saveCart(n, stored);
    showSlot(n);
    markShelf();
    if (running) msx.reset();
  };

  /** A ROM from a file: unzipped if needed. */
  const readRom = async (file: File, max = MAX_ROM, what = 'an MSX cartridge'): Promise<StoredCart> => {
    let data = new Uint8Array(await file.arrayBuffer());
    let name = file.name;
    if (/\.zip$/i.test(name)) {
      const files = Object.entries(unzipSync(data)).filter(([n, d]) => d.length && !n.endsWith('/'));
      const pick = files.find(([n]) => /\.(rom|mx1|mx2|bin|cas|tsx|dsk|di1|di2)$/i.test(n)) ?? files.sort((a, b) => b[1].length - a[1].length)[0];
      if (!pick) throw new Error('no ROM inside the zip');
      [name, data] = pick;
    }
    // A .tsx stays as it is: the tape deck plays its timing to custom loaders.
    if (/\.tsx$/i.test(name) && !isTsx(data)) throw new Error('not a .tsx tape');
    if (data.length > max) throw new Error(`too big for ${what}`);
    return { name: name.replace(/^.*\//, ''), data };
  };

  const isTape = (name: string) => /\.(cas|tsx)$/i.test(name);
  const isDisk = (name: string) => /\.(dsk|di1|di2)$/i.test(name);

  const load = async (file: File, n: 1 | 2) => {
    try {
      const rom = await readRom(file);
      if (isDisk(rom.name)) {
        insertDiskFile(rom);
        await shelve(rom);
        void showShelf();
        if (!msx.hasDiskDrive) alertSlot(n, 'The disk is in the drive, but the MSX has no disk drive yet: load a disk ROM under Machine.');
        return;
      }
      if (isTape(rom.name)) {
        insertTape(rom);
        await shelve(rom);
        void showShelf();
        return;
      }
      insert(n, rom);
      await shelve(rom);
      void showShelf();
      if (!running) await powerOn();
    } catch (e) {
      alertSlot(n, `Could not load ${file.name}: ${(e as Error).message}`);
    }
  };
  const alertSlot = (n: 1 | 2, text: string) => {
    slotEl(n).querySelector('.cart-label')!.textContent = text;
  };

  for (const n of [1, 2] as const) {
    const el = slotEl(n);
    const sel = el.querySelector<HTMLSelectElement>('.mapper')!;
    for (const [id, label] of Object.entries(MAPPERS)) sel.add(new Option(label, id));
    sel.addEventListener('change', async () => {
      const cart = msx.cartridges[n - 1];
      if (cart) insert(n, { name: cart.name, data: cart.rom, mapper: sel.value });
    });
    el.querySelector('[data-action="load"]')!.addEventListener('click', () => {
      loadSlot = n;
      fileInput.click();
    });
    el.querySelector('[data-action="eject"]')!.addEventListener('click', () => insert(n, null));
  }
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void load(file, loadSlot);
  });

  // Drop a ROM anywhere: it goes into slot 1.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) void load(file, 1);
  });

  // ---- the shelf: every cartridge loaded before ---------------------------

  const shelfList = $('shelf-list');
  /** Highlights the shelf entries that are in a slot. */
  function markShelf(): void {
    const inSlots = [...msx.cartridges.map((c) => c?.name), msx.tape?.name, msx.disk?.name];
    for (const li of shelfList.children) {
      li.classList.toggle('inserted', inSlots.includes((li as HTMLElement).dataset.name));
    }
  }
  async function showShelf(): Promise<void> {
    const carts = [MODEM_CART, ...await loadShelf()];
    shelfList.replaceChildren(...carts.map((cart) => {
      const li = document.createElement('li');
      li.dataset.name = cart.name;
      const button = (cls: string, text: string, title: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', onClick);
        li.append(b);
      };
      const put = async (n: 1 | 2) => {
        insert(n, cart);
        if (!running) await powerOn();
      };
      if (cart === MODEM_CART) {
        li.classList.add('builtin');
        button('shelf-cart', `☎ ${cart.name}`, 'Plug the modem cartridge into slot 2 (CALL TERM in BASIC)', () => void put(2));
        button('shelf-slot', '1', 'Plug it into slot 1', () => void put(1));
        return li; // built in: it cannot be taken off the shelf
      }
      if (isTape(cart.name)) {
        button('shelf-cart', cart.name, `Put the tape ${cart.name} in the tape deck`, () => insertTape(cart));
      } else if (isDisk(cart.name)) {
        button('shelf-cart', cart.name, `Put the disk ${cart.name} in the drive`, () => insertDiskFile(cart));
      } else {
        button('shelf-cart', cart.name, `Insert ${cart.name} in slot 1`, () => void put(1));
        button('shelf-slot', '2', 'Insert in slot 2', () => void put(2));
      }
      button('shelf-del', '×', 'Take it off the shelf', async () => {
        const yes = await askConfirm({
          title: 'Take it off the shelf?',
          message: `${cart.name} will be forgotten by this browser. Load the file again to bring it back.`,
          ok: 'Remove',
        });
        if (!yes) return;
        await unshelve(cart.name);
        void showShelf();
      });
      return li;
    }));
    markShelf();
  }

  for (const n of [1, 2] as const) {
    const stored = await loadCart(n);
    if (stored) {
      insert(n, stored, false);
      await shelve(stored); // cartridges from before the shelf existed
    }
  }
  // ---- the tape deck -------------------------------------------------------

  const tapeEl = $('tape');
  const tapeFile = $<HTMLInputElement>('tape-file');
  const tapeNote = $('tape-note');
  const KIND_LABEL = { binary: 'machine code', basic: 'BASIC', ascii: 'BASIC text' } as const;
  const showTapePos = () => {
    const t = msx.tape;
    $('tape-pos').textContent = t && t.signal.end ? `${Math.round(t.progress * 100)}%` : '';
  };
  function showTape(): void {
    const t = msx.tape;
    tapeEl.classList.toggle('full', Boolean(t));
    const first = t?.first();
    $('tape-label').textContent = !t
      ? 'No tape: click or drop a .cas or .tsx'
      : first ? `${t.name} · ${first.name || 'no name'} (${KIND_LABEL[first.kind]})`
        : `${t.name} · ${t.length || /\.tsx$/i.test(t.file().name) ? 'its own loader' : 'blank'}`;
    showTapePos();
    markShelf();
  }
  function insertTape(stored: StoredCart | null, persist = true): void {
    msx.tape = stored ? new Tape(stored.data, stored.name) : null;
    if (persist) void saveTape(stored);
    tapeNote.textContent = stored && !ownBios()
      ? 'Tapes load from MSX BASIC: pick your own BIOS under System ROM (C-BIOS has no BASIC).'
      : '';
    showTape();
  }
  msx.onTapeWritten = (t) => {
    const f = t.file();
    const stored = { name: f.name, data: f.data.slice() };
    void saveTape(stored);
    void shelve(stored).then(showShelf);
    showTape();
  };
  $('tape-load').addEventListener('click', () => tapeFile.click());
  tapeFile.addEventListener('change', () => {
    const file = tapeFile.files?.[0];
    tapeFile.value = '';
    if (file) void load(file, 1);
  });
  $('tape-eject').addEventListener('click', () => insertTape(null));
  $('tape-rewind').addEventListener('click', () => { msx.tape?.rewind(); showTapePos(); });
  $('tape-blank').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    insertTape({ name: `recording-${stamp}.cas`, data: new Uint8Array(0) });
    tapeNote.textContent = 'Blank tape in. In BASIC: CSAVE"NAME", SAVE"CAS:NAME" or BSAVE"CAS:NAME",start,end. ⤓ downloads it.';
  });
  $('tape-save').addEventListener('click', () => {
    const t = msx.tape;
    if (t) {
      const f = t.file();
      download(f.name, f.data);
    }
  });
  $('tape-play').addEventListener('click', async () => {
    const t = msx.tape;
    const first = t?.first();
    if (!t) return;
    if (!first) { tapeNote.textContent = 'No MSX file found at the start of this tape.'; return; }
    if (!ownBios()) {
      tapeNote.textContent = 'Tapes load from MSX BASIC: pick your own BIOS under System ROM (C-BIOS has no BASIC).';
      return;
    }
    const command = loadCommand(first.kind);
    tapeNote.textContent = `Typing ${command.replace(/\r/g, ' ⏎ ').trim()}`;
    if (running) msx.reset();
    else await powerOn();
    t.rewind();
    msx.type(command);
  });
  const storedTape = await loadTape();
  if (storedTape) insertTape(storedTape, false);

  await showShelf();

  // ---- the system ROM ------------------------------------------------------

  const biosSel = $<HTMLSelectElement>('bios');
  const biosFile = $<HTMLInputElement>('bios-file');
  const biosNote = $('bios-note');
  const biosNoteText = biosNote.textContent;
  const label = (b: StoredCart) => {
    const model = biosModel(b.data);
    const name = biosLabel(b.data) ?? b.name.replace(/\.[a-z0-9]+$/i, '');
    return model === 'msx1' ? name : `${name} (${model === 'msx2' ? 'MSX2' : 'MSX2+'})`;
  };
  /** On an MSX2 the BIOS sets 50 or 60 Hz in the VDP; the menu only drives an MSX1. */
  const showRegion = () => {
    const msx2 = msx.model !== 'msx1';
    region.disabled = msx2;
    region.title = msx2 ? 'An MSX2 BIOS sets 50 or 60 Hz itself (C-BIOS: 60 Hz)' : '';
  };
  const showBios = () => {
    showRegion();
    // The built-in machines stay; the player's own BIOSes are listed after them.
    for (const o of [...biosSel.options]) if (o.dataset.own) o.remove();
    for (const b of biosList) {
      const o = new Option(label(b), b.name);
      o.title = b.name;
      o.dataset.own = '1';
      biosSel.add(o);
    }
    biosSel.value = ownBios() || BUILT_IN[settings.bios] ? settings.bios : 'cbios';
    $('bios-remove').hidden = !ownBios();
  };
  const useBios = async (name: string) => {
    settings.bios = biosList.some((b) => b.name === name) || BUILT_IN[name] ? name : 'cbios';
    save();
    msx.setBios(currentBios());
    blank();
    useKeyTable();
    showBios();
    if (ownBios()) tapeNote.textContent = '';
    if (running) await powerOn();
  };
  biosSel.addEventListener('change', () => void useBios(biosSel.value));
  $('bios-load').addEventListener('click', () => biosFile.click());
  /** Every ROM in the chosen files, zips opened. */
  const readAll = async (files: File[]): Promise<{ name: string; data: Uint8Array }[]> => {
    const out: { name: string; data: Uint8Array }[] = [];
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      if (/\.zip$/i.test(file.name)) {
        for (const [n, d] of Object.entries(unzipSync(data))) if (d.length && !n.endsWith('/')) out.push({ name: n.replace(/^.*\//, ''), data: d });
      } else {
        out.push({ name: file.name, data });
      }
    }
    return out;
  };
  /**
   * A BIOS set from loose ROMs: the main ROM (DI at 0000h) and, for an
   * MSX2, the SUB-ROM (16K starting "CD"), or one dump with both.
   */
  const biosSet = (roms: { name: string; data: Uint8Array }[]): StoredCart => {
    const isSub = (d: Uint8Array) => d.length === 0x4000 && d[0] === 0x43 && d[1] === 0x44;
    let mainRom = roms.find((r) => r.data.length >= 0x4000 && r.data.length <= 0x10000 && r.data[0] === 0xf3);
    if (!mainRom) throw new Error('no MSX main ROM among them (it starts with DI, 16K to 64K)');
    let subRom = roms.find((r) => isSub(r.data))?.data;
    let mainData = mainRom.data;
    if (!subRom && mainData.length >= 0xc000 && isSub(mainData.subarray(0x8000, 0xc000))) {
      subRom = mainData.slice(0x8000, 0xc000); // one dump: main ROM then SUB-ROM
      mainData = mainData.slice(0, 0x8000);
    }
    checkBios(mainData);
    if (biosModel(mainData) !== 'msx1' && !subRom) {
      throw new Error('an MSX2 BIOS needs its SUB-ROM too: choose both files, or a zip with both');
    }
    return { name: mainRom.name, data: mainData, ...(subRom ? { sub: subRom } : {}) };
  };
  biosFile.addEventListener('change', async () => {
    const files = [...(biosFile.files ?? [])];
    biosFile.value = '';
    if (!files.length) return;
    const names = files.map((f) => f.name).join(', ');
    try {
      const rom = biosSet(await readAll(files));
      // The same bytes under another name (Expert 1.1 and DD Plus share one ROM): use that one.
      const same = biosList.find((b) => b.data.length === rom.data.length && b.data.every((v, i) => v === rom.data[i]));
      if (same) {
        biosNote.textContent = `${names} is the same ROM as ${label(same)}, already here.`;
        await useBios(same.name);
        return;
      }
      await saveBios(rom);
      biosList = [...biosList.filter((b) => b.name !== rom.name), rom].sort((a, b) => a.name.localeCompare(b.name));
      biosNote.textContent = biosNoteText;
      await useBios(rom.name);
    } catch (e) {
      biosNote.textContent = `Could not use ${names}: ${(e as Error).message}`;
    }
  });
  $('bios-remove').addEventListener('click', async () => {
    const b = ownBios();
    if (!b) return;
    const yes = await askConfirm({
      title: 'Remove this BIOS?',
      message: `${label(b)} (${b.name}) will be forgotten by this browser and the MSX goes back to C-BIOS.`,
      ok: 'Remove',
    });
    if (!yes) return;
    await removeBios(b.name);
    biosList = biosList.filter((x) => x !== b);
    await useBios('cbios');
  });
  showBios();

  // ---- the disk drive ------------------------------------------------------

  let diskRoms = await loadAllDiskRoms();
  const diskSel = $<HTMLSelectElement>('diskrom');
  const diskRomFile = $<HTMLInputElement>('diskrom-file');
  const diskNote = $('diskrom-note');
  const diskNoteText = diskNote.textContent ?? '';
  const diskEl = $('disk');
  const diskFile = $<HTMLInputElement>('disk-file');
  const ownDiskRom = () => diskRoms.find((r) => r.name === settings.diskRom);
  const showDiskRoms = () => {
    for (const o of [...diskSel.options]) if (o.value) o.remove();
    for (const r of diskRoms) diskSel.add(new Option(r.name, r.name));
    diskSel.value = ownDiskRom() ? settings.diskRom : '';
    $('diskrom-remove').hidden = !ownDiskRom();
    diskEl.hidden = !ownDiskRom();
  };
  const useDiskRom = (name: string) => {
    settings.diskRom = diskRoms.some((r) => r.name === name) ? name : '';
    save();
    msx.setDiskRom(ownDiskRom()?.data ?? null);
    showDiskRoms();
    if (running) msx.powerCycle();
  };
  diskSel.addEventListener('change', () => useDiskRom(diskSel.value));
  $('diskrom-load').addEventListener('click', () => diskRomFile.click());
  diskRomFile.addEventListener('change', async () => {
    const file = diskRomFile.files?.[0];
    diskRomFile.value = '';
    if (!file) return;
    try {
      let rom: Uint8Array | null = null;
      let name = file.name;
      for (const r of await readAll([file])) {
        rom = diskRomIn(r.data);
        if (rom) { name = r.name; break; }
      }
      if (!rom) throw new Error('no disk ROM in it ("AB" and the jump table at 4010h, 16K)');
      const stored = { name, data: rom };
      await saveDiskRom(stored);
      diskRoms = [...diskRoms.filter((r) => r.name !== name), stored].sort((a, b) => a.name.localeCompare(b.name));
      diskNote.textContent = diskNoteText;
      useDiskRom(name);
    } catch (e) {
      diskNote.textContent = `Could not use ${file.name}: ${(e as Error).message}`;
    }
  });
  $('diskrom-remove').addEventListener('click', async () => {
    const r = ownDiskRom();
    if (!r) return;
    const yes = await askConfirm({
      title: 'Remove this disk ROM?',
      message: `${r.name} will be forgotten by this browser and the MSX has no disk drive.`,
      ok: 'Remove',
    });
    if (!yes) return;
    await removeDiskRom(r.name);
    diskRoms = diskRoms.filter((x) => x !== r);
    useDiskRom('');
  });
  msx.setDiskRom(ownDiskRom()?.data ?? null);
  showDiskRoms();

  function showDisk(): void {
    const d = msx.disk;
    diskEl.classList.toggle('full', Boolean(d));
    $('disk-label').textContent = d ? `${d.name} · ${Math.round(d.data.length / 1024)}K` : 'No disk: click or drop a .dsk';
    markShelf();
  }
  function insertDiskFile(stored: StoredCart | null, persist = true): void {
    msx.insertDisk(stored ? new Disk(stored.data, stored.name) : null);
    if (persist) void saveDisk(stored);
    showDisk();
  }
  // Written disks are kept, a moment after the last write.
  let diskSaveTimer = 0;
  msx.onDiskWritten = (d) => {
    clearTimeout(diskSaveTimer);
    diskSaveTimer = window.setTimeout(() => {
      d.dirty = false;
      const stored = { name: d.name, data: d.data.slice() };
      void saveDisk(stored);
      void shelve(stored).then(showShelf);
    }, 500);
  };
  $('disk-load').addEventListener('click', () => diskFile.click());
  diskFile.addEventListener('change', async () => {
    const file = diskFile.files?.[0];
    diskFile.value = '';
    if (!file) return;
    try {
      const d = await readRom(file, 2 * 1024 * 1024, 'a disk');
      if (d.data.length % SECTOR) throw new Error('not a disk image (not whole 512-byte sectors)');
      insertDiskFile(d);
      await shelve(d);
      void showShelf();
    } catch (e) {
      diskNote.textContent = `Could not load ${file.name}: ${(e as Error).message}`;
    }
  });
  $('disk-blank').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
    insertDiskFile({ name: `disk-${stamp}.dsk`, data: blankDisk() });
  });
  $('disk-save').addEventListener('click', () => {
    const d = msx.disk;
    if (d) download(d.name, d.data);
  });
  $('disk-eject').addEventListener('click', () => insertDiskFile(null));
  const storedDisk = await loadDisk();
  if (storedDisk) insertDiskFile(storedDisk, false);
  showDisk();

  // ---- keyboard and gamepad ------------------------------------------------

  const typing = (e: Event) => (e.target as Partial<Element> | null)?.closest?.('input, select, textarea, dialog');
  window.addEventListener('keydown', (e) => {
    if (!running || typing(e) || e.metaKey) return;
    if (keys.down(e.code, e.key, e.ctrlKey, e.altKey)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (keys.up(e.code)) e.preventDefault();
  });
  window.addEventListener('blur', () => keys.releaseAll());
  /** Types text into the MSX, in the character set of the BIOS in use. */
  const paste = (text: string) => {
    if (!running || !text) return;
    msx.type(msxText(text, keys.table?.charset ?? detectCharset(currentBios().main)));
  };
  window.addEventListener('paste', (e) => {
    if (typing(e)) return;
    e.preventDefault();
    paste(e.clipboardData?.getData('text/plain') ?? '');
  });
  $('paste').addEventListener('click', async () => {
    try {
      paste(await navigator.clipboard.readText());
    } catch {
      alert('The browser would not share the clipboard. Press ⌘V or Ctrl+Shift+V on the page instead.');
    }
  });

  // ---- the printer ---------------------------------------------------------

  const printerOut = $('printer-out');
  const printed = () => printedText(msx.printer.bytes, (c) => msxChar(c, keys.table?.charset ?? 'international'));
  let printShown = 0;
  const showPrinter = () => {
    const any = msx.printer.bytes.length > 0;
    printerOut.hidden = !any;
    $('printer-keys').hidden = !any;
    $('printer-note').hidden = any;
    printerOut.textContent = printed();
    printerOut.scrollTop = printerOut.scrollHeight;
    printShown = msx.printer.bytes.length;
  };
  // Shown once a frame at most: LLIST prints thousands of bytes.
  msx.printer.onPrint = () => { printShown = -1; };
  $('printer-clear').addEventListener('click', () => { msx.printer.clear(); showPrinter(); });
  $('printer-save').addEventListener('click', () => download('printout.txt', new TextEncoder().encode(printed())));
  const kbdToggle = $('kbd-toggle');
  const showKbd = () => {
    $('kbd').hidden = !settings.keyboard;
    kbdToggle.setAttribute('aria-expanded', String(settings.keyboard));
  };
  kbdToggle.addEventListener('click', () => { settings.keyboard = !settings.keyboard; save(); showKbd(); });
  showKbd();

  // ---- the DeepSeek key, for the AI board -----------------------------------

  const keyInput = $<HTMLInputElement>('deepseek-key');
  const keyStatus = $('deepseek-status');
  const showKeyStatus = () => {
    const key = getDeepSeekKey();
    keyStatus.textContent = key ? `Key saved in this browser (${key.slice(0, 3)}…${key.slice(-4)}).` : 'No key yet.';
  };
  keyListeners.push(showKeyStatus);
  showKeyStatus();
  $('deepseek-save').addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (!key) return;
    setDeepSeekKey(key);
    keyInput.value = '';
  });
  $('deepseek-forget').addEventListener('click', () => {
    setDeepSeekKey(null);
    keyInput.value = '';
  });
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('deepseek-save').click();
  });

  const keymap = $<HTMLSelectElement>('keymap');
  keymap.value = settings.keymap;
  keymap.addEventListener('change', () => {
    settings.keymap = keymap.value as Settings['keymap'];
    save();
    keys.releaseAll();
    useKeyTable();
  });

  const padNote = $('gamepad');
  const pollPad = () => {
    const pad = navigator.getGamepads?.().find((p) => p);
    if (!pad) { msx.psg.joystick[0] = 0x3f; return; }
    padNote.textContent = `Gamepad: ${pad.id.slice(0, 40)} is joystick 1.`;
    const b = (i: number) => pad.buttons[i]?.pressed ?? false;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    let v = 0x3f;
    if (b(12) || ay < -0.5) v &= ~0x01;
    if (b(13) || ay > 0.5) v &= ~0x02;
    if (b(14) || ax < -0.5) v &= ~0x04;
    if (b(15) || ax > 0.5) v &= ~0x08;
    if (b(0)) v &= ~0x10;
    if (b(1) || b(2)) v &= ~0x20;
    msx.psg.joystick[0] = v;
  };

  // ---- the frame loop ------------------------------------------------------

  let last = performance.now();
  let owed = 0;
  let statFrames = 0;
  let statTime = last;
  const fps = $('fps');
  const mhz = $('mhz');
  const caps = $('caps');
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const frameMs = 1000 / REGIONS[msx.region].hz;
    owed += Math.min(now - last, 250);
    last = now;
    if (!running) { owed = 0; return; }
    pollPad();
    let ran = 0;
    const most = 4 * settings.speed;
    while (owed >= frameMs / settings.speed && ran < most) {
      owed -= frameMs / settings.speed;
      msx.runFrame();
      const samples = msx.takeAudio();
      if (settings.speed === 1) sound.play(samples);
      ran++;
    }
    if (ran === most) owed = 0; // the host fell behind: do not try to catch up
    if (ran) draw();
    if (printShown !== msx.printer.bytes.length) showPrinter();
    statFrames += ran;
    if (now - statTime >= 1000) {
      const f = (statFrames * 1000) / (now - statTime);
      fps.textContent = `${f.toFixed(0)} / s`;
      mhz.textContent = `${((f * REGIONS[msx.region].lines * CYCLES_PER_LINE) / 1e6).toFixed(2)} MHz`;
      statFrames = 0;
      statTime = now;
      showTapePos();
    }
    caps.classList.toggle('on', msx.ppi.capsLamp);
  };
  requestAnimationFrame(loop);

  // ---- first power-on ------------------------------------------------------

  showPower();
  // Powered on by itself, the speaker unlocks at the first click or key.
  const wake = () => {
    audioContext();
    window.removeEventListener('pointerdown', wake, true);
    window.removeEventListener('keydown', wake, true);
  };
  window.addEventListener('pointerdown', wake, true);
  window.addEventListener('keydown', wake, true);
  if (settings.autoPower) {
    await powerOn(false);
  } else {
    await waitForPower(wrap);
    await powerOn();
  }
}

void start();
