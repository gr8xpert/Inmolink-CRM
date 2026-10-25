/**
 * Tunables of staff bulk operations (S13-03). Defaults suit production; tests narrow them with `configureAdmin`.
 */
export interface AdminConfig {
  /** Most events one outbox replay may re-queue; a bigger window ends the operation FAILED (`REPLAY_TOO_LARGE`). */
  replayMaxEvents: number;
  /** Events re-queued per replay step. */
  replayBatch: number;
  /** Pause between replay steps, so the dispatcher drains each batch before the next lands. */
  replayPaceMs: number;
  /** Targets (read models, index pushes) queued per step of a reindex or rebuild. */
  targetPage: number;
  /** A step waits while the pool it feeds (indexing, imports) has more jobs than this waiting. */
  poolBacklogLimit: number;
  /** How long a step waits for a busy pool before trying again (a delayed continuation job). */
  backoffMs: number;
  /** A job's time box; the rest of the operation continues in a new job. */
  sliceMs: number;
}

const DEFAULTS: AdminConfig = {
  replayMaxEvents: 100_000,
  replayBatch: 1_000,
  replayPaceMs: 1_000,
  targetPage: 1_000,
  poolBacklogLimit: 5_000,
  backoffMs: 30_000,
  sliceMs: 5 * 60_000,
};

let current: AdminConfig = DEFAULTS;

/** Tests (and an ops override) only; `configureAdmin()` restores the defaults. */
export function configureAdmin(overrides: Partial<AdminConfig> = {}): void {
  current = { ...DEFAULTS, ...overrides };
}

export function adminConfig(): AdminConfig {
  return current;
}
