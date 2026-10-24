import {
  AppError,
  type ConvertProspectBody,
  CRM_PROSPECT_LIMITS,
  CreateListingBody,
  type CreateProspectBody,
  type ListProspectsQuery,
  type MoveProspectBody,
  PROSPECT_STAGES,
  type ProspectBoardDto,
  type ProspectBoardQuery,
  type ProspectColumnQuery,
  type ProspectConversionDto,
  type ProspectDto,
  type ProspectFollowUpsQuery,
  type ProspectPage,
  type ProspectStage,
  type UpdateProspectBody,
} from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as identity from '../identity';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import * as activitiesRepo from './activities-repo';
import { auditImpersonatedRead } from './audit';
import { assertCan, can } from './policy';
import * as prospectsRepo from './prospects-repo';
import { isRank, rankBetween, spreadRank, timeRank } from './rank';

/**
 * The seller acquisition board (S10-07, PLAN §7 M8). A seller prospect is a property owner the agency is trying to win:
 * the seller (a contact), where the property is, its type, an estimated price, the member working it, a next follow-up
 * and confidential notes. It moves across fixed stages (`PROSPECT_STAGES`) on a board ordered like the pipeline's
 * (`crm/rank.ts`: a drag rewrites one row), and one click converts it into a DRAFT listing:
 *
 *  - the prospect is locked, so two clicks (or a retry) convert once: a converted prospect answers its listing again;
 *  - the listing is created through properties' `createListing` (DRAFT, PRIVATE, the agency's default commission) with
 *    the seller in its `property_privates.seller_contact_id` — the STRICT private side, never in a DTO, a read model, a
 *    network view or Client Mode;
 *  - the prospect enters `LISTED` (newest first) with its listing.
 *
 * `LISTED` is reached only by converting, and a converted prospect stays there (its listing is the agency's record).
 * Confidential notes stay on the prospect (never copied to the listing) and are shown to the agency's members only:
 * not to staff impersonating one (`crm.prospects.confidential`), never in Client Mode (nothing of the CRM is).
 */

const userIdOf = (ctx: Ctx): string | null => (ctx.actor.kind === 'user' ? ctx.actor.userId : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toProspectDto(ctx: Ctx, row: prospectsRepo.ProspectRow): ProspectDto {
  const name = [row.contactFirstName, row.contactLastName].filter(Boolean).join(' ').trim();
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    contactName: row.contactId ? name || null : null,
    address: row.address,
    area: row.area,
    propertyTypeId: row.propertyTypeId,
    locationId: row.locationId,
    estimatedPrice:
      row.estimatedPriceCents === null || row.currency === null
        ? null
        : { amountCents: row.estimatedPriceCents, currency: row.currency },
    stage: row.stage as ProspectStage,
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    nextFollowUpAt: row.nextFollowUpAt ? row.nextFollowUpAt.toISOString() : null,
    assignedUserId: row.assignedUserId,
    confidentialNotes: can(ctx, 'crm.prospects.confidential') ? row.confidentialNotes : null,
    listingId: row.listingId,
    convertedAt: row.convertedAt ? row.convertedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

async function prospectDto(ctx: Ctx, id: string): Promise<ProspectDto> {
  const row = await prospectsRepo.getProspect(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('PROSPECT_NOT_FOUND');
  return toProspectDto(ctx, row);
}

/** `assigned` of a query: `me` (the caller), `unassigned` (null), a member's id, or everyone's (undefined). */
function assignedOf(ctx: Ctx, assigned: string | undefined): string | null | undefined {
  if (assigned === undefined) return undefined;
  if (assigned === 'unassigned') return null;
  if (assigned === 'me') {
    const me = userIdOf(ctx);
    if (!me) throw new AppError('VALIDATION_FAILED', { field: 'assigned' });
    return me;
  }
  return assigned;
}

async function assertAssignee(ctx: Ctx, userId: string): Promise<void> {
  if (userId === userIdOf(ctx)) return;
  if (!(await identity.isActiveMember(ctx, userId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'assignedUserId', reason: 'not_a_member' });
  }
}

/**
 * A property type and location kept on a prospect must exist (stored without a foreign key: taxonomy's tables) — the
 * same lookups `createListing` relies on, so a conversion never fails on them later.
 */
async function assertTaxonomy(ctx: Ctx, input: { propertyTypeId?: string | null; locationId?: string | null }) {
  if (input.propertyTypeId && !(await taxonomy.propertyTypeExists(ctx.tx, input.propertyTypeId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'propertyTypeId', reason: 'unknown' });
  }
  if (input.locationId && !(await taxonomy.locationLineage(ctx.tx, input.locationId))) {
    throw new AppError('VALIDATION_FAILED', { field: 'locationId', reason: 'unknown' });
  }
}

/** A price's currency: the one sent, else the agency's (its settings); none without a price. */
async function currencyOf(
  ctx: Ctx,
  price: { currency?: string | undefined } | null | undefined,
): Promise<string | null> {
  if (!price) return null;
  return price.currency ?? (await agencies.getAgencySettings(ctx)).currency;
}

async function assertContact(ctx: Ctx, contactId: string): Promise<void> {
  if (!(await activitiesRepo.contactOpen(ctx.tx, ctx.tenant.agencyId, contactId))) {
    throw new AppError('CONTACT_NOT_FOUND');
  }
}

/** `GET /v1/crm/prospects`: newest first, keyset (≤ 100 per page). One query. */
export async function listProspects(ctx: Ctx, query: ListProspectsQuery): Promise<ProspectPage> {
  assertCan(ctx, 'crm.prospects.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await prospectsRepo.listProspects(
    ctx.tx,
    ctx.tenant.agencyId,
    { ...(query.stage ? { stage: query.stage } : {}), assigned: assignedOf(ctx, query.assigned) },
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  await auditImpersonatedRead(ctx, 'prospects', {
    count: Math.min(rows.length, query.limit),
    filter: { assigned: query.assigned, stage: query.stage },
  });
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.createdMs, id: r.id }),
    (r) => toProspectDto(ctx, r),
  );
}

/** `GET /v1/crm/prospects/follow-ups`: the by-date view, soonest first, keyset. One query. */
export async function listProspectFollowUps(ctx: Ctx, query: ProspectFollowUpsQuery): Promise<ProspectPage> {
  assertCan(ctx, 'crm.prospects.read');
  const cursor = decodeCursor(query.cursor);
  const rows = await prospectsRepo.followUps(
    ctx.tx,
    ctx.tenant.agencyId,
    new Date(query.from),
    new Date(query.to),
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  await auditImpersonatedRead(ctx, 'prospects', { count: Math.min(rows.length, query.limit) });
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.nextFollowUpAt ?? new Date(0), id: r.id }),
    (r) => toProspectDto(ctx, r),
  );
}

const encodeRank = (c: prospectsRepo.RankCursor): string =>
  Buffer.from(JSON.stringify([c.rank, c.id])).toString('base64url');

function decodeRank(cursor: string | undefined): prospectsRepo.RankCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [rank, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof rank === 'string' && isRank(rank) && typeof id === 'string' && UUID.test(id)) return { rank, id };
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

const boardOrder = (a: prospectsRepo.ProspectRow, b: prospectsRepo.ProspectRow) =>
  a.stageRank < b.stageRank ? -1 : a.stageRank > b.stageRank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function columnPage(ctx: Ctx, rows: prospectsRepo.ProspectRow[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((r) => toProspectDto(ctx, r)),
    nextCursor: rows.length > limit && last ? encodeRank({ rank: last.stageRank, id: last.id }) : null,
  };
}

/** `GET /v1/crm/prospects/board`: every stage, its count (capped) and first `limit` cards. Two queries. */
export async function getProspectBoard(ctx: Ctx, query: ProspectBoardQuery): Promise<ProspectBoardDto> {
  assertCan(ctx, 'crm.prospects.read');
  const agencyId = ctx.tenant.agencyId;
  const cards = await prospectsRepo.boardCards(ctx.tx, agencyId, PROSPECT_STAGES, query.limit);
  const counts = await prospectsRepo.stageCounts(ctx.tx, agencyId, PROSPECT_STAGES, CRM_PROSPECT_LIMITS.countCap + 1);
  const byStage = new Map<string, prospectsRepo.ProspectRow[]>();
  for (const c of cards) byStage.set(c.stage, [...(byStage.get(c.stage) ?? []), c]);
  await auditImpersonatedRead(ctx, 'prospects', { count: cards.length });
  return {
    columns: PROSPECT_STAGES.map((stage) => {
      const n = counts.get(stage) ?? 0;
      return {
        stage,
        count: Math.min(n, CRM_PROSPECT_LIMITS.countCap),
        countCapped: n > CRM_PROSPECT_LIMITS.countCap,
        ...columnPage(ctx, (byStage.get(stage) ?? []).sort(boardOrder), query.limit),
      };
    }),
  };
}

/** `GET /v1/crm/prospects/stages/:stage`: one column's next page, board order, keyset. One query. */
export async function listStageProspects(
  ctx: Ctx,
  stage: ProspectStage,
  query: ProspectColumnQuery,
): Promise<ProspectPage> {
  assertCan(ctx, 'crm.prospects.read');
  const cursor = decodeRank(query.cursor);
  const rows = await prospectsRepo.columnCards(
    ctx.tx,
    ctx.tenant.agencyId,
    stage,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  await auditImpersonatedRead(ctx, 'prospects', { count: Math.min(rows.length, query.limit), filter: { stage } });
  return columnPage(ctx, rows, query.limit);
}

export async function getProspect(ctx: Ctx, id: string): Promise<ProspectDto> {
  assertCan(ctx, 'crm.prospects.read');
  const prospect = await prospectDto(ctx, id);
  await auditImpersonatedRead(ctx, 'prospects', { target: { type: 'prospect', id } });
  return prospect;
}

/**
 * `POST /v1/crm/prospects`: in `NEW`, at the top of the column. With an `Idempotency-Key`, a retry by the same member
 * within 24 h with the same body answers the first prospect; another body is `IDEMPOTENCY_KEY_REUSED`.
 */
export async function createProspect(
  ctx: Ctx,
  input: CreateProspectBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ prospect: ProspectDto; replayed: boolean }> {
  assertCan(ctx, 'crm.prospects.write');
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('crm.prospect', userIdOf(ctx), opts.idempotencyKey, input);
  const prior = await replayOf(
    ctx.tx,
    idempotency,
    (since, key) => prospectsRepo.prospectByIdempotency(ctx.tx, agencyId, key.hash, since),
    { lock: true },
  );
  if (prior) return { prospect: await prospectDto(ctx, prior.id), replayed: true };
  const assignedUserId = input.assignedUserId ?? userIdOf(ctx);
  if (assignedUserId) await assertAssignee(ctx, assignedUserId);
  if (input.contactId) await assertContact(ctx, input.contactId);
  await assertTaxonomy(ctx, input);
  const id = newId();
  await prospectsRepo
    .insertProspect(ctx.tx, {
      id,
      agencyId,
      contactId: input.contactId ?? null,
      title: input.title,
      address: input.address ?? null,
      area: input.area ?? null,
      propertyTypeId: input.propertyTypeId ?? null,
      locationId: input.locationId ?? null,
      estimatedPriceCents: input.estimatedPrice?.amountCents ?? null,
      currency: await currencyOf(ctx, input.estimatedPrice),
      stageRank: timeRank(new Date(), id),
      nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
      assignedUserId,
      confidentialNotes: input.confidentialNotes ?? null,
      createdBy: userIdOf(ctx),
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    })
    .catch(keyReusedOn('seller_prospects_idempotency_uq'));
  return { prospect: await prospectDto(ctx, id), replayed: false };
}

/** `PATCH /v1/crm/prospects/:id` (optimistic `version`). The stage changes by a move or a conversion. */
export async function updateProspect(ctx: Ctx, id: string, input: UpdateProspectBody): Promise<ProspectDto> {
  assertCan(ctx, 'crm.prospects.write');
  const agencyId = ctx.tenant.agencyId;
  const current = await prospectsRepo.lockProspect(ctx.tx, agencyId, id);
  if (!current) throw new AppError('PROSPECT_NOT_FOUND');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  // staff impersonating never write (policy); a member who may not see the notes never overwrites them blind
  if (input.confidentialNotes !== undefined) assertCan(ctx, 'crm.prospects.confidential');
  const patch: prospectsRepo.ProspectPatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.address !== undefined) patch.address = input.address;
  if (input.area !== undefined) patch.area = input.area;
  if (input.propertyTypeId !== undefined) patch.propertyTypeId = input.propertyTypeId;
  if (input.locationId !== undefined) patch.locationId = input.locationId;
  await assertTaxonomy(ctx, {
    propertyTypeId: input.propertyTypeId !== current.propertyTypeId ? input.propertyTypeId : undefined,
    locationId: input.locationId !== current.locationId ? input.locationId : undefined,
  });
  if (input.confidentialNotes !== undefined) patch.confidentialNotes = input.confidentialNotes;
  if (input.nextFollowUpAt !== undefined) {
    patch.nextFollowUpAt = input.nextFollowUpAt === null ? null : new Date(input.nextFollowUpAt);
  }
  if (input.estimatedPrice !== undefined) {
    patch.estimatedPriceCents = input.estimatedPrice?.amountCents ?? null;
    patch.currency = await currencyOf(ctx, input.estimatedPrice);
  }
  if (input.contactId !== undefined && input.contactId !== current.contactId) {
    if (input.contactId) await assertContact(ctx, input.contactId);
    patch.contactId = input.contactId;
  }
  if (input.assignedUserId !== undefined && input.assignedUserId !== current.assignedUserId) {
    if (input.assignedUserId) await assertAssignee(ctx, input.assignedUserId);
    patch.assignedUserId = input.assignedUserId;
  }
  if (Object.keys(patch).length > 0) {
    if (!(await prospectsRepo.updateProspect(ctx.tx, agencyId, id, input.version, patch))) {
      throw new AppError('VERSION_CONFLICT');
    }
  }
  return prospectDto(ctx, id);
}

/** `DELETE /v1/crm/prospects/:id`: soft delete (a converted prospect's listing stays). */
export async function deleteProspect(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'crm.prospects.write');
  if (!(await prospectsRepo.softDeleteProspect(ctx.tx, ctx.tenant.agencyId, id))) {
    throw new AppError('PROSPECT_NOT_FOUND');
  }
}

/**
 * `POST /v1/crm/prospects/:id/move` (a drag at the prospect's `version`): into `stage`, right after `afterId` there
 * (null: the top) — a rank between the neighbours, so no other card is rewritten (unless the column must be re-ranked
 * first). `LISTED` only by converting; a converted prospect stays in `LISTED`. ≤ 6 statements (≤ 8 with a re-rank).
 */
export async function moveProspect(ctx: Ctx, id: string, input: MoveProspectBody): Promise<ProspectDto> {
  assertCan(ctx, 'crm.prospects.write');
  const agencyId = ctx.tenant.agencyId;
  if (input.afterId === id) throw new AppError('VALIDATION_FAILED', { field: 'afterId' });
  const current = await prospectsRepo.lockProspect(ctx.tx, agencyId, id);
  if (!current) throw new AppError('PROSPECT_NOT_FOUND');
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const changed = input.stage !== current.stage;
  if (changed && (input.stage === 'LISTED' || current.listingId !== null)) {
    throw new AppError('PROSPECT_STAGE_INVALID');
  }
  const rank = await dropRank(ctx, input.stage, input.afterId, id);
  const moved = await prospectsRepo.updateProspect(ctx.tx, agencyId, id, input.version, {
    stage: input.stage,
    stageRank: rank,
    ...(changed ? { stageEnteredAt: new Date() } : {}),
  });
  if (!moved) throw new AppError('VERSION_CONFLICT');
  return prospectDto(ctx, id);
}

async function dropRank(ctx: Ctx, stage: string, afterId: string | null, movedId: string): Promise<string> {
  const agencyId = ctx.tenant.agencyId;
  const between = async (): Promise<string | null> => {
    const gap = await prospectsRepo.dropGap(ctx.tx, agencyId, stage, afterId, movedId);
    if (!gap.found) throw new AppError('VERSION_CONFLICT');
    if (gap.upper !== null && gap.upper <= gap.lower) return null;
    const rank = rankBetween(gap.lower, gap.upper);
    return isRank(rank) ? rank : null;
  };
  const rank = await between();
  if (rank) return rank;
  if (!(await prospectsRepo.rebalanceColumn(ctx.tx, agencyId, stage, movedId, spreadRank))) {
    throw new AppError('VALIDATION_FAILED', { field: 'afterId', reason: 'column_too_large' });
  }
  const after = await between();
  if (!after) throw new AppError('INTERNAL', { reason: 'rank_after_rebalance' });
  return after;
}

/**
 * `POST /v1/crm/prospects/:id/convert`: one click → a DRAFT listing (see the module comment). Idempotent: the prospect
 * row is locked first, so a concurrent second click waits and then answers the listing the first one made
 * (`created: false`). A type or location missing on both the prospect and the body is `PROSPECT_INCOMPLETE`.
 */
export async function convertProspect(
  ctx: Ctx,
  id: string,
  input: ConvertProspectBody,
): Promise<ProspectConversionDto> {
  assertCan(ctx, 'crm.prospects.write');
  // converting creates a listing: the caller needs the listing policy too (S11-F15), checked before any lock or write
  if (!properties.can(ctx, 'listing.create')) throw new AppError('FORBIDDEN');
  const agencyId = ctx.tenant.agencyId;
  const current = await prospectsRepo.lockProspect(ctx.tx, agencyId, id);
  if (!current) throw new AppError('PROSPECT_NOT_FOUND');
  if (current.listingId) {
    return { prospect: toProspectDto(ctx, current), listingId: current.listingId, created: false };
  }
  // a closed seller (erased; a merge re-points before this) is never written onto a listing
  if (current.contactClosed)
    throw new AppError('PROSPECT_INCOMPLETE', { missing: 'contactId', reason: 'seller_closed' });
  const propertyTypeId = input.propertyTypeId ?? current.propertyTypeId;
  const locationId = input.locationId ?? current.locationId;
  if (!propertyTypeId || !locationId) {
    throw new AppError('PROSPECT_INCOMPLETE', { missing: !propertyTypeId ? 'propertyTypeId' : 'locationId' });
  }
  const listing = await properties.createListing(
    ctx,
    CreateListingBody.parse({
      transactionType: input.transactionType,
      propertyTypeId,
      locationId,
      ...(current.estimatedPriceCents !== null && current.currency !== null
        ? { priceCents: current.estimatedPriceCents, currency: current.currency }
        : {}),
    }),
    { sellerContactId: current.contactId },
  );
  const now = new Date();
  const updated = await prospectsRepo.updateProspect(ctx.tx, agencyId, id, current.version, {
    stage: 'LISTED',
    stageRank: timeRank(now, id),
    ...(current.stage !== 'LISTED' ? { stageEnteredAt: now } : {}),
    propertyTypeId,
    locationId,
    listingId: listing.id,
    convertedAt: now,
  });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  // the seller is unchanged by the conversion: its name comes from the locked read
  const prospect = toProspectDto(ctx, {
    ...updated,
    contactFirstName: current.contactFirstName,
    contactLastName: current.contactLastName,
  });
  return { prospect, listingId: listing.id, created: true };
}

/** A purged listing leaves its prospect (worker, the listing purge's job). */
export async function forgetListingProspects(p: { agencyId: string; listingId: string }): Promise<{ rows: number }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) =>
    prospectsRepo.clearListing(tx, p.agencyId, p.listingId),
  );
  return { rows };
}

/**
 * A contact merge (`crm.contact.merged`, worker): the listings whose seller was the closed contact name the open contact
 * it now lives on (properties' private side). Merges can be handled out of order (B→C before A→B): the survivor named
 * by the event may itself be closed by now, so the chain is followed (`merged_into_id`) to the open contact first.
 * Idempotent.
 */
export async function repointSellerListings(p: {
  agencyId: string;
  survivorId: string;
  mergedId: string;
}): Promise<{ rows: number }> {
  const target = await withTenant({ agencyId: p.agencyId }, (tx) =>
    prospectsRepo.openContactOf(tx, p.agencyId, p.survivorId),
  );
  if (!target) return { rows: 0 };
  return properties.repointSellerContact({ agencyId: p.agencyId, fromContactId: p.mergedId, toContactId: target });
}
