import { describe, expect, it } from 'vitest';
import { DeepSeekError, explain, streamChat, ChatChunk } from '../src/deepseek';
import { toCp437 } from '../src/cp437';

function sse(parts: string[], status = 200): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    (sse as unknown as { last: unknown }).last = { body, headers: init?.headers };
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    return new Response(stream, { status });
  }) as typeof fetch;
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const chunk = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

describe('DeepSeek client', () => {
  it('streams text and thinking, across split SSE lines', async () => {
    const all = chunk({ reasoning_content: 'hmm' }) + chunk({ content: 'Hel' }) + chunk({ content: 'lo' }) + 'data: [DONE]\n\n';
    const parts = [all.slice(0, 7), all.slice(7, 50), all.slice(50)];
    const got = await collect(streamChat({ key: 'sk-x', messages: [{ role: 'user', content: 'hi' }], thinking: true, fetchFn: sse(parts) }));
    expect(got).toEqual([
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
    ]);
    const last = (sse as unknown as { last: { body: Record<string, unknown>; headers: Record<string, string> } }).last;
    expect(last.body.model).toBe('deepseek-flash');
    expect(last.body.stream).toBe(true);
    expect(last.body.reasoning_effort).toBe('high');
    expect(last.headers.Authorization).toBe('Bearer sk-x');
  });

  it('turns HTTP errors into DeepSeekError with a plain explanation', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 })) as typeof fetch;
    let err: unknown;
    try {
      await collect(streamChat({ key: 'k', messages: [], fetchFn }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeepSeekError);
    expect((err as DeepSeekError).status).toBe(402);
    expect(explain(err)).toContain('platform.deepseek.com/top_up');
    expect(explain(new DeepSeekError(401, 'x'))).toContain('AI board panel');
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await expect(collect(streamChat({ key: 'k', messages: [], fetchFn: offline }))).rejects.toMatchObject({ status: 0 });
  });
});

describe('CP437', () => {
  it('maps text to CP437', () => {
    expect(toCp437('Ça “marche” — ok…')).toEqual([0x80, ...[...'a "marche" - ok...'].map((c) => c.charCodeAt(0))]);
    expect(toCp437('█')).toEqual([0xdb]);
  });
});
