/**
 * Development use cases (S4-02, PATTERNS §7, PLAN §6 M3). Only the owner agency writes a development, its units
 * and price lists; other verified agencies read OPEN ones, or PRIVATE_NETWORK ones naming them, through RLS
 * (S4-01). Every change is optimistic on `version` (bulk unit edits excepted), writes unit price and status
 * history, and emits `developments.*` events in the same transaction.
 */
import type {
  Commission,
  CreateDevelopmentBody,
  DevelopmentDto,
  DevelopmentPage,
  ListDevelopmentsQuery,
  LockableDevelopmentField,
  SetDevelopmentAccessBody,
  UpdateDevelopmentBody,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import { developmentsEvents } from './events';
import { assertCan, type DevelopmentsAction } from './policy';
import * as repo from './repo';

export function actorId(ctx: Ctx): string {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return ctx.actor.userId;
}

export const num = (v: string | null) => (v === null ? null : Number(v));

/** Commission as columns (the development's and a unit's have the same three). */
export function commissionColumns(c: Commission | null) {
  if (c === null) return { commissionBp: null, commissionFixedCents: null, commissionIncludesVat: false };
  return c.type === 'PCT'
    ? { commissionBp: c.basisPoints, commissionFixedCents: null, commissionIncludesVat: c.includesVat }
    : { commissionBp: null, commissionFixedCents: c.amount.amountCents, commissionIncludesVat: c.includesVat };
}

export function commissionOf(
  row: { commissionBp: number | null; commissionFixedCents: number | null; commissionIncludesVat: boolean },
  currency: string,
): Commission | null {
  if (row.commissionBp !== null) {
    return { type: 'PCT', basisPoints: row.commissionBp, includesVat: row.commissionIncludesVat };
  }
  if (row.commissionFixedCents !== null) {
    return {
      type: 'FIXED',
      amount: { amountCents: row.commissionFixedCents, currency },
      includesVat: row.commissionIncludesVat,
    };
  }
  return null;
}

/** A commission as one audit value (`PCT 500bp` / `FIXED 1500000 EUR`, `+VAT` when included); `null` for none. */
export function commissionLabel(c: Commission | null): string | null {
  if (c === null) return null;
  const vat = c.includesVat ? ' +VAT' : '';
  return c.type === 'PCT' ? `PCT ${c.basisPoints}bp${vat}` : `FIXED ${c.amount.amountCents} ${c.amount.currency}${vat}`;
}

/** At most this many added and this many removed agency ids go into an access audit entry (4 KB metadata cap). */
export const ACCESS_AUDIT_IDS = 20;

/** A fixed commission is in the development's currency (the DTO reports it in that currency). */
export function assertCommissionCurrency(commission: Commission | null | undefined, currency: string): void {
  if (commission?.type === 'FIXED' && commission.amount.currency !== currency) {
    throw new AppError('VALIDATION_FAILED', { field: 'commission', reason: 'currency' });
  }
}

/** Constraints the caller can violate, by name: a missing reference is VALIDATION_FAILED, a taken one a 409. */
const FK_FIELDS: Record<string, string> = {
  developments_location_id_locations_id_fk: 'locationId',
  units_property_type_id_property_types_id_fk: 'propertyTypeId',
  units_phase_fk: 'phaseId',
  development_access_allowed_agency_id_agencies_agency_id_fk: 'allowedAgencyIds',
  price_lists_source_document_fk: 'sourceDocumentId',
};
const UNIQUE_CODES: Record<string, 'DEVELOPMENT_REF_TAKEN' | 'UNIT_REF_TAKEN'> = {
  developments_agency_ref_uq: 'DEVELOPMENT_REF_TAKEN',
  units_development_ref_uq: 'UNIT_REF_TAKEN',
};

export async function withDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    const constraint = cause?.constraint ?? '';
    const field = cause?.code === '23503' ? FK_FIELDS[constraint] : undefined;
    if (field) throw new AppError('VALIDATION_FAILED', { field, reason: 'unknown' });
    const code = cause?.code === '23505' ? UNIQUE_CODES[constraint] : undefined;
    if (code) throw new AppError(code);
    throw err;
  }
}

/**
 * The DTO for `ctx`: the owner gets the sharing settings, other agencies the network view, and Client Mode
 * neither the commission nor, on another agency's development, who maintains it.
 */
export function toDevelopmentDto(ctx: Ctx, row: repo.DevelopmentListRow, allowed: string[] | null): DevelopmentDto {
  const own = row.agencyId === ctx.tenant.agencyId;
  const lat = num(row.lat);
  const lng = num(row.lng);
  return {
    id: row.id,
    agencyId: ctx.clientMode && !own ? null : row.agencyId,
    ref: row.ref,
    name: row.name,
    status: row.status,
    completionDate: row.completionDate,
    locationId: row.locationId,
    coordinates: lat === null || lng === null ? null : { lat, lng },
    commission: ctx.clientMode ? null : commissionOf(row, row.currency),
    currency: row.currency,
    managedBy: row.managedBy,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    access: own && !ctx.clientMode ? { kind: row.access, allowedAgencyIds: allowed ?? [] } : null,
    feed:
      own && !ctx.clientMode && row.fromFeed
        ? { lockedFields: [...(row.lockedFields as LockableDevelopmentField[])].sort() }
        : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The caller's own development for a change, row-locked. Another agency's development the caller can see is
 * FORBIDDEN — only the owner writes — and anything else, deleted ones included, DEVELOPMENT_NOT_FOUND.
 */
export async function ownForChange(ctx: Ctx, id: string, action: DevelopmentsAction): Promise<repo.DevelopmentRow> {
  // The role check first (Client Mode, partners, impersonation): a refused caller locks nothing, learns nothing.
  assertCan(ctx, action);
  const row = await repo.getOwnForUpdate(ctx.tx, ctx.tenant.agencyId, id);
  if (row) return row;
  if (await repo.getDevelopment(ctx.tx, id)) throw new AppError('FORBIDDEN');
  throw new AppError('DEVELOPMENT_NOT_FOUND');
}

/** A development the caller can read (own or shared), not deleted. */
export async function readable(ctx: Ctx, id: string): Promise<repo.DevelopmentRow> {
  assertCan(ctx, 'development.read');
  const row = await repo.getDevelopment(ctx.tx, id);
  if (!row) throw new AppError('DEVELOPMENT_NOT_FOUND');
  return row;
}

/**
 * The agency that owns a development, or a unit, the caller can read — what listing overrides (S3-10) check
 * before an agency rewrites the text of a new build it presents.
 */
export async function presentableOwner(ctx: Ctx, kind: 'DEVELOPMENT' | 'UNIT', id: string): Promise<string> {
  if (kind === 'DEVELOPMENT') return (await readable(ctx, id)).agencyId;
  assertCan(ctx, 'development.read');
  const owner = await repo.getUnitOwner(ctx.tx, id);
  if (!owner) throw new AppError('UNIT_NOT_FOUND');
  return owner;
}

/** The caller's own development to read its owner-only data (price lists), without a lock. */
export async function ownForRead(ctx: Ctx, id: string, action: DevelopmentsAction): Promise<repo.DevelopmentRow> {
  assertCan(ctx, action);
  const row = await repo.getDevelopment(ctx.tx, id);
  if (!row) throw new AppError('DEVELOPMENT_NOT_FOUND');
  if (row.agencyId !== ctx.tenant.agencyId) throw new AppError('FORBIDDEN');
  return row;
}

const point = (c: { lat: number; lng: number } | null | undefined) =>
  c === undefined ? {} : c === null ? { lat: null, lng: null } : { lat: String(c.lat), lng: String(c.lng) };

/**
 * `POST /v1/developments`: a PRIVATE_NETWORK development of the caller's agency, shared with nobody yet, in the
 * agency's currency unless the body names one (S5-F3).
 */
export async function createDevelopment(ctx: Ctx, input: CreateDevelopmentBody): Promise<DevelopmentDto> {
  assertCan(ctx, 'development.create');
  if (input.commission != null) assertCan(ctx, 'development.commission');
  const currency = input.currency ?? (await agencies.getAgencySettings(ctx)).currency;
  assertCommissionCurrency(input.commission, currency);
  const agencyId = ctx.tenant.agencyId;
  const row = await withDbErrors(() =>
    repo.insertDevelopment(ctx.tx, {
      id: newId(),
      agencyId,
      ref: input.ref,
      name: input.name,
      status: input.status ?? 'OFF_PLAN',
      completionDate: input.completionDate ?? null,
      locationId: input.locationId,
      ...point(input.coordinates ?? null),
      ...commissionColumns(input.commission ?? null),
      currency,
      managedBy: input.managedBy ?? 'DEVELOPER',
    }),
  );
  await emit(ctx.tx, developmentsEvents.created({ developmentId: row.id, agencyId, version: row.version }));
  return toDevelopmentDto(ctx, row, []);
}

/** `GET /v1/developments/:id`: the owner view for the agency's own, the network view for a shared one. */
export async function getDevelopment(ctx: Ctx, id: string): Promise<DevelopmentDto> {
  const row = await readable(ctx, id);
  const own = row.agencyId === ctx.tenant.agencyId;
  const allowed = own ? ((await repo.accessOf(ctx.tx, [id])).get(id) ?? []) : null;
  return toDevelopmentDto(ctx, row, allowed);
}

/** `GET /v1/developments`: the agency's own developments, newest first. Two statements. */
export async function listDevelopments(ctx: Ctx, q: ListDevelopmentsQuery): Promise<DevelopmentPage> {
  assertCan(ctx, 'development.read');
  const page = await repo.listOwnDevelopments(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  const access = await repo.accessOf(
    ctx.tx,
    page.items.map((r) => r.id),
  );
  const last = page.items.at(-1);
  return {
    items: page.items.map((r) => toDevelopmentDto(ctx, r, access.get(r.id) ?? [])),
    nextCursor: page.hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

/**
 * The feed field locks after an edit (S8-F5), or undefined when they stay as they are: the ones sent (a feed's
 * development only), or — when none are sent — the current ones plus each feed-owned field the edit changes, so
 * the next feed run does not undo a hand edit.
 */
export function lockedFieldsAfter(
  current: Pick<repo.DevelopmentRow, 'fromFeed' | 'lockedFields' | 'name' | 'locationId'>,
  input: Pick<UpdateDevelopmentBody, 'name' | 'locationId' | 'lockedFields'>,
): string[] | undefined {
  const same = (next: readonly string[]) => next.join() === [...current.lockedFields].sort().join();
  if (input.lockedFields !== undefined) {
    // Only a feed's development has fields a feed owns.
    if (!current.fromFeed) throw new AppError('VALIDATION_FAILED', { field: 'lockedFields', reason: 'not_feed' });
    const next = [...input.lockedFields].sort();
    return same(next) ? undefined : next;
  }
  if (!current.fromFeed) return undefined;
  const add: LockableDevelopmentField[] = [
    ...(input.name !== undefined && input.name !== current.name ? (['name'] as const) : []),
    ...(input.locationId !== undefined && input.locationId !== current.locationId ? (['location'] as const) : []),
  ];
  if (add.every((f) => current.lockedFields.includes(f))) return undefined;
  return [...new Set([...current.lockedFields, ...add])].sort();
}

/**
 * `PATCH /v1/developments/:id`: fields, commission (admins), the "units and prices are current" mark, and the feed
 * field locks (a hand edit of a feed-owned field locks it).
 */
export async function updateDevelopment(ctx: Ctx, id: string, input: UpdateDevelopmentBody): Promise<DevelopmentDto> {
  const current = await ownForChange(ctx, id, 'development.update');
  if (input.commission !== undefined) assertCan(ctx, 'development.commission', current);
  assertCommissionCurrency(input.commission, current.currency);
  const lockedFields = lockedFieldsAfter(current, input);
  const patch: Partial<repo.DevelopmentInsert> = {
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.completionDate !== undefined ? { completionDate: input.completionDate } : {}),
    ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
    ...(input.managedBy !== undefined ? { managedBy: input.managedBy } : {}),
    ...point(input.coordinates),
    ...(input.commission !== undefined ? commissionColumns(input.commission) : {}),
    ...(input.verified ? { lastVerifiedAt: clock.now() } : {}),
    ...(lockedFields !== undefined ? { lockedFields } : {}),
  };
  if (Object.keys(patch).length === 0 && input.lockedFields !== undefined) {
    // Only the locks it already has: nothing to write, no version bump, no event.
    if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
    return getDevelopmentDtoOf(ctx, current);
  }
  const updated = await withDbErrors(() => repo.updateDevelopment(ctx.tx, id, input.version, patch));
  if (!updated) throw new AppError('VERSION_CONFLICT');
  const before = toDevelopmentDto(ctx, current, null);
  const after = toDevelopmentDto(ctx, updated, null);
  const changed = (Object.keys(after) as (keyof DevelopmentDto)[]).filter(
    (k) => !['version', 'updatedAt'].includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (changed.includes('commission')) {
    // The deal offered to collaborating agencies: who changed it, from what to what (S5-F1).
    await compliance.audit(
      ctx,
      'developments.development.commissionChanged',
      { type: 'development', id },
      {
        before: commissionLabel(commissionOf(current, current.currency)),
        after: commissionLabel(commissionOf(updated, updated.currency)),
      },
    );
  }
  await emit(
    ctx.tx,
    developmentsEvents.updated({ developmentId: id, agencyId: updated.agencyId, version: updated.version, changed }),
  );
  return getDevelopmentDtoOf(ctx, updated);
}

async function getDevelopmentDtoOf(ctx: Ctx, row: repo.DevelopmentRow): Promise<DevelopmentDto> {
  return toDevelopmentDto(ctx, row, (await repo.accessOf(ctx.tx, [row.id])).get(row.id) ?? []);
}

/**
 * `PUT /v1/developments/:id/access`: OPEN (every verified agency) or PRIVATE_NETWORK with the agencies named.
 * Reaching other agencies needs a verified agency (PLAN §3 #3), like sharing a listing. Audited with the kind and
 * the agencies added and removed.
 */
export async function setDevelopmentAccess(
  ctx: Ctx,
  id: string,
  input: SetDevelopmentAccessBody,
): Promise<DevelopmentDto> {
  const current = await ownForChange(ctx, id, 'development.share');
  if (input.kind === 'OPEN' || input.allowedAgencyIds.length > 0) agencies.assertVerified(ctx, 'development.share');
  if (input.allowedAgencyIds.includes(current.agencyId)) {
    throw new AppError('VALIDATION_FAILED', { field: 'allowedAgencyIds', reason: 'own_agency' });
  }
  const previous = (await repo.accessOf(ctx.tx, [id])).get(id) ?? [];
  const added = input.allowedAgencyIds.filter((a) => !previous.includes(a));
  // Only agencies in the directory (listed, verified): an unknown, unlisted or suspended one gets the same answer,
  // so the call reveals nothing about agencies the caller cannot see (S5-F1). Already allowed ones stay.
  if (added.length > 0) {
    const listed = await agencies.networkAgencyNames(ctx, added);
    if (added.some((a) => !listed.has(a))) {
      throw new AppError('VALIDATION_FAILED', { field: 'allowedAgencyIds', reason: 'unknown' });
    }
  }
  const updated = await repo.updateDevelopment(ctx.tx, id, input.version, { access: input.kind });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await withDbErrors(() => repo.replaceAccess(ctx.tx, updated, input.allowedAgencyIds));
  const removed = previous.filter((a) => !input.allowedAgencyIds.includes(a));
  await compliance.audit(
    ctx,
    'developments.development.accessChanged',
    { type: 'development', id },
    {
      kindBefore: current.access,
      kindAfter: input.kind,
      allowedBefore: previous.length,
      allowedAfter: input.allowedAgencyIds.length,
      added: added.slice(0, ACCESS_AUDIT_IDS),
      removed: removed.slice(0, ACCESS_AUDIT_IDS),
      truncated: added.length > ACCESS_AUDIT_IDS || removed.length > ACCESS_AUDIT_IDS,
    },
  );
  await emit(
    ctx.tx,
    developmentsEvents.accessChanged({ developmentId: id, agencyId: updated.agencyId, version: updated.version }),
  );
  return toDevelopmentDto(ctx, updated, [...input.allowedAgencyIds].sort());
}

/** `DELETE /v1/developments/:id?version=`: soft delete; no agency reads it from then on. */
export async function deleteDevelopment(ctx: Ctx, id: string, version: number): Promise<void> {
  await ownForChange(ctx, id, 'development.delete');
  const updated = await repo.updateDevelopment(ctx.tx, id, version, { deletedAt: clock.now() });
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    developmentsEvents.deleted({ developmentId: id, agencyId: updated.agencyId, version: updated.version }),
  );
}
