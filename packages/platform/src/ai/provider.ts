import type { AiImage, AiUsage } from './types';

/**
 * Provider abstraction (ADR 0008 #1): the gateway talks to providers only through these interfaces, so a second
 * provider is one new adapter. Modules never import a provider SDK.
 */

export interface ProviderRequest {
  model: string;
  /** Stable part first (system prompt), so provider prefix caching applies (ADR 0008 #5). */
  system: string;
  /** The variable part, last. */
  user: string;
  /** Images, sent before `user` in the same turn. */
  images?: readonly AiImage[];
  /**
   * The repair retry (S12-01 review): the rejected answer goes back as the assistant's turn, followed by a short
   * correction as a new user turn — the original request stays unchanged (and prefix-cached).
   */
  repair?: { previous: string; correction: string };
  maxTokens: number;
  /** JSON schema the answer must follow (structured output), when the caller has one. */
  jsonSchema?: Record<string, unknown>;
}

export interface ProviderResponse {
  text: string;
  usage: AiUsage;
  /** The model answered with a safety refusal (HTTP 200, `stop_reason: refusal`). */
  refused: boolean;
  /** The answer was cut at `maxTokens`. */
  truncated: boolean;
}

export interface ProviderBatchItem {
  customId: string;
  request: ProviderRequest;
}

export type ProviderBatchResult =
  | { customId: string; type: 'succeeded'; response: ProviderResponse }
  | { customId: string; type: 'errored' | 'canceled' | 'expired' };

/**
 * Why a provider call failed. `unavailable` (timeouts, 5xx, overloaded, network) counts against the circuit breaker
 * and is retryable; `rate_limited` (429, after the SDK's own backoff) is retryable but says nothing about the
 * provider's health, so it does not count (S12-01 review); `rejected` (4xx: invalid request, auth, permission) is our
 * fault or config and does not open the breaker either.
 */
export class AiProviderError extends Error {
  override readonly name = 'AiProviderError';
  constructor(
    readonly kind: 'unavailable' | 'rate_limited' | 'rejected',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface AiProvider {
  readonly name: string;
  complete(request: ProviderRequest, options: { signal: AbortSignal }): Promise<ProviderResponse>;
  /** Discounted asynchronous bulk API (ADR 0008 #4). */
  submitBatch(items: readonly ProviderBatchItem[]): Promise<{ batchId: string }>;
  /** Null while the batch is still running. */
  batchResults(batchId: string): Promise<ProviderBatchResult[] | null>;
}

/**
 * Multilingual embeddings behind the same abstraction (ADR 0008 #7). The provider is chosen by `AI_EMBED_PROVIDER`;
 * the only built-in one today is `none` (embeddings switched off — callers degrade), see `createDisabledEmbeddings`.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    options: { signal: AbortSignal },
  ): Promise<{ vectors: number[][]; inputTokens: number }>;
}

export const ZERO_USAGE: AiUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
