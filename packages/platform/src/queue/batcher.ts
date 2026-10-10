import type { JobsOptions } from 'bullmq';
import { fairnessFor, queueFor } from './connection';
import type { BacklogEntry } from './fairness';

interface Pending {
  name: string;
  data: unknown;
  opts: JobsOptions;
  /** Grouped job: its priority is computed at flush, for the whole batch at once. */
  fair?: BacklogEntry;
  resolve: (id: string) => void;
  reject: (err: unknown) => void;
}

const MAX_BULK = 500;
const buffers = new Map<string, Pending[]>();

async function flush(pool: string): Promise<void> {
  const pending = buffers.get(pool) ?? [];
  buffers.delete(pool);
  for (let i = 0; i < pending.length; i += MAX_BULK) {
    const chunk = pending.slice(i, i + MAX_BULK);
    try {
      const grouped = chunk.filter((p) => p.fair);
      if (grouped.length > 0) {
        const priorities = await fairnessFor().priorities(
          pool,
          grouped.map((p) => p.fair as BacklogEntry),
        );
        for (const [j, p] of grouped.entries()) p.opts.priority = priorities[j];
      }
      const jobs = await queueFor(pool).addBulk(chunk.map(({ name, data, opts }) => ({ name, data, opts })));
      for (const [j, p] of chunk.entries()) p.resolve(jobs[j]?.id ?? (p.opts.jobId as string));
    } catch (err) {
      for (const p of chunk) p.reject(err);
    }
  }
}

/**
 * Coalesces enqueues issued in the same tick into one fair-share pipeline + one `addBulk` per pool
 * (two round trips per batch instead of two per job) — the outbox dispatcher fans out hundreds of
 * events at once. Same semantics as `add`: an existing job ID is a no-op. Debounced jobs bypass this
 * (deduplication is per call).
 */
export function addBatched(
  pool: string,
  name: string,
  data: unknown,
  opts: JobsOptions,
  fair?: BacklogEntry,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = buffers.get(pool);
    if (!buffer) {
      buffer = [];
      buffers.set(pool, buffer);
      setImmediate(() => void flush(pool));
    }
    buffer.push({ name, data, opts, fair, resolve, reject });
  });
}
