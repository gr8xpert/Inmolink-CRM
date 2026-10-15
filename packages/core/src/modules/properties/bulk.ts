/**
 * Bulk actions on listings (S3-07, PATTERNS §7 + §12). A request records the action and its listings
 * (`listing_bulk_actions`, by id or "every listing matching this filter", ≤ `LISTING_BULK_MAX`) and emits
 * `properties.bulkAction.requested` in the same transaction; the outbox turns that into a
 * `properties.runBulkAction` job (`jobs.ts`), which applies the action in chunks of `BULK_CHUNK` listings, each
 * in its own transaction **as the member who asked** (`withMemberCtx`: role and verification re-read per chunk,
 * RLS on). Each chunk applies the same rules as an edit (`updateListing`): agents change only their own
 * listings, the status lifecycle, the visibility gate (verified agency, CEE rating for PUBLIC), price and status
 * history, and one `properties.listing.updated` event per changed listing (plus `statusChanged` /
 * `visibilityChanged` like an edit). A listing that cannot change fails alone (its id and error code are kept);
 * the rest go on. The record's counters move in the chunk's transaction, so a retried job resumes after the
 * last committed chunk and never applies one twice.
 */
import {
  LISTING_BULK_FAILURES_KEPT,
  LISTING_BULK_MAX,
  ListingBulkAction,
  type ListingBulkDto,
  type StartListingBulkBody,
} from '@inmolink/contracts';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import * as agencies from '../agencies';
import * as identity from '../identity';
import { propertiesEvents } from './events';
import { assertCan, can, type PropertiesAction } from './policy';
import * as repo from './repo';
import { actorId, assertVisibilityAllowed, listFilterOf, statusChangeAllowed } from './service';

/** Listings per chunk (one transaction): a few statements each, well inside the dashboard statement timeout. */
export const BULK_CHUNK = 250;

/** The policy action a bulk action needs, on every listing it changes. */
const ACTION_POLICY: Record<ListingBulkAction['type'], PropertiesAction> = {
  STATUS: 'listing.update',
  VISIBILITY: 'listing.publish',
  SHARE_SCOPE: 'listing.publish',
  PRICE_CHANGE: 'listing.update',
  ASSIGN: 'listing.assign',
  ADD_TAG: 'listing.update',
};

/** The DTO field an edit reports for each action (`properties.listing.updated` → `changed`). */
const CHANGED_FIELD: Record<ListingBulkAction['type'], string> = {
  STATUS: 'status',
  VISIBILITY: 'visibility',
  SHARE_SCOPE: 'shareScope',
  PRICE_CHANGE: 'price',
  ASSIGN: 'owner',
  ADD_TAG: 'tags',
};

/** Splits an action into its stored type and parameters. */
function storedOf(action: ListingBulkAction): { type: ListingBulkAction['type']; params: Record<string, unknown> } {
  const { type, ...params } = action;
  return { type, params };
}

function actionOf(row: Pick<repo.BulkRow, 'type' | 'params'>): ListingBulkAction {
  return ListingBulkAction.parse({ ...(row.params as object), type: row.type });
}

function toDto(row: repo.BulkRow): ListingBulkDto {
  return {
    id: row.id,
    action: actionOf(row),
    state: row.state,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    unchanged: row.unchanged,
    failed: row.failed,
    failures: row.failures as ListingBulkDto['failures'],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** The new price after a change of `percentBp`, in whole units of the currency (cents rounded to 100). */
export function changedPrice(priceCents: number, percentBp: number): number {
  return Math.max(0, Math.round((priceCents * (10_000 + percentBp)) / 1_000_000) * 100);
}

/**
 * The checks of the whole action, before anything is recorded: the role may do it at all, staff acting as a
 * member never run bulk actions (S3-07 decision: the deal, status and publication stay the agency's call and a
 * bulk change touches all of them at once), SHARED/PUBLIC need a verified agency, and a new owner must be an
 * active member.
 */
async function assertActionAllowed(ctx: Ctx, action: ListingBulkAction): Promise<void> {
  assertCan(ctx, ACTION_POLICY[action.type]);
  if (impersonatorOf(ctx)) throw new AppError('FORBIDDEN', { reason: 'impersonation' });
  if (action.type === 'VISIBILITY' && action.visibility !== 'PRIVATE') {
    // the agency gate here; the CEE rating PUBLIC needs is checked per listing
    agencies.assertVerified(ctx, action.visibility === 'SHARED' ? 'listing.share' : 'listing.publish');
  }
  if (action.type === 'ASSIGN') await assertMember(ctx, action.ownerUserId);
}

async function assertMember(ctx: Ctx, userId: string): Promise<void> {
  const { role } = await identity.getMemberAccess(ctx.tx, { agencyId: ctx.tenant.agencyId, userId });
  if (!role) throw new AppError('VALIDATION_FAILED', { field: 'ownerUserId', reason: 'not_a_member' });
}

/** A second action while one is waiting or running is LISTING_BULK_BUSY (`listing_bulk_actions_member_active_uq`). */
async function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === '23505' && cause.constraint === 'listing_bulk_actions_member_active_uq') {
      throw new AppError('LISTING_BULK_BUSY');
    }
    throw err;
  }
}

/**
 * `POST /v1/listing-bulk-actions`: records the action for the listings named (or every live listing matching
 * the filter, newest first) and queues it. Ids that are not the agency's own live listings are kept and fail
 * as LISTING_NOT_FOUND when the job reaches them.
 */
export async function startBulkAction(ctx: Ctx, body: StartListingBulkBody): Promise<ListingBulkDto> {
  await assertActionAllowed(ctx, body.action);
  const userId = actorId(ctx);
  const agencyId = ctx.tenant.agencyId;
  let ids: string[];
  if ('ids' in body.target) {
    ids = body.target.ids;
  } else {
    const filter = listFilterOf(ctx, body.target.filter);
    // A member who changes only their own listings (agents) targets only those: the rest would all fail.
    if (!can(ctx, 'listing.assign')) filter.ownerUserId = userId;
    ids = await repo.idsMatching(ctx.tx, agencyId, filter, LISTING_BULK_MAX + 1);
    if (ids.length > LISTING_BULK_MAX) throw new AppError('LISTING_BULK_TOO_MANY', { max: LISTING_BULK_MAX });
    if (ids.length === 0) throw new AppError('VALIDATION_FAILED', { field: 'target', reason: 'empty' });
  }
  const row = await oneAtATime(() =>
    repo.insertBulk(ctx.tx, {
      id: newId(),
      agencyId,
      createdByUserId: userId,
      ...storedOf(body.action),
      listingIds: ids,
      total: ids.length,
    }),
  );
  await emit(ctx.tx, propertiesEvents.bulkRequested({ bulkActionId: row.id, agencyId, userId }));
  return toDto(row);
}

/** `GET /v1/listing-bulk-actions/:id`: progress, for the member who asked and the agency's admins. */
export async function getBulkAction(ctx: Ctx, id: string): Promise<ListingBulkDto> {
  assertCan(ctx, 'listing.read');
  const row = await repo.getBulk(ctx.tx, ctx.tenant.agencyId, id);
  const mine = row?.createdByUserId === actorId(ctx);
  // Another member's action is visible to whoever may administer every listing (`listing.assign`: admins).
  if (!row || (!mine && !can(ctx, 'listing.assign'))) throw new AppError('LISTING_BULK_NOT_FOUND');
  return toDto(row);
}

type Outcome = { kind: 'change'; priceCents?: number } | { kind: 'unchanged' } | { kind: 'fail'; code: string };

/** What the action does to one listing (the role and ownership are checked before). */
function outcomeFor(ctx: Ctx, action: ListingBulkAction, row: repo.BulkTargetRow): Outcome {
  try {
    switch (action.type) {
      case 'STATUS':
        if (row.status === action.status) return { kind: 'unchanged' };
        if (!statusChangeAllowed(row.status, action.status, row.transactionType)) {
          return { kind: 'fail', code: 'LISTING_STATUS_INVALID' };
        }
        return { kind: 'change' };
      case 'VISIBILITY':
        if (row.visibility === action.visibility) return { kind: 'unchanged' };
        assertVisibilityAllowed(ctx, action.visibility, row.energyRating);
        return { kind: 'change' };
      case 'SHARE_SCOPE':
        return row.shareScope === action.shareScope ? { kind: 'unchanged' } : { kind: 'change' };
      case 'PRICE_CHANGE': {
        if (row.priceCents === null) return { kind: 'fail', code: 'LISTING_PRICE_MISSING' };
        const priceCents = changedPrice(row.priceCents, action.percentBp);
        return priceCents === row.priceCents ? { kind: 'unchanged' } : { kind: 'change', priceCents };
      }
      case 'ASSIGN':
        return row.ownerUserId === action.ownerUserId ? { kind: 'unchanged' } : { kind: 'change' };
      case 'ADD_TAG':
        return { kind: 'change' }; // the insert decides: a listing that has the tag is unchanged
    }
  } catch (err) {
    if (isAppError(err)) return { kind: 'fail', code: err.code };
    throw err;
  }
}

export interface BulkStep {
  done: boolean;
  processed: number;
  total: number;
}

/**
 * One chunk of a bulk action, in the caller's transaction (the job opens it as the member who asked). Locks the
 * record, then the chunk's listings; applies the action with one statement per kind of write; counts the chunk.
 */
export async function runBulkChunk(ctx: Ctx, bulkActionId: string): Promise<BulkStep> {
  const agencyId = ctx.tenant.agencyId;
  const head = await repo.lockBulkChunk(ctx.tx, agencyId, bulkActionId, BULK_CHUNK);
  if (!head || head.state === 'DONE' || head.state === 'FAILED') {
    return { done: true, processed: head?.processed ?? 0, total: head?.total ?? 0 };
  }
  const userId = actorId(ctx);
  // The job acts as the member who asked, never as whoever a payload names.
  if (head.createdByUserId !== userId) throw new AppError('FORBIDDEN', { reason: 'not_the_requester' });
  const action = actionOf(head);
  const policy = ACTION_POLICY[action.type];
  const rows = await repo.lockOwnMany(ctx.tx, agencyId, head.chunk);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // A new owner must still be a member when the chunk runs (one read per chunk).
  let ownerGone = false;
  if (action.type === 'ASSIGN') {
    const { role } = await identity.getMemberAccess(ctx.tx, { agencyId, userId: action.ownerUserId });
    ownerGone = !role;
  }

  const failures: { listingId: string; code: string }[] = [];
  const changes: { row: repo.BulkTargetRow; priceCents?: number }[] = [];
  let unchanged = 0;
  for (const id of head.chunk) {
    const row = byId.get(id);
    const outcome: Outcome = !row
      ? { kind: 'fail', code: 'LISTING_NOT_FOUND' }
      : !can(ctx, policy, row) || impersonatorOf(ctx)
        ? { kind: 'fail', code: 'FORBIDDEN' }
        : ownerGone
          ? { kind: 'fail', code: 'VALIDATION_FAILED' }
          : outcomeFor(ctx, action, row);
    if (outcome.kind === 'fail') failures.push({ listingId: id, code: outcome.code });
    else if (outcome.kind === 'unchanged') unchanged += 1;
    else if (row)
      changes.push({ row, ...(outcome.priceCents !== undefined ? { priceCents: outcome.priceCents } : {}) });
  }

  const versions = await applyChanges(ctx, action, changes);
  unchanged += changes.length - versions.size;
  await recordHistory(ctx, action, changes, versions, userId);

  const events: OutboxMessage[] = [];
  for (const { row } of changes) {
    const version = versions.get(row.id);
    if (version === undefined) continue;
    const base = { listingId: row.id, agencyId, version };
    if (action.type === 'STATUS') {
      events.push(propertiesEvents.statusChanged({ ...base, from: row.status, to: action.status }));
    }
    if (action.type === 'VISIBILITY' || action.type === 'SHARE_SCOPE') {
      events.push(
        propertiesEvents.visibilityChanged({
          ...base,
          visibility: action.type === 'VISIBILITY' ? action.visibility : row.visibility,
          shareScope: action.type === 'SHARE_SCOPE' ? action.shareScope : row.shareScope,
        }),
      );
    }
    events.push(propertiesEvents.updated({ ...base, changed: [CHANGED_FIELD[action.type]] }));
  }
  await emit(ctx.tx, events);

  const room = Math.max(0, LISTING_BULK_FAILURES_KEPT - head.kept);
  const after = await repo.advanceBulk(ctx.tx, bulkActionId, {
    processed: head.chunk.length,
    succeeded: versions.size,
    unchanged,
    failed: failures.length,
    failures: failures.slice(0, room),
  });
  return { done: after.state === 'DONE', processed: after.processed, total: after.total };
}

/** The writes of one chunk; answers the new `version` of every listing that changed. */
async function applyChanges(
  ctx: Ctx,
  action: ListingBulkAction,
  changes: { row: repo.BulkTargetRow; priceCents?: number }[],
): Promise<Map<string, number>> {
  const ids = changes.map((c) => c.row.id);
  let updated: { id: string; version: number }[];
  switch (action.type) {
    case 'STATUS':
      updated = await repo.updateMany(ctx.tx, ids, { status: action.status });
      break;
    case 'VISIBILITY':
      updated = await repo.updateMany(ctx.tx, ids, { visibility: action.visibility });
      break;
    case 'SHARE_SCOPE':
      updated = await repo.updateMany(ctx.tx, ids, { shareScope: action.shareScope });
      break;
    case 'ASSIGN':
      updated = await repo.updateMany(ctx.tx, ids, { ownerUserId: action.ownerUserId });
      break;
    case 'PRICE_CHANGE':
      updated = await repo.setPrices(
        ctx.tx,
        changes.map((c) => ({ id: c.row.id, priceCents: c.priceCents as number })),
      );
      break;
    case 'ADD_TAG': {
      const tagged = await repo.addTag(ctx.tx, ctx.tenant.agencyId, ids, action.tag);
      updated = await repo.bumpVersions(ctx.tx, tagged);
      break;
    }
  }
  return new Map(updated.map((u) => [u.id, u.version]));
}

/** Price and status history of the changed listings, one insert each (like an edit). */
async function recordHistory(
  ctx: Ctx,
  action: ListingBulkAction,
  changes: { row: repo.BulkTargetRow; priceCents?: number }[],
  versions: Map<string, number>,
  userId: string,
): Promise<void> {
  const changed = changes.filter((c) => versions.has(c.row.id));
  if (action.type === 'PRICE_CHANGE') {
    await repo.insertPriceHistories(
      ctx.tx,
      changed.map(({ row, priceCents }) => ({
        id: newId(),
        propertyId: row.id,
        agencyId: row.agencyId,
        previousPriceCents: row.priceCents,
        priceCents: priceCents ?? null,
        currency: row.currency,
        changedByUserId: userId,
      })),
    );
  }
  if (action.type === 'STATUS') {
    await repo.insertStatusHistories(
      ctx.tx,
      changed.map(({ row }) => ({
        id: newId(),
        propertyId: row.id,
        agencyId: row.agencyId,
        fromStatus: row.status,
        toStatus: action.status,
        changedByUserId: userId,
      })),
    );
  }
}
