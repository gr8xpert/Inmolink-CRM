/**
 * admin use cases (PATTERNS §7) — the staff console's operations (S13-03, PLAN §7 M20): `(ctx: StaffCtx, input) →
 * DTO`. Authorize with `assertStaffCan`, read and write through `./repo`, emit outbox events in the same transaction,
 * never call the network inside one (queue health reads Redis without a transaction of its own).
 *
 * Composition: billing cannot import compliance (compliance → … → billing would cycle), so the audited staff billing
 * actions are composed here — the billing use case and its `compliance.auditStaff` row in the same transaction.
 */
import {
  AI_SPEND_LIST_LIMIT,
  type AiSpendDto,
  type AiSpendQuery,
  FEATURE_FLAG_LIST_LIMIT,
  type FeatureFlagList,
  type GrantPlanBody,
  type PlanGrantDto,
  type PriceLockBody,
  type PriceLockIdDto,
  type QueueHealthDto,
  type RevokePlanGrantBody,
  type SetFeatureFlagBody,
  type StaffAgencyBillingDto,
  type StaffOperationDto,
  type StaffOperationListQuery,
  type StaffOperationPage,
  type StartStaffOperationBody,
} from '@inmolink/contracts';
import { aiSpendByAgency, usageMonth } from '@inmolink/platform/ai';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { flagExists, listFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { emit, PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { queueHealth } from '@inmolink/platform/queue';
import type { StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as billing from '../billing';
import * as compliance from '../compliance';
import { adminEvents } from './events';
import { OPERATION_STALE_MS } from './jobs';
import { assertStaffCan, canStaff } from './policy';
import { replayClass } from './replay-policy';
import * as repo from './repo';

// ---- bulk operations ----

/** The operation's reason is free text from an operator: shown to operators (data ops, super admins) only. */
function toOperationDto(ctx: StaffCtx, r: repo.OperationRow): StaffOperationDto {
  const replay = r.params.replay;
  return {
    id: r.id,
    kind: r.kind,
    agencyId: r.targetAgencyId,
    state: r.state,
    done: r.done,
    total: r.total,
    cancelRequested: r.cancelRequestedAt !== null,
    replay: replay ? { since: replay.since, until: replay.until, type: replay.type, deadOnly: replay.deadOnly } : null,
    reason: canStaff(ctx, 'staff.admin.runOperation') ? r.reason : null,
    errorCode: r.errorCode,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The outbox replay policy (S13-03 security review, `./replay-policy.ts`): refused types never replay; projection-only
 * types replay for data ops and super admins; any other type for super admins only.
 */
function assertReplayable(ctx: StaffCtx, type: string): void {
  const kind = replayClass(type);
  if (kind === 'REFUSED') throw new AppError('OUTBOX_REPLAY_TYPE_REFUSED', { type });
  if (kind === 'SUPER_ADMIN' && ctx.actor.role !== 'SUPER_ADMIN') {
    throw new AppError('OUTBOX_REPLAY_TYPE_REFUSED', { type, requires: 'SUPER_ADMIN' });
  }
}

/**
 * `POST /v1/staff/operations`: records a QUEUED bulk operation (one at a time per kind and scope —
 * `STAFF_OPERATION_ACTIVE` otherwise), audits it (`staff.operation.started`: kind and scope; the reason stays on the
 * row) and asks for its job (`admin.operation.requested`) in the same transaction.
 */
export async function startOperation(ctx: StaffCtx, input: StartStaffOperationBody): Promise<StaffOperationDto> {
  assertStaffCan(ctx, 'staff.admin.runOperation');
  if (input.agencyId && (await agencies.agencyNames(ctx, [input.agencyId])).size === 0) {
    throw new AppError('NOT_FOUND', { agencyId: input.agencyId });
  }
  if (input.replay) assertReplayable(ctx, input.replay.type);
  const replay = input.replay
    ? {
        since: new Date(input.replay.since).toISOString(),
        until: new Date(input.replay.until).toISOString(),
        type: input.replay.type,
        deadOnly: input.replay.deadOnly,
      }
    : undefined;
  const row = await repo.insertOperation(ctx.tx, {
    id: newId(),
    kind: input.kind,
    targetAgencyId: input.agencyId ?? null,
    params: replay ? { replay } : {},
    reason: input.reason,
    requestedBy: ctx.actor.userId,
    createdAt: clock.now(),
  });
  if (!row) throw new AppError('STAFF_OPERATION_ACTIVE', { kind: input.kind });
  await compliance.auditStaff(
    ctx,
    row.targetAgencyId,
    'staff.operation.started',
    { type: 'staffOperation', id: row.id },
    {
      kind: row.kind,
      scope: row.targetAgencyId ? 'AGENCY' : 'ALL',
      ...(replay
        ? { since: replay.since, until: replay.until, eventType: replay.type, deadOnly: replay.deadOnly }
        : {}),
    },
  );
  await emit(ctx.tx, adminEvents.operationRequested({ operationId: row.id }), { agencyId: PLATFORM_AGENCY_ID });
  return toOperationDto(ctx, row);
}

/** `GET /v1/staff/operations`: newest first, keyset. Every staff role. */
export async function listOperations(ctx: StaffCtx, q: StaffOperationListQuery): Promise<StaffOperationPage> {
  assertStaffCan(ctx, 'staff.admin.read');
  const rows = await repo.listOperations(ctx.tx, { limit: q.limit, cursor: decodeCursor(q.cursor), state: q.state });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.createdAt, id: r.id }),
    (r) => toOperationDto(ctx, r),
  );
}

/** `GET /v1/staff/operations/:id`: its state and progress. */
export async function getOperation(ctx: StaffCtx, id: string): Promise<StaffOperationDto> {
  assertStaffCan(ctx, 'staff.admin.read');
  const row = await repo.getOperation(ctx.tx, id);
  if (!row) throw new AppError('STAFF_OPERATION_NOT_FOUND');
  return toOperationDto(ctx, row);
}

/**
 * `POST /v1/staff/operations/:id/cancel`: a queued operation (or a running one whose job stopped moving) ends
 * CANCELLED now; a running one stops before its job's next step (the work done stays done — every step is
 * idempotent). Audited (`staff.operation.cancelled`). Cancelling a finished operation changes nothing.
 */
export async function cancelOperation(ctx: StaffCtx, id: string): Promise<StaffOperationDto> {
  assertStaffCan(ctx, 'staff.admin.runOperation');
  const row = await repo.getOperation(ctx.tx, id, { lock: true });
  if (!row) throw new AppError('STAFF_OPERATION_NOT_FOUND');
  if (row.state !== 'QUEUED' && row.state !== 'RUNNING') return toOperationDto(ctx, row);
  const now = clock.now();
  const after = await repo.requestCancel(
    ctx.tx,
    id,
    ctx.actor.userId,
    now,
    new Date(now.getTime() - OPERATION_STALE_MS),
  );
  await compliance.auditStaff(
    ctx,
    row.targetAgencyId,
    'staff.operation.cancelled',
    { type: 'staffOperation', id },
    { kind: row.kind, state: after.state, done: after.done },
  );
  return toOperationDto(ctx, after);
}

// ---- plan grants and price locks (composed: billing + its audit row) ----

/** `GET /v1/staff/agencies/:agencyId/billing`: the agency's grants and price locks. Every staff role. */
export function listAgencyBilling(ctx: StaffCtx, agencyId: string): Promise<StaffAgencyBillingDto> {
  return billing.listAgencyBillingForStaff(ctx, agencyId);
}

/** `POST /v1/staff/plan-grants`: `billing.grantPlan` and its audit row (`staff.billing.planGranted`), one transaction. */
export async function grantPlan(ctx: StaffCtx, input: GrantPlanBody): Promise<PlanGrantDto> {
  const grant = await billing.grantPlan(ctx, input);
  await compliance.auditStaff(
    ctx,
    grant.agencyId,
    'staff.billing.planGranted',
    { type: 'planGrant', id: grant.id },
    { planCode: grant.planCode, endsAt: grant.endsAt },
  );
  return grant;
}

/**
 * `POST /v1/staff/plan-grants/:id/revoke`: `billing.revokePlanGrant` and its audit row (`staff.billing.grantRevoked`),
 * one transaction. The reason is stored on the grant (`revoke_reason`), not in the audit row.
 */
export async function revokePlanGrant(
  ctx: StaffCtx,
  grantId: string,
  input: RevokePlanGrantBody,
): Promise<PlanGrantDto> {
  const grant = await billing.revokePlanGrant(ctx, grantId, input.reason);
  // The reason is free text: it stays on the grant (staff read it), never in the agency's audit log.
  await compliance.auditStaff(
    ctx,
    grant.agencyId,
    'staff.billing.grantRevoked',
    { type: 'planGrant', id: grant.id },
    { planCode: grant.planCode },
  );
  return grant;
}

/** `PUT /v1/staff/price-locks`: `billing.setPriceLock` and its audit row (`staff.billing.priceLockSet`), one transaction. */
export async function setPriceLock(ctx: StaffCtx, input: PriceLockBody): Promise<PriceLockIdDto> {
  const lock = await billing.setPriceLock(ctx, input);
  await compliance.auditStaff(
    ctx,
    input.agencyId,
    'staff.billing.priceLockSet',
    { type: 'priceLock', id: lock.id },
    {
      planCode: input.planCode,
      interval: input.interval,
      currency: input.currency,
      amountCents: input.amountCents,
      endsAt: new Date(input.endsAt).toISOString(),
    },
  );
  return lock;
}

// ---- feature flags ----

/** `GET /v1/staff/feature-flags`: every flag (key order) with its per-agency overrides. Every staff role. */
export async function listFeatureFlags(ctx: StaffCtx): Promise<FeatureFlagList> {
  assertStaffCan(ctx, 'staff.admin.read');
  const rows = await listFlags(ctx.tx, FEATURE_FLAG_LIST_LIMIT);
  return { items: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
}

/**
 * `PUT /v1/staff/feature-flags/:key` (super admins): a known flag's default, or one agency's override (null clears
 * it). Audited (`staff.featureFlag.changed`). Every process sees the change within the flag cache's 60 s.
 */
export async function setFeatureFlag(ctx: StaffCtx, key: string, input: SetFeatureFlagBody): Promise<FeatureFlagList> {
  assertStaffCan(ctx, 'staff.admin.setFlag');
  if (!(await flagExists(ctx.tx, key))) throw new AppError('NOT_FOUND', { flag: key });
  if ('enabled' in input) {
    await setFlag(ctx.tx, key, { enabled: input.enabled });
    await compliance.auditStaff(ctx, null, 'staff.featureFlag.changed', null, { key, enabled: input.enabled });
  } else {
    if ((await agencies.agencyNames(ctx, [input.agencyId])).size === 0) {
      throw new AppError('NOT_FOUND', { agencyId: input.agencyId });
    }
    await setFlagOverride(ctx.tx, key, input.agencyId, input.override);
    await compliance.auditStaff(ctx, input.agencyId, 'staff.featureFlag.changed', null, {
      key,
      override: input.override,
    });
  }
  return listFeatureFlags(ctx);
}

// ---- queue health and AI spend ----

/** Opens a fresh staff transaction per call (an app passes `(fn) => app.withStaffCtx(req, reason, fn)`). */
export type StaffCtxRunner = <T>(fn: (ctx: StaffCtx) => Promise<T>) => Promise<T>;

/**
 * `GET /v1/staff/queues/health`: job counts per worker pool and its dead-letter queue. Authorized in a staff
 * transaction, then Redis is read with none open (CLAUDE.md rule 6). An unreachable queue answers `reachable: false`
 * rather than failing the console.
 */
export async function getQueueHealth(
  run: StaffCtxRunner,
  log?: { warn(obj: object, msg: string): void },
): Promise<QueueHealthDto> {
  await run(async (ctx) => assertStaffCan(ctx, 'staff.admin.read'));
  try {
    return { reachable: true, pools: await queueHealth() };
  } catch (err) {
    log?.warn({ err }, 'queue health: redis-queue unreachable');
    return { reachable: false, pools: [] };
  }
}

/**
 * `GET /v1/staff/ai-spend?month=YYYY-MM` (default: this month, UTC): AI spend per agency, highest first, with names
 * (one query each). Every staff role.
 */
export async function getAiSpend(ctx: StaffCtx, q: AiSpendQuery): Promise<AiSpendDto> {
  assertStaffCan(ctx, 'staff.admin.read');
  const first = q.month ? `${q.month}-01` : usageMonth(clock.now());
  const spend = await aiSpendByAgency(ctx.tx, first, AI_SPEND_LIST_LIMIT);
  const names = await agencies.agencyNames(
    ctx,
    spend.rows.map((r) => r.agencyId),
  );
  return {
    month: first.slice(0, 7),
    totalMicroUsd: spend.totalMicroUsd,
    items: spend.rows.map((r) => ({ ...r, agencyName: names.get(r.agencyId) ?? null })),
  };
}
