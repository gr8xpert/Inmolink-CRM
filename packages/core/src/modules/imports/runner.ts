import { FEED_ERRORS_KEPT, type FeedRunErrorCode } from '@inmolink/contracts';
import { type Tx, withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { isSafeFetchError } from '@inmolink/platform/safe-fetch';
import { isXmlStreamError } from '@inmolink/platform/xml';
import { decryptCredentials, RUNS } from './config';
import { type ConnectorContext, FeedHttpStatusError, getConnector } from './connectors';
import { importsEvents } from './events';
import { type PendingBatch, runFeedPipeline, type ValidItem } from './pipeline';
import * as repo from './repo';

/**
 * Executes one feed run in the worker (`imports.runFeed`, S6-01). Every database step is a short transaction as
 * the agency (`withTenant`, RLS); the feed is read between them, never inside one.
 *
 * Mutual exclusion: the run row is the lock. `claimRun` takes it with a fresh fencing token and a lease; a
 * heartbeat renews the lease; every batch commit locks the row and checks the token before it writes anything —
 * the sink's write included — and the end of the run checks it too. A worker that stalls past its lease and
 * finds the run reclaimed (or failed by the scheduler) stops without writing: two runs of one connection never
 * write at the same time, and at most one QUEUED or RUNNING run exists per connection (unique index).
 */

/** Where valid items go (S6-02 plugs in the staging + MERGE loader); runs inside the fenced batch transaction. */
export interface FeedSink {
  write(
    tx: Tx,
    items: ValidItem[],
    run: { runId: string; agencyId: string; connectionId: string; connector: string },
  ): Promise<{ created: number; updated: number; unchanged: number }>;
}

/** Until the loader lands (S6-02): validates and counts, writes nothing. */
export const countOnlySink: FeedSink = {
  async write() {
    return { created: 0, updated: 0, unchanged: 0 };
  },
};

export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  constructor() {
    super('the run lease was lost to another worker');
  }
}

export type RunOutcome =
  | { kind: 'skipped' }
  | { kind: 'lost' }
  | { kind: 'finished'; state: 'SUCCEEDED' | 'FAILED'; errorCode: FeedRunErrorCode | null };

interface Classified {
  code: FeedRunErrorCode;
  retryable: boolean;
}

/** A failed run's code, and whether another attempt may succeed. Messages are never stored (no feed content). */
export function classifyRunError(err: unknown): Classified {
  if (isSafeFetchError(err)) {
    switch (err.code) {
      case 'INVALID_URL':
      case 'BLOCKED_DESTINATION':
        return { code: 'FEED_DESTINATION_BLOCKED', retryable: false };
      case 'TOO_MANY_REDIRECTS':
        return { code: 'FEED_FETCH_FAILED', retryable: false };
      case 'DNS_FAILED':
      case 'NETWORK':
        return { code: 'FEED_FETCH_FAILED', retryable: true };
      case 'TIMEOUT':
        return { code: 'FEED_TIMEOUT', retryable: true };
      case 'TOO_LARGE':
        return { code: 'FEED_TOO_LARGE', retryable: false };
      case 'CONTENT_TYPE':
        return { code: 'FEED_CONTENT_TYPE', retryable: false };
    }
  }
  if (err instanceof FeedHttpStatusError) {
    return { code: 'FEED_HTTP_STATUS', retryable: err.status >= 500 || err.status === 429 || err.status === 408 };
  }
  if (isXmlStreamError(err)) {
    return err.code === 'DOCTYPE_NOT_ALLOWED'
      ? { code: 'FEED_DTD_NOT_ALLOWED', retryable: false }
      : { code: 'FEED_MALFORMED', retryable: false };
  }
  return { code: 'INTERNAL', retryable: true };
}

export interface RunJobContext {
  log: Logger;
  signal: AbortSignal;
  /** No retry follows this attempt: a retryable error fails the run instead of re-queueing it. */
  lastAttempt: boolean;
}

/** Ends the run (if this worker still holds it) and announces the outcome, in one transaction. */
async function finish(
  agencyId: string,
  runId: string,
  token: string,
  state: 'SUCCEEDED' | 'FAILED',
  errorCode: FeedRunErrorCode | null,
): Promise<boolean> {
  return withTenant({ agencyId }, async (tx) => {
    const done = await repo.finishRun(tx, runId, token, { state, errorCode });
    if (!done) return false;
    await emit(tx, importsEvents.runFinished({ runId, connectionId: done.connectionId, agencyId, state, errorCode }));
    return true;
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function executeRun(
  p: { runId: string; agencyId: string },
  job: RunJobContext,
  sink: FeedSink = countOnlySink,
): Promise<RunOutcome> {
  const { runId, agencyId } = p;
  const token = newId();
  const claim = () => withTenant({ agencyId }, (tx) => repo.claimRun(tx, runId, token, RUNS.LEASE_MS));
  let claimed = await claim();
  if (!claimed) {
    // Held by a live lease: either a healthy worker (it keeps renewing) or one that just crashed and whose job
    // BullMQ handed to us. Wait the lease out once and try again, so a crash costs minutes, not a failed run.
    const lease = await withTenant({ agencyId }, (tx) => repo.runLease(tx, runId));
    const left = lease?.state === 'RUNNING' ? (lease.leaseLeftMs ?? 0) : 0;
    if (left <= 0 || left > RUNS.LEASE_MS + 5_000) return { kind: 'skipped' }; // ended, or nothing to wait for
    await sleep(left + 1_000, job.signal);
    claimed = await claim();
    if (!claimed) return { kind: 'skipped' }; // the holder renewed: it is alive and owns the run
  }
  const connection = await withTenant({ agencyId }, (tx) => repo.connectionForRun(tx, claimed.connectionId));
  if (!connection) return { kind: 'skipped' }; // deleted with its runs meanwhile
  const end = async (state: 'SUCCEEDED' | 'FAILED', code: FeedRunErrorCode | null): Promise<RunOutcome> =>
    (await finish(agencyId, runId, token, state, code))
      ? { kind: 'finished', state, errorCode: code }
      : { kind: 'lost' };

  if (!connection.enabled) return end('FAILED', 'FEED_CONNECTION_DISABLED');
  const connector = getConnector(connection.connector);
  if (!connector) return end('FAILED', 'FEED_CONNECTOR_UNKNOWN');

  const abort = new AbortController();
  const onJobAbort = () => abort.abort(job.signal.reason ?? new Error('job aborted'));
  job.signal.addEventListener('abort', onJobAbort, { once: true });
  const heartbeat = setInterval(() => {
    withTenant({ agencyId }, (tx) => repo.renewLease(tx, runId, token, RUNS.LEASE_MS))
      .then((held) => {
        if (!held) abort.abort(new LeaseLostError());
      })
      .catch((err: unknown) => job.log.warn({ err, runId }, 'feed run lease renewal failed'));
  }, RUNS.HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const ctx: ConnectorContext = {
      connectionId: connection.id,
      agencyId,
      url: connection.url,
      settings: (connection.settings ?? {}) as ConnectorContext['settings'],
      mapping: connection.mapping ?? null,
      credentials: connection.credentialsEnc
        ? decryptCredentials(agencyId, connection.id, connection.credentialsEnc)
        : null,
      signal: abort.signal,
    };
    const commit = (batch: PendingBatch) =>
      withTenant({ agencyId }, async (tx) => {
        const logged = await repo.lockRunForBatch(tx, runId, token);
        if (logged === null) throw new LeaseLostError();
        const counts = await sink.write(tx, batch.valid, {
          runId,
          agencyId,
          connectionId: connection.id,
          connector: connection.connector,
        });
        const keep = batch.errors.slice(0, Math.max(0, FEED_ERRORS_KEPT - logged));
        await repo.insertItemErrors(
          tx,
          keep.map((e) => ({ id: newId(), agencyId, runId, ...e })),
        );
        const held = await repo.addBatchCounts(tx, runId, token, RUNS.LEASE_MS, {
          total: batch.total,
          valid: batch.valid.length,
          failed: batch.errors.length,
          ...counts,
          logged: keep.length,
          bytesRead: batch.bytesRead,
        });
        if (!held) throw new LeaseLostError();
      });
    const totals = await runFeedPipeline({ connector, ctx, batchSize: RUNS.BATCH_SIZE, commit });
    job.log.info({ runId, connector: connection.connector, ...totals }, 'feed run done');
    return await end('SUCCEEDED', null);
  } catch (raw) {
    const err = abort.signal.aborted && abort.signal.reason instanceof LeaseLostError ? abort.signal.reason : raw;
    if (err instanceof LeaseLostError) {
      job.log.warn({ runId }, 'feed run lease lost; another worker owns the run');
      return { kind: 'lost' };
    }
    const { code, retryable } = classifyRunError(err);
    job.log.warn({ runId, code, retryable, err: code === 'INTERNAL' ? err : undefined }, 'feed run failed');
    if (retryable && !job.lastAttempt) {
      const released = await withTenant({ agencyId }, (tx) => repo.releaseRun(tx, runId, token));
      if (!released) return { kind: 'lost' };
      throw err; // the job's next attempt claims the run again
    }
    return end('FAILED', code);
  } finally {
    clearInterval(heartbeat);
    job.signal.removeEventListener('abort', onJobAbort);
  }
}
