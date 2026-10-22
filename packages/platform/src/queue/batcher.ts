import type { JobsOptions } from 'bullmq';
import { fairnessFor, queueFor } from './connection';
import type { BacklogEntry } from './fairness';

interface Pending extends BulkEntry {
  resolve: (id: string) => void;
  reject: (err: unknown) => void;
}

/** Entries per BullMQ `addBulk` (one pipeline each). */
export const MAX_BULK = 500;
const buffers = new Map<string, Pending[]>();

/** A job for `addBulkFair`; a grouped job's priority is computed for the whole chunk at once. */
export interface BulkEntry {
  name: string;
  data: unknown;
  opts: JobsOptions;
  fair?: BacklogEntry;
}

/**
 * Adds jobs in chunks of `MAX_BULK`: one fair-share pipeline (priorities of the grouped jobs) and one BullMQ `addBulk`
 * per chunk — two round trips per chunk instead of two per job. Same semantics as `add` per entry (an existing job ID
 * is a no-op; deduplication — debounce, throttle — applies per entry in BullMQ's add script). `onChunk` gets each
 * chunk's ids, or its error (then the next chunk is still tried); without it a failing chunk throws.
 */
export async function addBulkFair(
  pool: string,
  entries: readonly BulkEntry[],
  onChunk?: (start: number, result: { ids: string[] } | { error: unknown }) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < entries.length; i += MAX_BULK) {
    const chunk = entries.slice(i, i + MAX_BULK);
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
      const chunkIds = chunk.map((p, j) => jobs[j]?.id ?? (p.opts.jobId as string));
      ids.push(...chunkIds);
      onChunk?.(i, { ids: chunkIds });
    } catch (err) {
      if (!onChunk) throw err;
      onChunk(i, { error: err });
    }
  }
  return ids;
}

async function flush(pool: string): Promise<void> {
  const pending = buffers.get(pool) ?? [];
  buffers.delete(pool);
  await addBulkFair(pool, pending, (start, result) => {
    const chunk = pending.slice(start, start + MAX_BULK);
    if ('ids' in result) for (const [j, p] of chunk.entries()) p.resolve(result.ids[j] as string);
    else for (const p of chunk) p.reject(result.error);
  });
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
