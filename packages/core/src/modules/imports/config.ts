import type { FeedCredentials } from '@inmolink/contracts';
import { importsEnv, loadConfig } from '@inmolink/platform/config';
import { aadFor, type Keyring } from '@inmolink/platform/crypto';

/**
 * Process settings for imports, set once at boot (api: encrypts credentials when a connection is saved; worker:
 * decrypts them to fetch a feed). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface ImportsConfig {
  /** `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` (platform/crypto, AES-256-GCM with key IDs). */
  keyring: Keyring;
  /**
   * `IMPORT_WITHDRAW_AFTER_MISSED_RUNS` (S6-02): successful runs in a row a listing may be missing from its feed before
   * it is withdrawn, unless the connection's `withdrawAfterMissedRuns` setting says otherwise. Read from the
   * environment when not given.
   */
  withdrawAfterMissedRuns?: number;
  /** S6-08 overrides of the `importsEnv` values (tests); read from the environment when not given. */
  maxConcurrentRuns?: number;
  anomalySpikeFactor?: number;
  anomalyDropRatio?: number;
  feedFreshnessDays?: number;
}

let current: ImportsConfig | undefined;

export function configureImports(config: ImportsConfig): void {
  current = config;
}

/** The default number of missed runs before a withdrawal (config; a connection setting overrides it). */
export function defaultWithdrawAfterMissedRuns(): number {
  return current?.withdrawAfterMissedRuns ?? loadConfig(importsEnv).IMPORT_WITHDRAW_AFTER_MISSED_RUNS;
}

/** Feed runs running at once across the `imports` pool (S6-08; `IMPORT_MAX_CONCURRENT_RUNS`). */
export function maxConcurrentRuns(): number {
  return current?.maxConcurrentRuns ?? loadConfig(importsEnv).IMPORT_MAX_CONCURRENT_RUNS;
}

/** The anomaly guard's thresholds (S6-08, PLAN §5.3 #7). */
export function anomalyThresholds(): { spikeFactor: number; dropRatio: number } {
  const env = () => loadConfig(importsEnv);
  return {
    spikeFactor: current?.anomalySpikeFactor ?? env().IMPORT_ANOMALY_SPIKE_FACTOR,
    dropRatio: current?.anomalyDropRatio ?? env().IMPORT_ANOMALY_DROP_RATIO,
  };
}

/** Days a feed may stay unchanged and still confirm its listings' freshness (S6-08; `IMPORT_FEED_FRESHNESS_DAYS`). */
export function feedFreshnessDays(): number {
  return current?.feedFreshnessDays ?? loadConfig(importsEnv).IMPORT_FEED_FRESHNESS_DAYS;
}

function keyring(): Keyring {
  if (!current) throw new Error('imports is not configured (call configureImports at boot)');
  return current.keyring;
}

/** Ciphertext is bound to the agency, table, column and row: copied elsewhere it does not decrypt. */
const aad = (agencyId: string, connectionId: string) =>
  aadFor({ agencyId, table: 'feed_connections', column: 'credentials_enc', rowId: connectionId });

export function encryptCredentials(agencyId: string, connectionId: string, credentials: FeedCredentials): string {
  return keyring().encrypt(JSON.stringify(credentials), aad(agencyId, connectionId));
}

export function decryptCredentials(agencyId: string, connectionId: string, envelope: string): FeedCredentials {
  return JSON.parse(keyring().decrypt(envelope, aad(agencyId, connectionId))) as FeedCredentials;
}

/** Run timings (S6-01). */
export const RUNS = {
  /** A running run's lease; the worker renews it every `HEARTBEAT_MS` and with every batch it commits. */
  LEASE_MS: 2 * 60_000,
  HEARTBEAT_MS: 30_000,
  /** A run whose lease lapsed this long ago is failed by the scheduler (`FEED_LEASE_EXPIRED`), freeing the slot. */
  LEASE_GRACE_MS: 10 * 60_000,
  /**
   * A queued run never started for this long is failed (`FEED_NEVER_STARTED`): the job was lost. Runs wait in the
   * `imports` pool behind other agencies' feeds (fair share), so hours in the queue are normal.
   */
  QUEUED_STALE_MS: 24 * 3_600_000,
  /** Items per committed batch (counters, errors, and the sink's write). */
  BATCH_SIZE: 500,
  /** Finished runs older than this are pruned with their errors (daily). */
  RETENTION_DAYS: 90,
  /** Due connections the scheduler starts per tick (the next tick takes the rest). */
  SCHEDULE_BATCH: 200,
  /** …and of one agency at most this many per tick (fair share between agencies). */
  SCHEDULE_PER_AGENCY: 10,
  /** Refs remembered per run for duplicate detection (beyond, a repeated ref updates the listing it made). */
  MAX_TRACKED_REFS: 250_000,
  /** Taxonomy resolutions (exact or fuzzy) a run remembers, so later batches skip the resolver for known values. */
  MAX_CACHED_RESOLUTIONS: 50_000,
} as const;

/**
 * The anomaly guard's fixed parts (S6-08). The thresholds themselves are configuration (`anomalyThresholds`).
 */
export const ANOMALY = {
  /** Successful runs whose item count makes the "typical volume" (their median). */
  BASELINE_RUNS: 5,
  /** Fewer successful runs than this: no baseline yet, the spike check is off. */
  MIN_BASELINE_RUNS: 3,
  /** A typical volume below this never trips the spike check (a 4-listing feed growing to 25 is normal life). */
  MIN_BASELINE_ITEMS: 20,
  /** A feed with fewer live listings than this never trips the drop check. */
  MIN_LIVE_FOR_DROP: 10,
} as const;

/**
 * Freshness via feed (S6-08, user-approved 2026-10-19): a listing's confirmation is written again only when the last
 * one is older than this, so an hourly feed does not rewrite every listing every hour.
 */
export const FEED_CONFIRM_REFRESH_DAYS = 7;

/** Fetch limits for feeds (PATTERNS §16), unless a connector asks for less. */
export const FEED_FETCH = {
  TIMEOUT_MS: 20 * 60_000,
  MAX_BYTES: 500 * 1024 * 1024,
  /** The mapper's sample fetch (a request, not a run): short deadline (S6-04). */
  SAMPLE_TIMEOUT_MS: 15_000,
} as const;
