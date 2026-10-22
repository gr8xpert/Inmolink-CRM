import {
  FEED_ERRORS_KEPT,
  type FeedPauseDetails,
  type FeedPauseReason,
  type FeedRunErrorCode,
} from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import { isSafeFetchError } from '@inmolink/platform/safe-fetch';
import { isSheetError } from '@inmolink/platform/sheet';
import { isXmlStreamError } from '@inmolink/platform/xml';
import {
  ANOMALY,
  anomalyThresholds,
  decryptCredentials,
  FEED_CONFIRM_REFRESH_DAYS,
  feedFreshnessDays,
  RUNS,
  SOURCE_HASH_TRUST_DAYS,
} from './config';
import { type ConnectorContext, FeedHttpStatusError, FeedMappingError, getConnector } from './connectors';
import { importsEvents } from './events';
import { emptyFeed, FeedAnomalyError, massWithdrawal, recordPause, typicalVolume, volumeSpike } from './guard';
import { FeedNoOwnerError, type FeedSink, listingSink, type RunLoader } from './load';
import { type ItemError, type PendingBatch, runFeedPipeline } from './pipeline';
import * as repo from './repo';
import { ResalesApiError, ResalesConfigError } from './resales/connector';
import { SheetFileMissingError } from './sheet/connector';

/**
 * Executes one feed run in the worker (`imports.runFeed`, S6-01). Every database step is a short transaction as
 * the agency (`withTenant`, RLS); the feed is read between them, never inside one.
 *
 * Mutual exclusion: the run row is the lock. `claimRun` takes it with a fresh fencing token and a lease; a
 * heartbeat renews the lease; every batch commit locks the row and checks the token before it writes anything —
 * the loader's write included — and the end of the run checks it too (the loader's withdrawals are fenced by it). A worker that stalls past its lease and
 * finds the run reclaimed (or failed by the scheduler) stops without writing: two runs of one connection never
 * write at the same time, and at most one QUEUED or RUNNING run exists per connection (unique index).
 */

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
  if (err instanceof FeedMappingError) return { code: 'FEED_MAPPING_INVALID', retryable: false };
  if (err instanceof SheetFileMissingError) return { code: 'FEED_FETCH_FAILED', retryable: false };
  if (isSheetError(err)) {
    // CSV / Excel files (S6-05): nothing about the file changes between attempts.
    switch (err.code) {
      case 'TOO_MANY_ROWS':
      case 'TOO_MANY_COLUMNS':
      case 'CELL_TOO_LARGE':
      case 'ZIP_BOMB':
        return { code: 'FEED_TOO_LARGE', retryable: false };
      case 'NOT_SHEET':
      case 'NOT_TEXT':
      case 'UNSUPPORTED_XLS':
      case 'ENCRYPTED':
        return { code: 'FEED_CONTENT_TYPE', retryable: false };
      default:
        return { code: 'FEED_MALFORMED', retryable: false };
    }
  }
  if (isXmlStreamError(err)) {
    return err.code === 'DOCTYPE_NOT_ALLOWED'
      ? { code: 'FEED_DTD_NOT_ALLOWED', retryable: false }
      : { code: 'FEED_MALFORMED', retryable: false };
  }
  // Resales Online (S6-F4): bad configuration, or the API refused (credentials after the busy retries, a wrong filter
  // alias, …): retrying only re-sends the key. A non-2xx status retries like any feed's; an unusable answer is final.
  if (err instanceof ResalesConfigError) {
    if (err.reason === 'CREDENTIALS_REQUIRED') return { code: 'FEED_CREDENTIALS_REJECTED', retryable: false };
    if (err.reason === 'FILTER_ALIAS_INVALID') return { code: 'FEED_SETTINGS_INVALID', retryable: false };
    return { code: 'FEED_DESTINATION_BLOCKED', retryable: false };
  }
  if (err instanceof ResalesApiError) {
    switch (err.kind) {
      case 'HTTP': {
        const status = err.status ?? 0;
        return { code: 'FEED_HTTP_STATUS', retryable: status >= 500 || status === 429 || status === 408 };
      }
      case 'CREDENTIALS':
        return { code: 'FEED_CREDENTIALS_REJECTED', retryable: false };
      // The run's deadline (sized to the account): without a checkpoint a retry would start over and hit it again.
      case 'DEADLINE':
        return { code: 'FEED_TIMEOUT', retryable: false };
      case 'MALFORMED':
        return { code: 'FEED_MALFORMED', retryable: false };
      default:
        return { code: 'FEED_HTTP_STATUS', retryable: false };
    }
  }
  return { code: 'INTERNAL', retryable: true };
}

export interface RunJobContext {
  log: Logger;
  signal: AbortSignal;
  /** No retry follows this attempt: a retryable error fails the run instead of re-queueing it. */
  lastAttempt: boolean;
}

const DAY_MS = 24 * 3_600_000;

interface Pause {
  reason: FeedPauseReason;
  details: FeedPauseDetails;
}

const PAUSE_CODES: Record<FeedPauseReason, FeedRunErrorCode> = {
  VOLUME_SPIKE: 'FEED_PAUSED_VOLUME_SPIKE',
  MASS_WITHDRAWAL: 'FEED_PAUSED_MASS_WITHDRAWAL',
  EMPTY_FEED: 'FEED_PAUSED_EMPTY_FEED',
};

/**
 * Ends the run (if this worker still holds it) and announces the outcome, in one transaction: the loader's end of
 * run — withdrawals after a success, cleanup after a failure — commits with it or not at all.
 *
 * S6-08: a success is checked by the anomaly guard first (unless the connection was resumed with "accept the
 * change"): when too many of the feed's listings vanished at once the run ends FAILED (`FEED_PAUSED_MASS_WITHDRAWAL`),
 * withdraws nothing, counts no miss, and the connection is paused. A spike (`pause` given) pauses it the same way. A
 * S7-F1: a run that read no valid item (an empty feed, or every item failed) while the connection still has live
 * listings ends FAILED (`FEED_PAUSED_EMPTY_FEED`) and pauses the connection the same way — it never withdraws them
 * (S6-02), and it is not a silent success either. "Accept the change" lets one such run succeed (still withdrawing
 * nothing). A real success records whether the feed changed and, while it changed within `IMPORT_FEED_FRESHNESS_DAYS`, confirms
 * its listings' freshness (S3-08) — after the commit, in short transactions of its own (best effort: the next run
 * confirms what a failure here left).
 */
async function finish(
  agencyId: string,
  runId: string,
  token: string,
  outcome: {
    state: 'SUCCEEDED' | 'FAILED';
    errorCode: FeedRunErrorCode | null;
    pause?: Pause;
    valid?: number;
    total?: number;
    /** S6-F4: the connector keeps source hashes; a success drops those of references it did not see. */
    pruneSourceHashes?: boolean;
  },
  loader: RunLoader | null,
  guard: { skip: boolean },
  log: Logger,
): Promise<{ state: 'SUCCEEDED' | 'FAILED'; errorCode: FeedRunErrorCode | null } | null> {
  const result = await withTenant({ agencyId }, async (tx) => {
    let { state, errorCode, pause } = outcome;
    let missing = 0;
    let confirmBefore: Date | undefined;
    if (loader && state === 'SUCCEEDED') {
      const valid = outcome.valid ?? 0;
      const stats = await loader.dropStats(tx);
      // A run with nothing valid withdraws nothing anyway (S6-02: a broken feed is not an empty portfolio); S7-F1:
      // with live listings it pauses the connection instead of ending as a silent success.
      if (valid > 0) missing = stats.missing;
      const tripped = guard.skip
        ? null
        : valid === 0
          ? emptyFeed(stats.live, outcome.total ?? 0)
          : massWithdrawal(stats.live, stats.missing, anomalyThresholds().dropRatio);
      if (tripped) {
        const reason = valid === 0 ? 'EMPTY_FEED' : 'MASS_WITHDRAWAL';
        pause = { reason, details: tripped };
        state = 'FAILED';
        errorCode = PAUSE_CODES[reason];
      }
    }
    const done = await repo.finishRun(tx, runId, token, { state, errorCode });
    if (!done) return null;
    if (loader && state === 'SUCCEEDED') {
      const changed = done.itemsCreated + done.itemsUpdated > 0 || missing > 0;
      const changedAt = await repo.recordRunSuccess(tx, done.connectionId, changed);
      const now = clock.now().getTime();
      const alive = changedAt !== null && now - changedAt.getTime() <= feedFreshnessDays() * DAY_MS;
      if (alive) confirmBefore = new Date(now - FEED_CONFIRM_REFRESH_DAYS * DAY_MS);
      const withdrawn = await loader.finish(tx, { valid: done.itemsValid });
      if (withdrawn > 0) await repo.setWithdrawn(tx, runId, withdrawn);
      if (outcome.pruneSourceHashes && (outcome.valid ?? 0) > 0)
        await repo.pruneSourceHashes(tx, { agencyId, connectionId: done.connectionId, runId });
    } else if (loader) await loader.abandon(tx);
    const events: OutboxMessage[] = [
      importsEvents.runFinished({ runId, connectionId: done.connectionId, agencyId, state, errorCode }),
    ];
    if (pause) {
      await repo.pauseConnection(tx, done.connectionId, { reason: pause.reason, details: pause.details, runId });
      events.push(
        importsEvents.connectionPaused({ runId, connectionId: done.connectionId, agencyId, reason: pause.reason }),
      );
    }
    await emit(tx, events);
    return { state, errorCode, pause, confirmBefore };
  });
  if (result?.pause) recordPause(result.pause.reason); // after the commit: counts only real pauses
  if (loader?.afterRun) {
    try {
      await loader.afterRun();
    } catch (err) {
      log.warn({ err, runId }, 'feed run end-of-run bookkeeping failed');
    }
  }
  if (result?.confirmBefore && loader) {
    try {
      await loader.confirmFresh(result.confirmBefore);
    } catch (err) {
      log.warn({ err, runId }, 'freshness confirmation from the feed failed; the next run retries it');
    }
  }
  return result ? { state: result.state, errorCode: result.errorCode } : null;
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
  sink: FeedSink = listingSink,
): Promise<RunOutcome> {
  const { runId, agencyId } = p;
  const token = newId();
  // A re-claimed run's leftovers (the sink's seen references) go in the claiming transaction: fenced by the claim,
  // like `claimRun` clearing the earlier attempt's item errors (S7-F2 review).
  const claim = () =>
    withTenant({ agencyId }, async (tx) => {
      const c = await repo.claimRun(tx, runId, token, RUNS.LEASE_MS);
      if (c && c.attempt > 1) await sink.reset?.(tx, runId);
      return c;
    });
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
  const [connection, baseline] = await withTenant({ agencyId }, async (tx) => {
    const c = await repo.connectionForRun(tx, claimed.connectionId);
    // S6-08: the feed's typical volume (none once "accept the change" was chosen on resume)
    const totals = c && !c.acceptAnomalyOnce ? await repo.recentSucceededTotals(tx, c.id, ANOMALY.BASELINE_RUNS) : [];
    return [c, typicalVolume(totals)] as const;
  });
  if (!connection) return { kind: 'skipped' }; // deleted with its runs meanwhile
  let loader: RunLoader | null = null;
  let hashes = false;
  const guard = { skip: connection.acceptAnomalyOnce };
  const end = async (
    state: 'SUCCEEDED' | 'FAILED',
    code: FeedRunErrorCode | null,
    extra: { pause?: Pause; valid?: number; total?: number } = {},
  ): Promise<RunOutcome> => {
    const outcome = { state, errorCode: code, pruneSourceHashes: hashes, ...extra };
    const ended = await finish(agencyId, runId, token, outcome, loader, guard, job.log);
    return ended ? { kind: 'finished', ...ended } : { kind: 'lost' };
  };

  if (!connection.enabled) return end('FAILED', 'FEED_CONNECTION_DISABLED');
  // Paused by the anomaly guard (S6-08): neither scheduled nor runnable until resumed; a run queued before stops here.
  if (connection.pausedAt) return end('FAILED', 'FEED_CONNECTION_PAUSED');
  const connector = getConnector(connection.connector);
  if (!connector) return end('FAILED', 'FEED_CONNECTOR_UNKNOWN');
  hashes = connector.sourceHashes === true;
  const hashScope = { agencyId, connectionId: connection.id, runId };
  /** Connector counters (S6-F4), logged with the run's outcome. */
  let sourceStats: Record<string, number> | undefined;

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
    const runLoader = await sink.start({
      runId,
      agencyId,
      connectionId: connection.id,
      connector: connection.connector,
      settings: (connection.settings ?? {}) as Record<string, unknown>,
      startedAt: claimed.startedAt,
    });
    loader = runLoader;
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
      ...(hashes
        ? {
            sourceHashes: (refs: readonly string[]) =>
              withTenant({ agencyId }, (tx) =>
                repo.freshSourceHashes(
                  tx,
                  hashScope,
                  refs,
                  new Date(clock.now().getTime() - SOURCE_HASH_TRUST_DAYS * DAY_MS),
                ),
              ),
          }
        : {}),
    };
    const { spikeFactor } = anomalyThresholds();
    let read = 0;
    // Items the batches stored (the run's `items_valid`): the pipeline's valid ones minus those the loader refused.
    let stored = 0;
    const commit = async (batch: PendingBatch) => {
      // S6-08 volume spike: stop before writing the batch that crosses factor × the typical item count.
      const spike = guard.skip ? null : volumeSpike(read + batch.total, baseline, spikeFactor);
      if (spike) throw new FeedAnomalyError('VOLUME_SPIKE', spike);
      read += batch.total;
      // Outside the fenced transaction: item checks and taxonomy resolution (their own short transactions).
      const { prepared, errors: prepErrors } = await runLoader.prepare(batch.valid);
      await withTenant({ agencyId }, async (tx) => {
        const logged = await repo.lockRunForBatch(tx, runId, token);
        if (logged === null) throw new LeaseLostError();
        const failedBefore = [...batch.errors, ...prepErrors];
        // Failed items still in the feed (they have a reference) and items seen only (S6-F4: unchanged, not
        // written): never counted missing, never withdrawn.
        const seenRefs = [...failedBefore.flatMap((e) => (e.itemRef?.trim() ? [e.itemRef.trim()] : [])), ...batch.seen];
        const { errors: writeErrors, ...counts } = await runLoader.write(tx, prepared, seenRefs);
        if (hashes) {
          // Only items the loader stored (written or unchanged) get their hash; failed ones keep the old one.
          const failedRefs = new Set(writeErrors.flatMap((e) => (e.itemRef ? [e.itemRef] : [])));
          for (const e of prepErrors) if (e.itemRef) failedRefs.add(e.itemRef);
          const stored = batch.valid.flatMap((v) =>
            v.sourceHash && !failedRefs.has(v.ref) ? [{ ref: v.ref, hash: v.sourceHash }] : [],
          );
          await repo.recordSourceHashes(tx, hashScope, stored, seenRefs);
        }
        const errors: ItemError[] = [...failedBefore, ...writeErrors].sort((a, b) => a.position - b.position);
        const keep = errors.slice(0, Math.max(0, FEED_ERRORS_KEPT - logged));
        await repo.insertItemErrors(
          tx,
          keep.map((e) => ({ id: newId(), agencyId, runId, ...e })),
        );
        const failed = errors.length;
        const held = await repo.addBatchCounts(tx, runId, token, RUNS.LEASE_MS, {
          total: batch.total,
          valid: batch.total - failed,
          failed,
          ...counts,
          seen: counts.seen ?? 0,
          logged: keep.length,
          bytesRead: batch.bytesRead,
        });
        if (!held) throw new LeaseLostError();
        stored += batch.total - failed;
      });
    };
    const totals = await runFeedPipeline({
      connector,
      ctx,
      batchSize: RUNS.BATCH_SIZE,
      commit,
      onStats: (stats) => {
        sourceStats = stats;
      },
    });
    job.log.info({ runId, connector: connection.connector, ...totals, sourceStats }, 'feed run done');
    return await end('SUCCEEDED', null, { valid: stored, total: totals.total });
  } catch (raw) {
    const err = abort.signal.aborted && abort.signal.reason instanceof LeaseLostError ? abort.signal.reason : raw;
    if (err instanceof LeaseLostError) {
      job.log.warn({ runId }, 'feed run lease lost; another worker owns the run');
      return { kind: 'lost' };
    }
    if (err instanceof FeedNoOwnerError) return end('FAILED', 'FEED_NO_OWNER');
    if (err instanceof FeedAnomalyError) {
      job.log.warn({ runId, reason: err.reason, ...err.details }, 'feed run paused by the anomaly guard');
      return end('FAILED', PAUSE_CODES[err.reason], { pause: { reason: err.reason, details: err.details } });
    }
    const { code, retryable } = classifyRunError(err);
    // Resales' own error texts (credentials removed by the connector) say why the API refused.
    const apiMessages = err instanceof ResalesApiError ? err.descriptions : undefined;
    job.log.warn(
      { runId, code, retryable, apiMessages, sourceStats, err: code === 'INTERNAL' ? err : undefined },
      'feed run failed',
    );
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
