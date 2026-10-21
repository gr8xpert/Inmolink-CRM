/**
 * Staff import health (S6-08, PLAN §7 M20): runs, failures, queue lag and paused connections across every agency,
 * plus the taxonomy values feeds sent that wait for a staff mapping. Runs as `app_staff` (`withStaffCtx`): the
 * registry lets staff read every agency's connections and runs and resume a paused connection.
 *
 * Cost: a fixed handful of statements whatever the platform's size — the window's runs are aggregated off
 * `feed_runs_finished_at_idx`, the queue off `feed_runs_active_idx`, the paused list off `feed_connections_paused_idx`.
 */
import {
  AppError,
  FEED_RUN_ERROR_CODES,
  IMPORT_HEALTH_LIST_LIMIT,
  IMPORT_HEALTH_WINDOW_HOURS,
  type ImportHealthDto,
  StaffResumeFeedConnectionBody,
  type StaffResumeFeedConnectionDto,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import type { StaffCtx } from '../../context';
import * as compliance from '../compliance';
import * as taxonomy from '../taxonomy';
import { assertStaffCan } from './policy';
import * as repo from './repo';
import { toPauseDto } from './service';

const PAUSE_CODES = new Set<string>([
  'FEED_PAUSED_VOLUME_SPIKE',
  'FEED_PAUSED_MASS_WITHDRAWAL',
  'FEED_PAUSED_EMPTY_FEED',
]);
const KNOWN_CODES = new Set<string>(FEED_RUN_ERROR_CODES);

export async function getImportHealth(ctx: StaffCtx): Promise<ImportHealthDto> {
  assertStaffCan(ctx, 'staff.imports.read');
  const since = new Date(clock.now().getTime() - IMPORT_HEALTH_WINDOW_HOURS * 3_600_000);
  const outcomes = await repo.finishedByOutcome(ctx.tx, since);
  const waits = await repo.finishedWaits(ctx.tx, since);
  const queue = await repo.queueSnapshot(ctx.tx);
  const paused = await repo.pausedConnections(ctx.tx, IMPORT_HEALTH_LIST_LIMIT);
  const failures = await repo.recentFailures(ctx.tx, since, IMPORT_HEALTH_LIST_LIMIT);
  const unmatched = await taxonomy.countStaffUnmatched(ctx);

  const byCode = new Map<string, number>();
  let succeeded = 0;
  let failed = 0;
  let pausedRuns = 0;
  for (const o of outcomes) {
    if (o.state === 'SUCCEEDED') succeeded += o.count;
    if (o.state !== 'FAILED') continue;
    failed += o.count;
    const code = o.errorCode && KNOWN_CODES.has(o.errorCode) ? o.errorCode : 'INTERNAL';
    if (PAUSE_CODES.has(code)) pausedRuns += o.count;
    byCode.set(code, (byCode.get(code) ?? 0) + o.count);
  }
  return {
    windowHours: IMPORT_HEALTH_WINDOW_HOURS,
    runs: { finished: succeeded + failed, succeeded, failed, paused: pausedRuns },
    failures: [...byCode]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    lag: {
      queued: queue.queued,
      running: queue.running,
      oldestQueuedSeconds: queue.oldestQueuedSeconds,
      p95WaitSeconds: waits.p95,
      maxWaitSeconds: waits.max,
    },
    paused: paused.flatMap((c) => {
      const pause = toPauseDto(c);
      return pause ? [{ connectionId: c.id, agencyId: c.agencyId, name: c.name, connector: c.connector, pause }] : [];
    }),
    recentFailures: failures.map((f) => ({
      ...f,
      errorCode: KNOWN_CODES.has(f.errorCode) ? f.errorCode : 'INTERNAL',
      finishedAt: f.finishedAt.toISOString(),
    })),
    unmatched,
  };
}

/**
 * `POST /v1/staff/imports/connections/:id/resume` (S6-08): staff lift a pause for an agency (data ops, super
 * admins), with the same "accept the change" choice the agency has. Audited on the agency's log.
 *
 * S7-F1: staff say why (`StaffReason`, validated again here — a direct caller gets no shortcut), as for the S6-F1
 * give-to-get exemption: the reason is stored on the connection (`staff_resume_reason`, staff-only column, cleared by
 * the next pause or an agency resume), the audit row records that one was given (`reasonProvided`), never the text
 * (S1-08). A connection that is not paused changes nothing and writes no audit row.
 */
export async function staffResumeFeedConnection(
  ctx: StaffCtx,
  id: string,
  input: StaffResumeFeedConnectionBody,
): Promise<StaffResumeFeedConnectionDto> {
  assertStaffCan(ctx, 'staff.imports.resume');
  const body = StaffResumeFeedConnectionBody.safeParse(input);
  if (!body.success) throw new AppError('VALIDATION_FAILED', { field: 'reason' });
  const { acceptChange, reason } = body.data;
  const current = await repo.lockConnectionForStaff(ctx.tx, id);
  if (!current) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  const row = current.pausedAt ? await repo.resumeConnectionForStaff(ctx.tx, id, acceptChange, reason) : current;
  if (!row) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  if (current.pausedAt) {
    await compliance.auditStaff(
      ctx,
      current.agencyId,
      'staff.imports.resumed',
      { type: 'feedConnection', id },
      { reason: current.pauseReason, acceptChange, reasonProvided: true },
    );
  }
  return {
    id: row.id,
    pause: toPauseDto(row),
    acceptAnomalyOnce: row.acceptAnomalyOnce,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
  };
}
