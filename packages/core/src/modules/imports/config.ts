import { type FeedCredentials, SHEET_MAPPED_CONNECTOR, XML_MAPPED_CONNECTOR } from '@inmolink/contracts';
import { DEFAULT_CONTENT_LOCALE } from '@inmolink/i18n';
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
  /** S6 review: `IMPORT_RUNS_PER_PROCESS`. */
  runsPerProcess?: number;
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

/** Feed runs one worker process runs at once (S6 review; `IMPORT_RUNS_PER_PROCESS`): bounds the process's RSS. */
export function runsPerProcess(): number {
  return current?.runsPerProcess ?? loadConfig(importsEnv).IMPORT_RUNS_PER_PROCESS;
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
  /** Due connections the scheduler starts per transaction (S7-F3: a tick runs batches until none is due). */
  SCHEDULE_BATCH: 200,
  /** …and of one agency at most this many per batch (fair share: every agency's first ones go first). */
  SCHEDULE_PER_AGENCY: 10,
  /** A tick's bound: at most this many batches (100 × 200 = 20k runs) and this long; the next tick takes the rest. */
  SCHEDULE_MAX_BATCHES: 100,
  SCHEDULE_BUDGET_MS: 40_000,
  /**
   * `imports.pruneRuns` (S7-F3): finished runs deleted per transaction, and how long one job keeps deleting (it stops
   * earlier once nothing expired is left; the next daily run continues what the budget left).
   */
  PRUNE_BATCH: 2_000,
  /**
   * …and at most about this many of their item errors (cascaded with them): a batch takes runs oldest first while
   * their `errors_logged` add up to this (always at least one run; one run keeps ≤ `FEED_ERRORS_KEPT`, 1,000).
   */
  PRUNE_ERRORS_PER_BATCH: 10_000,
  PRUNE_BUDGET_MS: 10 * 60_000,
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

/**
 * Uploaded CSV / Excel files (S7-F1): `imports/sheets/<agency>/<file id>` in the private bucket. They may hold owner
 * data, so they are not kept forever (S6 security review M1).
 */
export const SHEETS = {
  /** Storage prefix of every agency's uploaded sheets. */
  PREFIX: 'imports/sheets/',
  /** A file whose connections have not run (nor changed) for this long is deleted by the daily sweep. */
  RETENTION_DAYS: 30,
  /**
   * A file no connection points to is left alone this long: it sits between "uploaded" and "import started" (the
   * mapper), and a deleted agency's files go with the next sweep after it.
   */
  UNUSED_GRACE_MS: 24 * 3_600_000,
  /** Objects listed per page, and pages per sweep run (100k objects; the next day continues). */
  LIST_PAGE: 500,
  MAX_PAGES: 200,
  /** Release tombstones (`feed_sheet_releases`) kept this long, then pruned `PRUNE_BATCH` per statement. */
  RELEASE_RETENTION_DAYS: 7,
  PRUNE_BATCH: 5_000,
} as const;

/**
 * S6-F4: a stored source hash is trusted this long after the item was last fetched in full; older ones are ignored,
 * so every listing of a hashing connector (Resales Online) is fetched in full at least weekly, spread over the runs.
 */
export const SOURCE_HASH_TRUST_DAYS = 7;

/** Fetch limits for feeds (PATTERNS §16), unless a connector asks for less. */
export const FEED_FETCH = {
  TIMEOUT_MS: 20 * 60_000,
  MAX_BYTES: 500 * 1024 * 1024,
  /** The mapper's sample fetch (a request, not a run): short deadline (S6-04). */
  SAMPLE_TIMEOUT_MS: 15_000,
} as const;

/**
 * What a feed format assumes when an item does not say (S7-F2, S6 review): the language of untagged text and of the
 * generated title, the currency of a price without one, and the country of a feed without one. One table, keyed by
 * connector; the connection settings `defaultLocale` and `defaultCountry` override locale and country.
 */
export interface FormatDefaults {
  locale: string;
  currency: string;
  country: string;
}

const SPAIN = { currency: 'EUR', country: 'Spain' } as const;

export const FORMAT_DEFAULTS: Readonly<Record<string, FormatDefaults>> = {
  // International portal formats: untagged text is English.
  kyero: { locale: 'en', ...SPAIN },
  'resales-online': { locale: 'en', ...SPAIN },
  // Spanish CRM exports: untagged text is Spanish.
  'milenio-plus': { locale: 'es', ...SPAIN },
  infocasa: { locale: 'es', ...SPAIN },
  inmoba: { locale: 'es', ...SPAIN },
  thinkspain: { locale: 'es', ...SPAIN },
  // Mapped feeds and sheets: the platform's content locale.
  [XML_MAPPED_CONNECTOR]: { locale: DEFAULT_CONTENT_LOCALE, ...SPAIN },
  [SHEET_MAPPED_CONNECTOR]: { locale: DEFAULT_CONTENT_LOCALE, ...SPAIN },
};

/** Any other connector (tests' in-memory ones). */
const OTHER_FORMAT: FormatDefaults = { locale: DEFAULT_CONTENT_LOCALE, ...SPAIN };

/**
 * A connection's defaults: its format's row of `FORMAT_DEFAULTS`, with a valid `defaultLocale` (two lower-case
 * letters) and `defaultCountry` (1–200 characters) from its settings taking precedence.
 */
export function formatDefaults(connector: string, settings: Record<string, unknown> = {}): FormatDefaults {
  const base = FORMAT_DEFAULTS[connector] ?? OTHER_FORMAT;
  const locale = typeof settings.defaultLocale === 'string' ? settings.defaultLocale.trim() : '';
  const country = typeof settings.defaultCountry === 'string' ? settings.defaultCountry.trim() : '';
  return {
    locale: /^[a-z]{2}$/.test(locale) ? locale : base.locale,
    currency: base.currency,
    country: country.length > 0 && country.length <= 200 ? country : base.country,
  };
}
