// The Ok-Prompt AI board with a fake DeepSeek, through the real modem.
import { describe, expect, it } from 'vitest';
import { BOFH_PICKUP, cleanProgram, createAiBoard, PROGRAM_PROMPT } from '../src/aiboard';
import type { ChatChunk, ChatOptions } from '../src/deepseek';
import { Modem } from '../src/msx/modem';

function setup(initialKey: string | null, hasBasic = true) {
  let key = initialKey;
  const calls: ChatOptions[] = [];
  const answers: ChatChunk[][] = [];
  const recorded: { name: string; program: string }[] = [];
  const modem = new Modem({ windowSize: () => [40, 24] });
  modem.dialer = (target, handlers) => {
    expect(target.host).toBe('deepseek');
    return createAiBoard(handlers, {
      getKey: () => key,
      setKey: (k) => { key = k; },
      chat: (opts) => {
        calls.push(opts);
        const reply = answers.shift() ?? [{ kind: 'text', text: '(no answer)' }];
        return (async function* () { for (const c of reply) yield c; })();
      },
      record: (name, program) => recorded.push({ name, program }),
      hasBasic: () => hasBasic,
      schedule: (fn) => { setTimeout(fn, 0); },
      cps: 0,
    });
  };
  let screen = '';
  const drain = () => { while (modem.available) screen += String.fromCharCode(modem.read()); return screen; };
  const type = (s: string) => { for (const c of s) modem.write(c.charCodeAt(0)); };
  const waitFor = async (text: string) => {
    for (let i = 0; i < 200; i++) {
      if (drain().includes(text)) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`never saw "${text}" in:\n${screen}`);
  };
  /** Text since the last call. */
  let seen = 0;
  const fresh = () => { drain(); const s = screen.slice(seen); seen = screen.length; return s; };
  return { modem, type, waitFor, fresh, calls, answers, recorded, getKey: () => key, screen: () => drain() };
}

describe('the AI board', () => {
  it('asks for a key, then chats in lines that fit 40 columns', async () => {
    const t = setup(null);
    t.type('ATDT DEEPSEEK\r');
    await t.waitFor('Key: ');
    t.type('sk-test-123456\r');
    await t.waitFor('Choice: ');
    expect(t.getKey()).toBe('sk-test-123456');
    t.answers.push([{ kind: 'text', text: 'Hello caller! The MSX was announced in June 1983 by ASCII and Microsoft, and the Expert came to Brazil in 1985.' }]);
    t.type('C');
    await t.waitFor('You> ');
    t.type('hi\r');
    await t.waitFor('1985.');
    expect(t.calls[0].messages[0].content).toContain('MSX');
    const text = t.screen().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    for (const line of text.split('\r\n')) expect(line.length, line).toBeLessThanOrEqual(39);
  });

  it('puts you through to the BOFH, who may hang up on you', async () => {
    const t = setup('k');
    t.type('ATDT DEEPSEEK\r');
    await t.waitFor('Choice: ');
    t.answers.push([{ kind: 'text', text: 'Machine room.' }]);
    t.answers.push([{ kind: 'text', text: 'Your MSX is fine.\n[HANGUP]' }]);
    t.type('B');
    await t.waitFor('Machine room.');
    expect(t.calls[0].messages.at(-1)?.content).toBe(BOFH_PICKUP);
    t.type('help\r');
    await t.waitFor('*click*');
    await t.waitFor('NO CARRIER');
    expect(t.screen()).not.toContain('[HANGUP]');
  });

  it('writes a BASIC program, records it on the tape, and takes changes', async () => {
    const t = setup('k');
    t.type('ATDT DEEPSEEK\r');
    await t.waitFor('Choice: ');
    t.answers.push([
      { kind: 'thinking', text: 'A short guessing game.' },
      { kind: 'text', text: 'Here:\n```basic\n10 CLS\n20 PRINT "OI"\n30 END\n```\nEnjoy!' },
    ]);
    t.type('P');
    await t.waitFor('Program: ');
    t.type('a greeting\r');
    await t.waitFor('digits: ');
    t.type('toolong7\r');
    await t.waitFor('Name: ');
    t.type('oi\r');
    await t.waitFor('Change: ');
    expect(t.calls[0].messages[0].content).toBe(PROGRAM_PROMPT);
    expect(t.calls[0].thinking).toBe(true);
    expect(t.recorded).toEqual([{ name: 'OI', program: '10 CLS\n20 PRINT "OI"\n30 END\n' }]);
    expect(t.screen()).toContain('RUN"CAS:"');
    t.answers.push([{ kind: 'text', text: '10 CLS\n20 PRINT "OLA"\n30 END' }]);
    t.type('say ola\r');
    for (let i = 0; i < 200 && t.recorded.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    expect(t.recorded[1].program).toContain('OLA');
    expect(t.calls[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    t.type('\r');
    await t.waitFor('Choice: ');
  });

  it('warns that C-BIOS has no BASIC to run the program', async () => {
    const t = setup('k', false);
    t.type('ATDT DEEPSEEK\r');
    await t.waitFor('Choice: ');
    t.answers.push([{ kind: 'text', text: '10 PRINT 1' }]);
    t.type('P');
    await t.waitFor('Program: ');
    t.type('x\r');
    await t.waitFor('digits: ');
    t.type('X\r');
    await t.waitFor('Change: ');
    expect(t.screen()).toContain('System ROM');
  });

  it('keeps only numbered lines from what the model sends', () => {
    expect(cleanProgram('Sure!\n10 PRINT "A"\n  20 GOTO 10\nThat is all.')).toBe('10 PRINT "A"\n20 GOTO 10\n');
    expect(cleanProgram('no program here')).toBe('');
  });
});
