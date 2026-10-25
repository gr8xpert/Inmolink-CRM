import Anthropic from '@anthropic-ai/sdk';
import {
  type AiProvider,
  AiProviderError,
  type ProviderBatchItem,
  type ProviderBatchLookup,
  type ProviderBatchResult,
  type ProviderRequest,
  type ProviderResponse,
} from './provider';

/**
 * Anthropic Messages API adapter (ADR 0008). The only file that imports the provider SDK. Model IDs come from the
 * request (env tiers), never from here. The SDK retries 408/409/429/5xx and connection errors itself (`maxRetries`);
 * the gateway's signal cuts the whole call (retries included) at the configured timeout.
 */
export interface AnthropicProviderOptions {
  apiKey: string;
  /** Tests and proxies only; defaults to the SDK's endpoint. */
  baseUrl?: string;
  maxRetries: number;
  /** Per HTTP attempt; the gateway's own timeout bounds the whole call. */
  timeoutMs: number;
  /** Tests: a fake `fetch`. */
  fetch?: typeof fetch;
}

/** Status codes that say "the provider is unwell, try later" — they count against the circuit breaker. */
function isTransient(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status >= 500;
}

export function mapProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  // Connection errors, timeouts and our own abort (the gateway's timeout) are all "unavailable".
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIUserAbortError) {
    return new AiProviderError('unavailable', 'provider unreachable or timed out');
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    // 429 after the SDK's backoff: retry later, but not a sign of an outage (no breaker count) — S12-01 review.
    if (status === 429) return new AiProviderError('rate_limited', 'provider rate limit', status);
    return new AiProviderError(
      isTransient(status) ? 'unavailable' : 'rejected',
      `provider error ${status ?? ''}`.trim(),
      status,
    );
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AiProviderError('unavailable', 'provider call timed out');
  }
  return new AiProviderError('unavailable', 'provider call failed');
}

function messagesOf(request: ProviderRequest): Anthropic.MessageParam[] {
  const images: Anthropic.ImageBlockParam[] = (request.images ?? []).map((image) => ({
    type: 'image',
    source:
      image.type === 'url'
        ? { type: 'url', url: image.url }
        : { type: 'base64', media_type: image.mediaType, data: image.data },
  }));
  const first: Anthropic.MessageParam = {
    role: 'user',
    content: images.length > 0 ? [...images, { type: 'text', text: request.user }] : request.user,
  };
  if (!request.repair) return [first];
  return [
    first,
    { role: 'assistant', content: request.repair.previous || '(empty answer)' },
    { role: 'user', content: request.repair.correction },
  ];
}

function toParams(request: ProviderRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: messagesOf(request),
    ...(request.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: request.jsonSchema } } } : {}),
  };
}

function fromMessage(message: Anthropic.Message): ProviderResponse {
  let text = '';
  for (const block of message.content) if (block.type === 'text') text += block.text;
  const u = message.usage;
  return {
    text,
    refused: message.stop_reason === 'refusal',
    truncated: message.stop_reason === 'max_tokens',
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AiProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries,
    timeout: options.timeoutMs,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    name: 'anthropic',

    async complete(request, { signal }) {
      try {
        return fromMessage(await client.messages.create(toParams(request), { signal }));
      } catch (err) {
        throw mapProviderError(err);
      }
    },

    async submitBatch(items: readonly ProviderBatchItem[]) {
      try {
        const batch = await client.messages.batches.create({
          requests: items.map((item) => ({ custom_id: item.customId, params: toParams(item.request) })),
        });
        return { batchId: batch.id };
      } catch (err) {
        throw mapProviderError(err);
      }
    },

    async batchResults(batchId: string): Promise<ProviderBatchResult[] | null> {
      try {
        const batch = await client.messages.batches.retrieve(batchId);
        if (batch.processing_status !== 'ended') return null;
        const out: ProviderBatchResult[] = [];
        // Results arrive in any order: keyed by custom_id, never by position.
        for await (const entry of await client.messages.batches.results(batchId)) {
          const r = entry.result;
          if (r.type === 'succeeded') {
            out.push({ customId: entry.custom_id, type: 'succeeded', response: fromMessage(r.message) });
          } else {
            out.push({ customId: entry.custom_id, type: r.type });
          }
        }
        return out;
      } catch (err) {
        throw mapProviderError(err);
      }
    },

    async findBatch({ customIdPrefix, createdAfter, createdBefore }): Promise<ProviderBatchLookup> {
      try {
        let running = false;
        // Newest first: stop at the first batch older than the window. A batch has no metadata of ours, so an ended
        // candidate is identified by its first result's custom id; a running one cannot be read yet.
        for await (const batch of client.messages.batches.list({ limit: 100 })) {
          const at = Date.parse(batch.created_at);
          if (at < createdAfter.getTime()) break;
          if (at > createdBefore.getTime()) continue;
          if (batch.processing_status !== 'ended') {
            running = true;
            continue;
          }
          for await (const entry of await client.messages.batches.results(batch.id)) {
            if (entry.custom_id.startsWith(customIdPrefix)) return { status: 'FOUND', batchId: batch.id };
            break;
          }
        }
        return running ? { status: 'UNKNOWN' } : { status: 'NONE' };
      } catch (err) {
        throw mapProviderError(err);
      }
    },
  };
}
