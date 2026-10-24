/**
 * Ok-Prompt's page: the MSX in the monitor, its cartridge slots on the
 * console deck, and the panels for the machine, display, sound and controls.
 */
import './style.css';
import { unzipSync } from 'fflate';
import mainRomUrl from './roms/cbios_main_msx1.rom?url';
import logoRomUrl from './roms/cbios_logo_msx1.rom?url';
import { Cartridge, MAPPERS, Mapper } from './msx/cartridge';
import { msxKey, SPECIAL_KEYS } from './msx/keyboard';
import { checkBios, CYCLES_PER_LINE, Msx, REGIONS, Region } from './msx/machine';
import { loadCommand, Tape } from './msx/tape';
import { HEIGHT, WIDTH } from './msx/vdp';
import { audioContext } from './ui/audio';
import { askConfirm } from './ui/confirm';
import { waitForPower, warmUp } from './ui/power';
import { SoundOut } from './ui/sound-out';
import { loadBios, loadCart, loadShelf, loadTape, saveBios, saveCart, saveTape, shelve, StoredCart, unshelve } from './ui/store';

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
  /** The system ROM: the built-in C-BIOS or the player's own. */
  bios: 'cbios' | 'own';
}

const DEFAULTS: Settings = {
  region: 'ntsc', speed: 1, smooth: false, scanlines: true, curve: true,
  flicker: false, humbar: false, volume: 70, autoPower: false, bios: 'cbios',
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

async function start(): Promise<void> {
  const [main, logo] = await Promise.all([bytes(mainRomUrl), bytes(logoRomUrl)]);
  const cbios = { main, logo };
  const msx = new Msx(cbios, SAMPLE_RATE);
  let ownBios = await loadBios();
  if (settings.bios === 'own' && ownBios) msx.setBios({ main: ownBios.data });
  const sound = new SoundOut(SAMPLE_RATE);
  const wrap = $('screen-wrap');
  const canvas = $<HTMLCanvasElement>('screen');
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(WIDTH, HEIGHT);
  const pixels = new Uint32Array(image.data.buffer);
  let running = false;

  const draw = () => {
    pixels.set(msx.vdp.frame);
    g.putImageData(image, 0, 0);
  };
  const blank = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, WIDTH, HEIGHT);
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

  const keys = $('special-keys');
  for (const [msxName, pc] of SPECIAL_KEYS) keys.insertAdjacentHTML('beforeend', `<dt>${msxName}</dt><dd>${pc}</dd>`);

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
    const sel = el.querySelector<HTMLSelectElement>('.mapper')!;
    if (cart) sel.value = cart.mapper;
  };

  const insert = (n: 1 | 2, stored: StoredCart | null, persist = true) => {
    msx.insert(n, stored ? new Cartridge(stored.data, stored.mapper as Mapper | undefined, stored.name) : null);
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
      const pick = files.find(([n]) => /\.(rom|mx1|mx2|bin|cas)$/i.test(n)) ?? files.sort((a, b) => b[1].length - a[1].length)[0];
      if (!pick) throw new Error('no ROM inside the zip');
      [name, data] = pick;
    }
    if (data.length > max) throw new Error(`too big for ${what}`);
    return { name: name.replace(/^.*\//, ''), data };
  };

  const isTape = (name: string) => /\.cas$/i.test(name);

  const load = async (file: File, n: 1 | 2) => {
    try {
      const rom = await readRom(file);
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
    const inSlots = [...msx.cartridges.map((c) => c?.name), msx.tape?.name];
    for (const li of shelfList.children) {
      li.classList.toggle('inserted', inSlots.includes((li as HTMLElement).dataset.name));
    }
  }
  async function showShelf(): Promise<void> {
    const carts = await loadShelf();
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
      if (isTape(cart.name)) {
        button('shelf-cart', cart.name, `Put the tape ${cart.name} in the tape deck`, () => insertTape(cart));
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
    $('tape-pos').textContent = t && t.length ? `${Math.round((t.pos / t.length) * 100)}%` : '';
  };
  function showTape(): void {
    const t = msx.tape;
    tapeEl.classList.toggle('full', Boolean(t));
    const first = t?.first();
    $('tape-label').textContent = !t
      ? 'No tape: click or drop a .cas'
      : first ? `${t.name} · ${first.name || 'no name'} (${KIND_LABEL[first.kind]})` : `${t.name} · blank`;
    showTapePos();
    markShelf();
  }
  function insertTape(stored: StoredCart | null, persist = true): void {
    msx.tape = stored ? new Tape(stored.data, stored.name) : null;
    if (persist) void saveTape(stored);
    tapeNote.textContent = stored && settings.bios !== 'own'
      ? 'Tapes load from MSX BASIC: pick your own BIOS under System ROM (C-BIOS has no BASIC).'
      : '';
    showTape();
  }
  msx.onTapeWritten = (t) => {
    const stored = { name: t.name, data: t.data.slice() };
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
    if (!t) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t.data.slice()], { type: 'application/octet-stream' }));
    a.download = t.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('tape-play').addEventListener('click', async () => {
    const t = msx.tape;
    const first = t?.first();
    if (!t) return;
    if (!first) { tapeNote.textContent = 'No MSX file found at the start of this tape.'; return; }
    if (settings.bios !== 'own') {
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
  const showBios = () => {
    while (biosSel.options.length > 1) biosSel.remove(1);
    if (ownBios) biosSel.add(new Option(ownBios.name, 'own'));
    biosSel.value = settings.bios === 'own' && ownBios ? 'own' : 'cbios';
    $('bios-remove').hidden = !ownBios;
  };
  const useBios = async (which: 'cbios' | 'own') => {
    settings.bios = which;
    save();
    msx.setBios(which === 'own' && ownBios ? { main: ownBios.data } : cbios);
    showBios();
    if (which === 'own') tapeNote.textContent = '';
    if (running) await powerOn();
  };
  biosSel.addEventListener('change', () => void useBios(biosSel.value as 'cbios' | 'own'));
  $('bios-load').addEventListener('click', () => biosFile.click());
  biosFile.addEventListener('change', async () => {
    const file = biosFile.files?.[0];
    biosFile.value = '';
    if (!file) return;
    try {
      const rom = await readRom(file, 0x10000, 'an MSX1 system ROM');
      checkBios(rom.data);
      ownBios = rom;
      await saveBios(rom);
      biosNote.textContent = biosNoteText;
      await useBios('own');
    } catch (e) {
      biosNote.textContent = `Could not use ${file.name}: ${(e as Error).message}`;
    }
  });
  $('bios-remove').addEventListener('click', async () => {
    const yes = await askConfirm({
      title: 'Remove your BIOS?',
      message: `${ownBios?.name} will be forgotten by this browser and the MSX goes back to C-BIOS.`,
      ok: 'Remove',
    });
    if (!yes) return;
    ownBios = undefined;
    await saveBios(null);
    await useBios('cbios');
  });
  showBios();

  // ---- keyboard and gamepad ------------------------------------------------

  const typing = (e: Event) => (e.target as HTMLElement | null)?.closest('input, select, textarea, dialog');
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (!running || typing(e) || e.metaKey) return;
    const pos = msxKey(e.code);
    if (!pos) return;
    e.preventDefault();
    msx.ppi.key(pos[0], pos[1], down);
  };
  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => msx.ppi.rows.fill(0xff));

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
