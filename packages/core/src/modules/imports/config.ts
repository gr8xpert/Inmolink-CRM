import type { FeedCredentials } from '@inmolink/contracts';
import { aadFor, type Keyring } from '@inmolink/platform/crypto';

/**
 * Process settings for imports, set once at boot (api: encrypts credentials when a connection is saved; worker:
 * decrypts them to fetch a feed). Configuration only — never tenant or user state (CLAUDE.md rule 4).
 */
export interface ImportsConfig {
  /** `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` (platform/crypto, AES-256-GCM with key IDs). */
  keyring: Keyring;
}

let current: ImportsConfig | undefined;

export function configureImports(config: ImportsConfig): void {
  current = config;
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
  /** Refs remembered per run for duplicate detection (the S6-02 staging table checks beyond). */
  MAX_TRACKED_REFS: 250_000,
} as const;

/** Fetch limits for feeds (PATTERNS §16), unless a connector asks for less. */
export const FEED_FETCH = {
  TIMEOUT_MS: 20 * 60_000,
  MAX_BYTES: 500 * 1024 * 1024,
} as const;
