/**
 * Portal feed generation (S9-03, PLAN §7 M7): one pass over an agency writes the feed file of each of its live portal
 * connections (or the ones an event named) to object storage, records a run per connection and serves the new file.
 * Worker-only (imported through `./worker`): it runs as `app_system`.
 *
 * **One pass per agency** (`writePlannedFeeds`): each batch of listings is read once and written to every
 * connection's sink. **Serialized per agency**: the job (`exports.generatePortalFeeds`) is grouped by agency with
 * `concurrencyPerGroup` 1 in the `exports` pool — no two runs of one connection overlap (S9-02 review) — and a WRITTEN
 * run is recorded only if the served file is still the one the pass started from (compare-and-set), so even a run
 * that outlived its lease cannot replace a newer file.
 *
 * **Content hash, without buffering a file**: each connection's XML streams through a SHA-256 and gzip into a
 * multipart upload (`storage().upload`, parts of `MIN_UPLOAD_PART_BYTES`). At the end the hash is compared with the
 * served file's: equal → the upload is aborted (UNCHANGED: nothing rewritten, no new object; a file under one part —
 * nearly every feed — never left the process, as the first part is only sent when full), different → it completes
 * (WRITTEN) and the previous object is deleted. Hashing first and uploading in a second pass would read every
 * changed feed's listings twice; buffering would hold whole files. Memory per connection: one part buffer + the gzip
 * window + the writer's 64 K.
 *
 * A WRITTEN run purges the connection's edge copies (`p` tag); turning a connection off, revoking its token or
 * deleting it removes its stored files (`deletePortalFeedFiles`).
 */
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { MIN_UPLOAD_PART_BYTES, storage } from '@inmolink/platform/storage';
import { GzipObjectUpload } from '../../stored-feed';
import * as websiteApi from '../website-api';
import { FEED_RUNS_KEPT } from './config';
import { type FeedPlan, type PortalFeedSkip, planAgencyFeeds, writePlannedFeeds } from './feed';
import { PortalFeedError } from './feed-error';
import * as repo from './repo';
import { PORTAL_FEED_MAX_GZIP_BYTES, portalFeedObjectKey, portalFeedPrefix } from './serve';

export interface PortalFeedsConfig {
  /** Media CDN base (`MEDIA_CDN_URL`): image variant keys are served under it. */
  mediaBaseUrl: string;
}

let config: PortalFeedsConfig | undefined;

/** Boot (worker): settings of the generator. */
export function configurePortalFeeds(next: PortalFeedsConfig): void {
  if (!next.mediaBaseUrl) throw new Error('exports: mediaBaseUrl is required');
  config = next;
}

/** The media CDN base the push engine builds image URLs under (S9-04). */
export const portalFeedMediaBase = (): string => configured().mediaBaseUrl.replace(/\/+$/, '');

function configured(): PortalFeedsConfig {
  if (!config) throw new Error('exports: configurePortalFeeds() was not called');
  return config;
}

export type PortalFeedTrigger = repo.FeedRunTrigger;

export interface PortalFeedsRunResult {
  skipped?: FeedPlan['skipped'];
  /** S9-04: push-portal connections of the pass: the push job sends their listings, or takes the adverts down. */
  push: string[];
  written: string[];
  unchanged: string[];
  /** Failed, or lost the race to another run of the connection (`SUPERSEDED`). */
  failed: string[];
  skippedConnections: { connectionId: string; reason: PortalFeedSkip }[];
}

/**
 * Skips that end serving, and whether the file goes even though the connection is still live (`force`): gone, off or
 * revoked (the URL answers 404 anyway); the portal's writer turned off and the agency no longer verified (S9-03
 * review: a frozen file must not be served on — the token lookup also refuses an unverified agency at once).
 */
const ENDS_SERVING: ReadonlyMap<PortalFeedSkip, { force: boolean }> = new Map([
  ['no-connection', { force: false }],
  ['disabled', { force: false }],
  ['revoked', { force: false }],
  ['no-profile', { force: true }],
  ['writer-disabled', { force: true }],
  ['not-verified', { force: true }],
]);

const errorCode = (err: unknown) => (err instanceof PortalFeedError ? err.code : 'GENERATION_FAILED');

interface PendingRun {
  run: repo.FeedRunRecord;
  expectedRunId: string | null;
}

/**
 * One pass over an agency (worker): the named connections, or every live one (a full pass, which also counts as the
 * night's run: `nightly_at`). Records one run per connection — ids allocated when the pass starts, so a connection's
 * history sorts by start — and returns which were written, unchanged, failed or skipped. A connection failing (its
 * upload) fails alone; the job retries the pass when one failed for a reason other than a permanent one
 * (`PortalFeedError`). See the file comment.
 */
export async function generatePortalFeeds(
  agencyId: string,
  opts: { connectionIds?: readonly string[]; trigger: PortalFeedTrigger; signal?: AbortSignal; log?: Logger },
): Promise<PortalFeedsRunResult> {
  const startedAt = clock.now();
  const plan = await planAgencyFeeds(agencyId, opts.connectionIds ?? 'live');
  const fullPass = opts.connectionIds === undefined;
  const result: PortalFeedsRunResult = {
    push: plan.push,
    written: [],
    unchanged: [],
    failed: [],
    skippedConnections: plan.skippedConnections,
  };
  const runIds = new Map<string, string>();
  const runIdOf = (connectionId: string) => {
    const id = runIds.get(connectionId) ?? newId();
    runIds.set(connectionId, id);
    return id;
  };
  for (const s of plan.skippedConnections) runIdOf(s.connectionId);
  for (const p of plan.ready) runIdOf(p.connection.id);
  const runs: PendingRun[] = [];
  const base = (connectionId: string, status: repo.FeedRunStatus): repo.FeedRunRecord => ({
    id: runIdOf(connectionId),
    agencyId,
    connectionId,
    trigger: opts.trigger,
    status,
    startedAt,
    finishedAt: clock.now(),
    validCount: null,
    invalidCount: null,
    bytes: null,
    sha256: null,
    reason: null,
  });
  const skip = async (connectionId: string, reason: PortalFeedSkip) => {
    const ends = ENDS_SERVING.get(reason);
    if (ends) await deletePortalFeedFiles(agencyId, connectionId, { log: opts.log, force: ends.force });
    if (reason !== 'no-connection')
      runs.push({ run: { ...base(connectionId, 'SKIPPED'), reason }, expectedRunId: null });
  };

  for (const s of plan.skippedConnections) await skip(s.connectionId, s.reason);
  if (plan.skipped) {
    for (const p of plan.ready) await skip(p.connection.id, plan.skipped);
    result.skipped = plan.skipped;
    await record(runs, result, agencyId, { fullPass, log: opts.log });
    return result;
  }

  // Object storage: streamed, outside any transaction (CLAUDE.md rule 6; each batch's read is its own).
  const store = storage();
  const uploads = new Map<string, GzipObjectUpload>();
  for (const { connection } of plan.ready) {
    const key = portalFeedObjectKey(connection.id, runIdOf(connection.id));
    uploads.set(
      connection.id,
      new GzipObjectUpload(
        store.upload('feeds', key, { contentType: 'application/gzip', partBytes: MIN_UPLOAD_PART_BYTES }),
        { hash: 'text', maxBytes: PORTAL_FEED_MAX_GZIP_BYTES, tooLarge: () => new PortalFeedError('TOO_LARGE') },
      ),
    );
  }
  let outcomes: Awaited<ReturnType<typeof writePlannedFeeds>>;
  try {
    outcomes = await writePlannedFeeds(
      plan,
      new Map([...uploads].map(([id, u]) => [id, (chunk: string) => u.write(chunk)])),
      { mediaBaseUrl: configured().mediaBaseUrl, signal: opts.signal, log: opts.log, recordSummary: false },
    );
  } catch (err) {
    // The pass failed (database, abort): nothing new is served; each connection's failure is recorded.
    for (const u of uploads.values()) await u.abort();
    for (const p of plan.ready) {
      runs.push({ run: { ...base(p.connection.id, 'FAILED'), reason: errorCode(err) }, expectedRunId: null });
    }
    await record(runs, result, agencyId, { fullPass: false, log: opts.log }).catch((recordErr: unknown) => {
      opts.log?.warn(
        { agencyId, err: recordErr instanceof Error ? recordErr.name : 'error' },
        'portal feed: the failed runs could not be recorded',
      );
    });
    throw err;
  }

  const served = new Map(plan.ready.map((p) => [p.connection.id, p.connection.feed]));
  let retryable: unknown;
  const failed = (connectionId: string, err: unknown) => {
    if (!(err instanceof PortalFeedError)) retryable ??= err;
    runs.push({ run: { ...base(connectionId, 'FAILED'), reason: errorCode(err) }, expectedRunId: null });
  };
  for (const outcome of outcomes) {
    const upload = uploads.get(outcome.connectionId);
    if (!upload) continue;
    if ('error' in outcome) {
      await upload.abort();
      failed(outcome.connectionId, outcome.error);
      continue;
    }
    const current = served.get(outcome.connectionId) ?? null;
    let file: Awaited<ReturnType<GzipObjectUpload['finish']>>;
    try {
      file = await upload.finish(current?.sha256 ?? null);
    } catch (err) {
      await upload.abort();
      failed(outcome.connectionId, err);
      continue;
    }
    runs.push({
      run: {
        ...base(outcome.connectionId, file.unchanged ? 'UNCHANGED' : 'WRITTEN'),
        validCount: outcome.valid,
        invalidCount: outcome.invalid,
        bytes: file.bytes,
        sha256: file.sha256,
      },
      expectedRunId: current?.runId ?? null,
    });
  }
  // A full pass counts as the night's run only if no connection has to be retried.
  await record(runs, result, agencyId, { fullPass: fullPass && retryable === undefined, log: opts.log });
  if (retryable !== undefined) throw retryable;
  return result;
}

/**
 * Records the pass's runs in one transaction (three statements: `repo.recordFeedRuns`), then — outside it — deletes
 * the objects no longer served and purges the written connections' edge copies.
 */
async function record(
  runs: readonly PendingRun[],
  result: PortalFeedsRunResult,
  agencyId: string,
  opts: { fullPass: boolean; log?: Logger },
): Promise<void> {
  if (runs.length === 0) return;
  const recorded = await withSystem('exports.generatePortalFeeds record', (tx) =>
    repo.recordFeedRuns(tx, agencyId, runs, { keep: FEED_RUNS_KEPT, fullPass: opts.fullPass }),
  );
  const purge: { kind: 'p'; id: string }[] = [];
  for (const { run, stale } of recorded) {
    if (run.status === 'WRITTEN') {
      result.written.push(run.connectionId);
      purge.push({ kind: 'p', id: run.connectionId });
    } else if (run.status === 'UNCHANGED') result.unchanged.push(run.connectionId);
    else if (run.status === 'FAILED') result.failed.push(run.connectionId);
    if (stale) await deleteObject(run.connectionId, stale, opts.log);
  }
  if (purge.length > 0) await websiteApi.queueEdgePurge(agencyId, purge, clock.now());
}

async function deleteObject(connectionId: string, runId: string, log?: Logger): Promise<void> {
  try {
    await storage().delete('feeds', portalFeedObjectKey(connectionId, runId));
  } catch (err) {
    // An orphan object is harmless (never served); the connection's cleanup removes its whole prefix.
    log?.warn({ connectionId, runId, err: err instanceof Error ? err.name : 'error' }, 'old portal feed not deleted');
  }
}

/**
 * Removes every stored file of a connection that no longer serves and forgets its served file — unless it is live
 * again by now (without `force`); purges the URL's edge copies. Pages through the prefix. Idempotent.
 */
export async function deletePortalFeedFiles(
  agencyId: string,
  connectionId: string,
  opts: { log?: Logger; force?: boolean } = {},
): Promise<number> {
  const gone = await withSystem('exports.deletePortalFeedFiles', (tx) =>
    repo.forgetFeedFile(tx, agencyId, connectionId, opts.force ?? false),
  );
  if (!gone) return 0;
  let deleted = 0;
  let after: string | undefined;
  for (;;) {
    const page = await storage().list('feeds', portalFeedPrefix(connectionId), { limit: 1_000, after });
    for (const o of page.objects) {
      await storage().delete('feeds', o.key);
      deleted++;
    }
    if (!page.next) break;
    after = page.next;
  }
  if (deleted > 0) {
    await websiteApi.queueEdgePurge(agencyId, [{ kind: 'p', id: connectionId }], clock.now());
    opts.log?.info({ connectionId, deleted }, 'portal feed files deleted');
  }
  return deleted;
}
