/**
 * admin DTOs (PATTERNS §9) — the staff console's operations (S13-03, PLAN §7 M20): bulk operations run as audited,
 * cancellable jobs with progress; plan grants and price locks; feature flags; queue health; AI spend per tenant.
 * Every route is under `/v1/staff/…` and answers 403 to anyone who is not active staff.
 */
import { z } from 'zod';
import { PlanGrantDto } from './billing';
import { PageQuery, pageOf } from './common';
import { StaffReason, type StaffRole } from './staff';

// ---- bulk operations ----

/**
 * What a bulk operation does, for one agency or every agency:
 * - `REINDEX`: re-push the agency's search documents (the index sync job sends them).
 * - `REBUILD_READ_MODELS`: rebuild its listing and unit read models from the source tables (then re-index).
 * - `REIMPORT`: queue a run of each enabled, unpaused feed connection.
 * - `REPLAY_OUTBOX`: re-deliver the outbox events of a time window (consumers are idempotent).
 */
export const StaffOperationKind = z.enum(['REINDEX', 'REBUILD_READ_MODELS', 'REIMPORT', 'REPLAY_OUTBOX']);
export type StaffOperationKind = z.infer<typeof StaffOperationKind>;

export const StaffOperationState = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export type StaffOperationState = z.infer<typeof StaffOperationState>;

/** Who may start and cancel bulk operations; every staff role sees them. */
export const STAFF_OPERATION_ROLES = ['SUPER_ADMIN', 'STAFF_DATA_OPS'] as const satisfies readonly StaffRole[];

/** Longest outbox replay window (a wider one is several operations). */
export const OUTBOX_REPLAY_MAX_DAYS = 7;

const EVENT_TYPE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){1,4}$/;

/**
 * `REPLAY_OUTBOX`: events of one `type` created in [since, until), optionally only dead-lettered ones. The type is
 * required: a replay re-runs every subscriber, so staff name what they replay (the admin replay policy decides who may).
 */
export const OutboxReplayParams = z
  .object({
    since: z.iso.datetime(),
    until: z.iso.datetime(),
    type: z.string().max(100).regex(EVENT_TYPE, 'an event type such as properties.listing.updated'),
    deadOnly: z.boolean().default(false),
  })
  .strict()
  .refine((p) => new Date(p.until) > new Date(p.since), { message: 'until must be after since', path: ['until'] })
  .refine((p) => new Date(p.until).getTime() - new Date(p.since).getTime() <= OUTBOX_REPLAY_MAX_DAYS * 86_400_000, {
    message: `at most ${OUTBOX_REPLAY_MAX_DAYS} days`,
    path: ['until'],
  });
export type OutboxReplayParams = z.infer<typeof OutboxReplayParams>;

/**
 * `POST /v1/staff/operations`: start a bulk operation. `agencyId` scopes it to one agency (omitted: every agency).
 * The reason (support ticket, what broke) stays on the operation for staff; the audit row records kind and scope.
 */
export const StartStaffOperationBody = z
  .object({
    kind: StaffOperationKind,
    agencyId: z.uuid().optional(),
    reason: StaffReason,
    replay: OutboxReplayParams.optional(),
  })
  .strict()
  .refine((b) => (b.kind === 'REPLAY_OUTBOX') === (b.replay !== undefined), {
    message: 'replay is required for REPLAY_OUTBOX and only for it',
    path: ['replay'],
  });
export type StartStaffOperationBody = z.infer<typeof StartStaffOperationBody>;

export const StaffOperationParams = z.object({ id: z.uuid() }).strict();
export type StaffOperationParams = z.infer<typeof StaffOperationParams>;

export const StaffOperationListQuery = PageQuery.extend({ state: StaffOperationState.optional() });
export type StaffOperationListQuery = z.infer<typeof StaffOperationListQuery>;

export const StaffOperationDto = z.object({
  id: z.uuid(),
  kind: StaffOperationKind,
  /** The agency it is scoped to; null: every agency. */
  agencyId: z.uuid().nullable(),
  state: StaffOperationState,
  /** Steps done (agencies for agency-wide kinds, events for a replay) out of `total` (null until counted). */
  done: z.number().int().min(0),
  total: z.number().int().min(0).nullable(),
  cancelRequested: z.boolean(),
  replay: z
    .object({ since: z.iso.datetime(), until: z.iso.datetime(), type: z.string(), deadOnly: z.boolean() })
    .nullable(),
  /** Why staff ran it — shown to operators (data ops, super admins) only; null for other staff roles. */
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  requestedBy: z.uuid(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type StaffOperationDto = z.infer<typeof StaffOperationDto>;
export const StaffOperationPage = pageOf(StaffOperationDto);
export type StaffOperationPage = z.infer<typeof StaffOperationPage>;

// ---- plan grants and price locks ----

export const StaffPlanGrantDto = PlanGrantDto.extend({
  reason: z.string(),
  grantedBy: z.uuid().nullable(),
  revokedBy: z.uuid().nullable(),
  /** Why staff revoked it (kept on the grant for staff, never in the agency's audit log). */
  revokeReason: z.string().nullable(),
});
export type StaffPlanGrantDto = z.infer<typeof StaffPlanGrantDto>;

export const StaffPriceLockDto = z.object({
  id: z.uuid(),
  planCode: z.string(),
  interval: z.string(),
  currency: z.string(),
  amountCents: z.number().int(),
  endsAt: z.iso.datetime(),
  reason: z.string(),
});
export type StaffPriceLockDto = z.infer<typeof StaffPriceLockDto>;

/** Most grants and locks the staff view of one agency lists (newest first); an agency has a handful. */
export const STAFF_BILLING_LIST_LIMIT = 100;

/** `GET /v1/staff/agencies/:agencyId/billing`: the agency's plan grants (trials and staff grants) and price locks. */
export const StaffAgencyBillingDto = z.object({
  grants: z.array(StaffPlanGrantDto),
  priceLocks: z.array(StaffPriceLockDto),
});
export type StaffAgencyBillingDto = z.infer<typeof StaffAgencyBillingDto>;

export const PlanGrantParams = z.object({ id: z.uuid() }).strict();
export type PlanGrantParams = z.infer<typeof PlanGrantParams>;

/** `POST /v1/staff/plan-grants/:id/revoke`: why (kept in the audit row; the grant has no revoke reason column). */
export const RevokePlanGrantBody = z.object({ reason: StaffReason }).strict();
export type RevokePlanGrantBody = z.infer<typeof RevokePlanGrantBody>;

export const PriceLockIdDto = z.object({ id: z.uuid() });
export type PriceLockIdDto = z.infer<typeof PriceLockIdDto>;

// ---- feature flags ----

export const FeatureFlagKey = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/, 'a flag key such as listings.ai-studio');

export const FeatureFlagDto = z.object({
  key: FeatureFlagKey,
  description: z.string(),
  enabled: z.boolean(),
  enabledFor: z.array(z.uuid()),
  disabledFor: z.array(z.uuid()),
  updatedAt: z.iso.datetime(),
});
export type FeatureFlagDto = z.infer<typeof FeatureFlagDto>;

/** Most flags the console lists (the platform has a few dozen). */
export const FEATURE_FLAG_LIST_LIMIT = 500;
export const FeatureFlagList = z.object({ items: z.array(FeatureFlagDto) });
export type FeatureFlagList = z.infer<typeof FeatureFlagList>;

export const FeatureFlagParams = z.object({ key: FeatureFlagKey }).strict();
export type FeatureFlagParams = z.infer<typeof FeatureFlagParams>;

/**
 * `PUT /v1/staff/feature-flags/:key`: the default for every agency (`enabled`), or — with `agencyId` — that agency's
 * override (`override`: true / false, null clears it). Other processes see the change within 60 s.
 */
export const SetFeatureFlagBody = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ agencyId: z.uuid(), override: z.boolean().nullable() }).strict(),
]);
export type SetFeatureFlagBody = z.infer<typeof SetFeatureFlagBody>;

// ---- queue health ----

export const QueuePoolHealthDto = z.object({
  pool: z.string(),
  waiting: z.number().int().min(0),
  active: z.number().int().min(0),
  delayed: z.number().int().min(0),
  failed: z.number().int().min(0),
  /** Jobs in the pool's dead-letter queue (permanent failures waiting for a look). */
  dead: z.number().int().min(0),
});
export type QueuePoolHealthDto = z.infer<typeof QueuePoolHealthDto>;

/** `GET /v1/staff/queues/health`: job counts per worker pool; null counts when the queue could not be reached. */
export const QueueHealthDto = z.object({ reachable: z.boolean(), pools: z.array(QueuePoolHealthDto) });
export type QueueHealthDto = z.infer<typeof QueueHealthDto>;

// ---- AI spend per tenant ----

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const AiSpendQuery = z.object({ month: z.string().regex(MONTH, 'YYYY-MM').optional() }).strict();
export type AiSpendQuery = z.infer<typeof AiSpendQuery>;

/** Agencies the AI spend view lists (highest spend first). */
export const AI_SPEND_LIST_LIMIT = 100;

export const AiSpendRowDto = z.object({
  agencyId: z.uuid(),
  agencyName: z.string().nullable(),
  /** Micro-USD (1 USD = 1,000,000). */
  costMicroUsd: z.number().int().min(0),
  reservedMicroUsd: z.number().int().min(0),
  calls: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type AiSpendRowDto = z.infer<typeof AiSpendRowDto>;

/** `GET /v1/staff/ai-spend`: the month's spend per agency, highest first (at most `AI_SPEND_LIST_LIMIT`). */
export const AiSpendDto = z.object({
  month: z.string().regex(MONTH),
  totalMicroUsd: z.number().int().min(0),
  items: z.array(AiSpendRowDto),
});
export type AiSpendDto = z.infer<typeof AiSpendDto>;
