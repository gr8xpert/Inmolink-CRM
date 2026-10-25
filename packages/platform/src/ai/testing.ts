import type { CacheKey } from '../cache/key';
import type { AiCache } from './gateway';
import type { SpendMirror } from './mirror';
import {
  type AiProvider,
  AiProviderError,
  type ProviderBatchItem,
  type ProviderBatchLookup,
  type ProviderBatchResult,
  type ProviderRequest,
  type ProviderResponse,
} from './provider';
import type { AiBatchClaim, AiJobRecord, AiStore } from './store';

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

  /** S13-F14: like the real lookup — a running batch cannot be identified until it ends. */
  async findBatch({ customIdPrefix }: { customIdPrefix: string }): Promise<ProviderBatchLookup> {
    let running = false;
    for (const [batchId, b] of this.batches) {
      if (!b.items.some((i) => i.customId.startsWith(customIdPrefix))) continue;
      if (b.ended) return { status: 'FOUND', batchId };
      running = true;
    }
    return running ? { status: 'UNKNOWN' } : { status: 'NONE' };
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

/**
 * In-memory usage store (unit tests) with the same reservation semantics as `createPgAiStore`: `spend` is the settled
 * cost per `agency:month`, `reserved` the open reservations.
 */
type MemoryJob = AiJobRecord & { reservedMicroUsd: number; idempotencyKey?: string | null; createdAt?: Date };

export function memoryAiStore(initialSpend: Record<string, number> = {}): AiStore & {
  jobs: MemoryJob[];
  spend: Map<string, number>;
  reserved: Map<string, number>;
  monthSpend(agencyId: string, month: string): Promise<number>;
} {
  const spend = new Map(Object.entries(initialSpend));
  const reserved = new Map<string, number>();
  const jobs: MemoryJob[] = [];
  const claimOf = (j: MemoryJob): AiBatchClaim => ({
    id: j.id,
    status: j.status,
    inputHash: j.inputHash,
    itemCount: j.itemCount,
    providerBatchId: j.providerBatchId,
    createdAt: j.createdAt ?? new Date(0),
  });
  const key = (agencyId: string, month: string) => `${agencyId}:${month}`;
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, Math.max(0, (m.get(k) ?? 0) + v));
  return {
    jobs,
    spend,
    reserved,
    async monthSpend(agencyId, month) {
      return spend.get(key(agencyId, month)) ?? 0;
    },
    async reserve({ agencyId, month, estimateMicroUsd, hardMicroUsd }) {
      const k = key(agencyId, month);
      const spent = spend.get(k) ?? 0;
      const estimate = Math.ceil(estimateMicroUsd);
      if (spent + (reserved.get(k) ?? 0) + estimate > hardMicroUsd) return { ok: false, reason: 'HARD_CAP' };
      add(reserved, k, estimate);
      return { ok: true, spentMicroUsd: spent };
    },
    async settle(job, reservedMicroUsd) {
      if (jobs.some((j) => j.id === job.id)) return;
      const k = key(job.agencyId, job.month);
      if (job.status === 'PENDING') {
        jobs.push({ ...job, reservedMicroUsd });
        return;
      }
      jobs.push({ ...job, reservedMicroUsd: 0 });
      add(spend, k, job.costMicroUsd);
      add(reserved, k, -reservedMicroUsd);
    },
    async release(agencyId, month, reservedMicroUsd) {
      add(reserved, key(agencyId, month), -reservedMicroUsd);
    },
    async batchJob(agencyId, providerBatchId) {
      const job = jobs.find((j) => j.agencyId === agencyId && j.providerBatchId === providerBatchId);
      return job ? { status: job.status, inputHash: job.inputHash, idempotencyKey: job.idempotencyKey ?? null } : null;
    },
    async claimBatch(job, reservedMicroUsd) {
      const existing = jobs.find((j) => j.agencyId === job.agencyId && j.idempotencyKey === job.idempotencyKey);
      if (existing) return { claimed: false, existing: claimOf(existing) };
      jobs.push({ ...job, status: 'PENDING', providerBatchId: null, reservedMicroUsd });
      return { claimed: true };
    },
    async batchClaim(agencyId, idempotencyKey) {
      const job = jobs.find((j) => j.agencyId === agencyId && j.idempotencyKey === idempotencyKey);
      return job ? claimOf(job) : null;
    },
    async attachBatch(agencyId, jobId, providerBatchId) {
      const job = jobs.find((j) => j.agencyId === agencyId && j.id === jobId);
      if (job && job.providerBatchId === null) job.providerBatchId = providerBatchId;
    },
    async dropBatchClaim(agencyId, jobId) {
      const i = jobs.findIndex(
        (j) => j.agencyId === agencyId && j.id === jobId && j.providerBatchId === null && j.status === 'PENDING',
      );
      const job = jobs[i];
      if (!job) return;
      jobs.splice(i, 1);
      add(reserved, key(agencyId, job.month), -job.reservedMicroUsd);
    },
    async settleBatch(input) {
      const job = jobs.find(
        (j) => j.agencyId === input.agencyId && j.providerBatchId === input.providerBatchId && j.status === 'PENDING',
      );
      if (!job) return false;
      const k = key(input.agencyId, job.month);
      job.status = 'SUCCEEDED';
      job.costMicroUsd = input.costMicroUsd;
      job.usage = input.usage;
      add(spend, k, input.costMicroUsd);
      add(reserved, k, -job.reservedMicroUsd);
      job.reservedMicroUsd = 0;
      return true;
    },
  };
}

/** In-memory stand-in for the redis spend mirror (same contract as `createSpendMirror`: base, held, queued). */
export function memorySpendMirror(): SpendMirror & {
  values: Map<string, number>;
  held: Map<string, number>;
  queued: Map<string, number>;
  /** Drops the base, as an expiry or eviction would. */
  expire(agencyId: string, month: string): void;
} {
  const values = new Map<string, number>();
  const held = new Map<string, number>();
  const queued = new Map<string, number>();
  const key = (agencyId: string, month: string) => `${agencyId}:${month}`;
  const take = (m: Map<string, number>, k: string, n: number) => m.set(k, Math.max(0, (m.get(k) ?? 0) - Math.round(n)));
  const put = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + Math.round(n));
  return {
    values,
    held,
    queued,
    expire(agencyId, month) {
      values.delete(key(agencyId, month));
    },
    async reserve(agencyId, month, estimateMicroUsd, hardMicroUsd) {
      const k = key(agencyId, month);
      const base = values.get(k);
      if (base === undefined) return { ok: false, reason: 'UNKNOWN' };
      const spent = base + (queued.get(k) ?? 0);
      const estimate = Math.ceil(estimateMicroUsd);
      if (spent + (held.get(k) ?? 0) + estimate > hardMicroUsd) return { ok: false, reason: 'HARD_CAP' };
      put(held, k, estimate);
      return { ok: true, spentMicroUsd: spent };
    },
    async settle(agencyId, month, reserved, cost) {
      const k = key(agencyId, month);
      take(held, k, reserved);
      if (cost > 0) put(queued, k, cost);
    },
    async release(agencyId, month, reserved) {
      take(held, key(agencyId, month), reserved);
    },
    async recorded(agencyId, month, cost) {
      const k = key(agencyId, month);
      const moved = Math.min(queued.get(k) ?? 0, Math.round(cost));
      take(queued, k, moved);
      const base = values.get(k);
      if (base !== undefined && moved > 0) values.set(k, base + moved);
    },
    async adjust(agencyId, month, delta) {
      const k = key(agencyId, month);
      const v = values.get(k);
      if (v !== undefined) values.set(k, v + Math.round(delta));
    },
    async seed(agencyId, month, spent) {
      const k = key(agencyId, month);
      if (!values.has(k)) values.set(k, spent);
    },
  };
}
