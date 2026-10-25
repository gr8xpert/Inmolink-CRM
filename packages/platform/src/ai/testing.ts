import type { CacheKey } from '../cache/key';
import type { AiCache } from './gateway';
import {
  type AiProvider,
  AiProviderError,
  type ProviderBatchItem,
  type ProviderBatchResult,
  type ProviderRequest,
  type ProviderResponse,
} from './provider';
import type { AiJobRecord, AiStore } from './store';

/**
 * Test doubles for the AI gateway (`@inmolink/platform/ai/testing`). Unit and integration tests never call the real
 * provider (recorded responses / a fake provider only).
 */

export type FakeAnswer = string | Partial<ProviderResponse> | AiProviderError | Error;

/** A provider that answers from a script: a function of the request, or a queue of answers. Counts calls. */
export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly calls: ProviderRequest[] = [];
  readonly batches = new Map<string, { items: ProviderBatchItem[]; ended: boolean }>();
  private queue: FakeAnswer[] = [];

  constructor(private respond: (request: ProviderRequest) => FakeAnswer = () => 'ok') {}

  /** Answers the next calls in order (then falls back to the responder). */
  enqueue(...answers: FakeAnswer[]): this {
    this.queue.push(...answers);
    return this;
  }

  /** Every later call fails like a provider outage. */
  failWith(error: Error = new AiProviderError('unavailable', 'fake outage', 529)): this {
    this.respond = () => error;
    this.queue = [];
    return this;
  }

  respondWith(respond: (request: ProviderRequest) => FakeAnswer): this {
    this.respond = respond;
    return this;
  }

  private answer(request: ProviderRequest): ProviderResponse {
    const a = this.queue.length > 0 ? (this.queue.shift() as FakeAnswer) : this.respond(request);
    if (a instanceof Error) throw a;
    const base: ProviderResponse = {
      text: '',
      refused: false,
      truncated: false,
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    return typeof a === 'string' ? { ...base, text: a } : { ...base, ...a };
  }

  async complete(request: ProviderRequest, { signal }: { signal: AbortSignal }): Promise<ProviderResponse> {
    this.calls.push(request);
    signal.throwIfAborted();
    return this.answer(request);
  }

  async submitBatch(items: readonly ProviderBatchItem[]): Promise<{ batchId: string }> {
    const batchId = `fakebatch_${this.batches.size + 1}`;
    this.batches.set(batchId, { items: [...items], ended: false });
    return { batchId };
  }

  /** Marks a submitted batch as ended (the next `batchResults` returns its answers). */
  endBatch(batchId: string): void {
    const b = this.batches.get(batchId);
    if (!b) throw new Error(`unknown batch ${batchId}`);
    b.ended = true;
  }

  async batchResults(batchId: string): Promise<ProviderBatchResult[] | null> {
    const b = this.batches.get(batchId);
    if (!b) throw new AiProviderError('rejected', 'unknown batch', 404);
    if (!b.ended) return null;
    return b.items.map((item) => {
      this.calls.push(item.request);
      try {
        return { customId: item.customId, type: 'succeeded' as const, response: this.answer(item.request) };
      } catch {
        return { customId: item.customId, type: 'errored' as const };
      }
    });
  }
}

/** In-process stand-in for the redis cache (same contract: a loader error is not cached). */
export function memoryAiCache(): AiCache & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async get<T>(key: CacheKey, _options: { ttlSeconds: number }, loader: () => Promise<T>): Promise<T> {
      if (entries.has(key)) return entries.get(key) as T;
      const value = await loader();
      entries.set(key, value);
      return value;
    },
    async set(key: CacheKey, value: unknown) {
      entries.set(key, value);
    },
  };
}

/** In-memory usage store (unit tests); the Postgres one is `createPgAiStore`. */
export function memoryAiStore(initialSpend: Record<string, number> = {}): AiStore & {
  jobs: AiJobRecord[];
  spend: Map<string, number>;
} {
  const spend = new Map(Object.entries(initialSpend));
  const jobs: AiJobRecord[] = [];
  const key = (agencyId: string, month: string) => `${agencyId}:${month}`;
  return {
    jobs,
    spend,
    async monthSpend(agencyId, month) {
      return spend.get(key(agencyId, month)) ?? spend.get(agencyId) ?? 0;
    },
    async record(job) {
      jobs.push(job);
      if (job.status !== 'PENDING') {
        spend.set(key(job.agencyId, job.month), (spend.get(key(job.agencyId, job.month)) ?? 0) + job.costMicroUsd);
      }
    },
    async settleBatch(input) {
      const job = jobs.find(
        (j) => j.agencyId === input.agencyId && j.providerBatchId === input.providerBatchId && j.status === 'PENDING',
      );
      if (!job) return false;
      job.status = 'SUCCEEDED';
      job.costMicroUsd = input.costMicroUsd;
      job.usage = input.usage;
      const k = key(input.agencyId, input.month);
      spend.set(k, (spend.get(k) ?? 0) + input.costMicroUsd);
      return true;
    },
  };
}
