import type { FeedPauseDetails, FeedPauseReason } from '@inmolink/contracts';
import { metrics } from '@opentelemetry/api';
import { ANOMALY } from './config';

/**
 * The import anomaly guard (S6-08, PLAN §5.3 #7). Pure decisions; the runner applies them.
 *
 * - **Volume spike** — a run that reads more than `factor` × the feed's typical item count (the median of its last
 *   `ANOMALY.BASELINE_RUNS` successful runs, once there are `MIN_BASELINE_RUNS`) stops before the batch that crosses
 *   the line is written. A typical count under `MIN_BASELINE_ITEMS` never trips it.
 * - **Mass withdrawal** — at the end of a successful run, when more than `ratio` of the connection's live listings
 *   (present in the previous run) are missing from this one at once, the run withdraws nothing and counts no miss.
 *   Fewer than `MIN_LIVE_FOR_DROP` live listings never trip it.
 *
 * Either way the connection is paused (`feed_connections.paused_at`) until an agency admin or staff resume it; "accept
 * the change" lets the next run skip the guard once.
 */

export class FeedAnomalyError extends Error {
  override readonly name = 'FeedAnomalyError';
  constructor(
    readonly reason: FeedPauseReason,
    readonly details: FeedPauseDetails,
  ) {
    super(`feed anomaly: ${reason}`);
  }
}

/** The median item count of the last successful runs (newest first), or null while there are too few. */
export function typicalVolume(totals: readonly number[]): number | null {
  const recent = totals.slice(0, ANOMALY.BASELINE_RUNS);
  if (recent.length < ANOMALY.MIN_BASELINE_RUNS) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** The spike check for `items` read so far; null when within bounds. */
export function volumeSpike(items: number, typical: number | null, factor: number): FeedPauseDetails | null {
  if (typical === null || typical < ANOMALY.MIN_BASELINE_ITEMS) return null;
  return items > factor * typical ? { items, typical, factor } : null;
}

/** The drop check at the end of a run; null when within bounds. */
export function massWithdrawal(live: number, missing: number, ratio: number): FeedPauseDetails | null {
  if (live < ANOMALY.MIN_LIVE_FOR_DROP) return null;
  return missing / live > ratio ? { missing, live, ratio } : null;
}

const meter = metrics.getMeter('@inmolink/core');

/** `inmolink_import_paused_total{reason}`: alert `ImportFeedPaused` (infra/monitoring/rules/imports.yml). */
const paused = meter.createCounter('inmolink.import.paused', {
  description: 'Feed connections paused by the import anomaly guard, by reason',
});

let oldestQueuedSeconds = 0;
/** `inmolink_import_oldest_queued_seconds`: the scheduler's view of the queue (alert `ImportQueueWaitHigh`). */
meter
  .createObservableGauge('inmolink.import.oldest_queued_seconds', {
    description: 'Seconds the oldest queued feed run has waited (0 when none), as of the last scheduler tick',
  })
  .addCallback((result) => result.observe(oldestQueuedSeconds));

export function recordPause(reason: FeedPauseReason): void {
  paused.add(1, { reason });
}

export function recordOldestQueued(seconds: number): void {
  oldestQueuedSeconds = Math.max(0, Math.round(seconds));
}
