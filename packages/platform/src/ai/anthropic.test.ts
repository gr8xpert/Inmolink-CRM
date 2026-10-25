import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic';
import { AiProviderError } from './provider';

/** A recorded Messages API answer (shape of `POST /v1/messages`), no network. */
const recordedMessage = (over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'fast-model',
  content: [{ type: 'text', text: '{"title":"Villa"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
  ...over,
});

function fakeFetch(status: number, body: unknown, seen: { url: string; body: Record<string, unknown> }[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const provider = (f: typeof fetch) =>
  createAnthropicProvider({ apiKey: 'test-key', baseUrl: 'http://ai.test', maxRetries: 0, timeoutMs: 5_000, fetch: f });

const request = {
  model: 'fast-model',
  system: 'You write listing copy.',
  user: '{"beds":3}',
  maxTokens: 500,
  jsonSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
};
const signal = () => AbortSignal.timeout(5_000);

describe('Anthropic provider adapter', () => {
  it('[S12-01] sends the tier model, system first and the input last, with the JSON schema as output format', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const res = await provider(fakeFetch(200, recordedMessage(), seen)).complete(request, { signal: signal() });
    expect(seen[0]?.url).toBe('http://ai.test/v1/messages');
    expect(seen[0]?.body).toEqual({
      model: 'fast-model',
      max_tokens: 500,
      system: 'You write listing copy.',
      messages: [{ role: 'user', content: '{"beds":3}' }],
      output_config: { format: { type: 'json_schema', schema: request.jsonSchema } },
    });
    expect(res).toEqual({
      text: '{"title":"Villa"}',
      refused: false,
      truncated: false,
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });

  it('[S12-01] images go before the text; a repair is the rejected answer as an assistant turn plus a correction', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    await provider(fakeFetch(200, recordedMessage(), seen)).complete(
      {
        ...request,
        images: [
          { type: 'url', url: 'https://cdn.example.test/a.jpg' },
          { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
        repair: { previous: '{"title":1}', correction: 'Fix the title.' },
      },
      { signal: signal() },
    );
    expect(seen[0]?.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://cdn.example.test/a.jpg' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'text', text: '{"beds":3}' },
        ],
      },
      { role: 'assistant', content: '{"title":1}' },
      { role: 'user', content: 'Fix the title.' },
    ]);
  });

  it('[S12-01] a refusal is reported, not thrown', async () => {
    const res = await provider(fakeFetch(200, recordedMessage({ content: [], stop_reason: 'refusal' }))).complete(
      request,
      { signal: signal() },
    );
    expect(res.refused).toBe(true);
  });

  it('[S12-01] overloaded / 5xx are "unavailable" (breaker), 429 "rate_limited"; 400 / 401 are "rejected"', async () => {
    const err = (status: number) => ({ type: 'error', error: { type: 'x', message: 'x' }, status });
    for (const [status, kind] of [
      [529, 'unavailable'],
      [500, 'unavailable'],
      [429, 'rate_limited'],
      [400, 'rejected'],
      [401, 'rejected'],
    ] as const) {
      const p = provider(fakeFetch(status, err(status)));
      const failure = await p.complete(request, { signal: signal() }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AiProviderError);
      expect(failure).toMatchObject({ kind, status });
    }
  });

  it('[S12-01] a timeout is "unavailable"', async () => {
    const hang = (async (_i: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )) as typeof fetch;
    const failure = await provider(hang)
      .complete(request, { signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: 'unavailable' });
  });
});
