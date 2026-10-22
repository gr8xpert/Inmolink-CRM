/**
 * Units of a development (S4-02): the owner creates them (one or a CSV's worth), edits one with `version`, or
 * applies one change to many (availability toggles). Every status and price change writes history and emits
 * `developments.unit.statusChanged` / `priceChanged` in the transaction of the change; an approved price list
 * writes the history and one `developments.priceList.approved` instead (`price-lists.ts`, S5-F3).
 */
import {
  type BulkUpdateUnitsBody,
  type CreateUnitsBody,
  type ListUnitsQuery,
  MAX_UNITS_PER_DEVELOPMENT,
  type UnitDto,
  type UnitList,
  type UnitPage,
  type UpdateUnitBody,
} from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import * as compliance from '../compliance';
import { developmentsEvents } from './events';
import { assertCan } from './policy';
import * as repo from './repo';
import {
  actorId,
  assertCommissionCurrency,
  commissionColumns,
  commissionLabel,
  commissionOf,
  num,
  ownForChange,
  readable,
  withDbErrors,
} from './service';

/** At most this many unit ids and distinct previous commissions go into one audit entry (4 KB metadata cap). */
const UNIT_AUDIT_IDS = 20;

/**
 * Audits the units whose commission (the deal offered to collaborating agencies) changed: one entry per call —
 * the new commission, the distinct previous ones and the units (S5-F1).
 */
async function auditUnitCommission(
  ctx: Ctx,
  developmentId: string,
  changes: readonly { before: repo.UnitListRow; after: repo.UnitRow }[],
): Promise<void> {
  const label = (u: repo.UnitListRow) => commissionLabel(commissionOf(u, u.currency));
  const changed = changes.filter((c) => label(c.before) !== label(c.after));
  const first = changed[0];
  if (!first) return;
  const before = [...new Set(changed.map((c) => label(c.before) ?? 'none'))];
  await compliance.audit(
    ctx,
    'developments.unit.commissionChanged',
    changed.length === 1 ? { type: 'unit', id: first.after.id } : null,
    {
      developmentId,
      units: changed.length,
      unitIds: changed.slice(0, UNIT_AUDIT_IDS).map((c) => c.after.id),
      before: before.slice(0, UNIT_AUDIT_IDS),
      after: label(first.after),
      truncated: changed.length > UNIT_AUDIT_IDS || before.length > UNIT_AUDIT_IDS,
    },
  );
}

const area = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : String(v));

/** Units are readable wherever their development is; Client Mode never gets the commission. */
export function toUnitDto(ctx: Ctx, row: repo.UnitListRow): UnitDto {
  return {
    id: row.id,
    developmentId: row.developmentId,
    phaseId: row.phaseId,
    ref: row.ref,
    propertyTypeId: row.propertyTypeId,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    internalM2: num(row.internalM2),
    terraceM2: num(row.terraceM2),
    plotM2: num(row.plotM2),
    floor: row.floor,
    orientation: row.orientation,
    price: row.priceCents === null ? null : { amountCents: row.priceCents, currency: row.currency },
    status: row.status,
    commission: ctx.clientMode ? null : commissionOf(row, row.currency),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type UnitPatchInput = Partial<Omit<UpdateUnitBody, 'version'>>;

function unitPatch(input: UnitPatchInput): Partial<repo.UnitInsert> {
  const patch: Partial<repo.UnitInsert> = {};
  for (const k of ['ref', 'phaseId', 'propertyTypeId', 'bedrooms', 'bathrooms', 'floor', 'orientation'] as const) {
    if (input[k] !== undefined) Object.assign(patch, { [k]: input[k] });
  }
  for (const k of ['internalM2', 'terraceM2', 'plotM2'] as const) {
    if (input[k] !== undefined) patch[k] = area(input[k]);
  }
  if (input.priceCents !== undefined) patch.priceCents = input.priceCents;
  if (input.status !== undefined) patch.status = input.status;
  if (input.commission !== undefined) Object.assign(patch, commissionColumns(input.commission));
  return patch;
}

/** History rows and events for units edited by hand from `before` to `after` (same order, same ids). */
async function recordUnitChanges(
  ctx: Ctx,
  pairs: readonly { before: repo.UnitListRow; after: repo.UnitRow }[],
): Promise<void> {
  const userId = actorId(ctx);
  const prices: Parameters<typeof repo.insertPriceHistories>[1] = [];
  const statuses: Parameters<typeof repo.insertStatusHistories>[1] = [];
  const events: OutboxMessage[] = [];
  for (const { before, after } of pairs) {
    const ids = { unitId: after.id, developmentId: after.developmentId, agencyId: after.agencyId };
    const b = toUnitDto(ctx, before);
    const a = toUnitDto(ctx, after);
    const changed = (Object.keys(a) as (keyof UnitDto)[]).filter(
      (k) => !['version', 'updatedAt'].includes(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]),
    );
    if (changed.length === 0) continue;
    events.push(developmentsEvents.unitUpdated({ ...ids, version: after.version, changed }));
    if (before.status !== after.status) {
      statuses.push({
        id: newId(),
        unitId: after.id,
        agencyId: after.agencyId,
        priceListId: null,
        fromStatus: before.status,
        toStatus: after.status,
        changedByUserId: userId,
      });
      events.push(
        developmentsEvents.unitStatusChanged({ ...ids, version: after.version, from: before.status, to: after.status }),
      );
    }
    if (before.priceCents !== after.priceCents) {
      prices.push({
        id: newId(),
        unitId: after.id,
        agencyId: after.agencyId,
        priceListId: null,
        previousPriceCents: before.priceCents,
        priceCents: after.priceCents,
        currency: after.currency,
        changedByUserId: userId,
      });
      events.push(developmentsEvents.unitPriceChanged({ ...ids, version: after.version, priceListId: null }));
    }
  }
  await repo.insertStatusHistories(ctx.tx, statuses);
  await repo.insertPriceHistories(ctx.tx, prices);
  await emit(ctx.tx, events);
}

/** `POST /v1/developments/:id/units`: one unit or a CSV's worth, in the development's currency. */
export async function createUnits(ctx: Ctx, developmentId: string, input: CreateUnitsBody): Promise<UnitList> {
  const dev = await ownForChange(ctx, developmentId, 'development.update');
  if (input.units.some((u) => u.commission != null)) assertCan(ctx, 'development.commission', dev);
  for (const u of input.units) assertCommissionCurrency(u.commission, dev.currency);
  const existing = await repo.countUnits(ctx.tx, developmentId);
  if (existing + input.units.length > MAX_UNITS_PER_DEVELOPMENT) {
    throw new AppError('DEVELOPMENT_UNIT_LIMIT', { max: MAX_UNITS_PER_DEVELOPMENT });
  }
  const userId = actorId(ctx);
  const rows = await withDbErrors(() =>
    repo.insertUnits(
      ctx.tx,
      input.units.map((u) => ({
        ...unitPatch(u),
        id: newId(),
        developmentId,
        agencyId: dev.agencyId,
        ref: u.ref,
        propertyTypeId: u.propertyTypeId,
        currency: dev.currency,
      })),
    ),
  );
  await repo.insertStatusHistories(
    ctx.tx,
    rows.map((r) => ({
      id: newId(),
      unitId: r.id,
      agencyId: r.agencyId,
      fromStatus: null,
      toStatus: r.status,
      changedByUserId: userId,
    })),
  );
  await repo.insertPriceHistories(
    ctx.tx,
    rows
      .filter((r) => r.priceCents !== null)
      .map((r) => ({
        id: newId(),
        unitId: r.id,
        agencyId: r.agencyId,
        previousPriceCents: null,
        priceCents: r.priceCents,
        currency: r.currency,
        changedByUserId: userId,
      })),
  );
  await emit(
    ctx.tx,
    rows.map((r) =>
      developmentsEvents.unitCreated({ unitId: r.id, developmentId, agencyId: r.agencyId, version: r.version }),
    ),
  );
  return { items: rows.map((r) => toUnitDto(ctx, r)) };
}

/** `PATCH /v1/developments/:id/units/:unitId`: any field, `version` checked; status and price write history. */
export async function updateUnit(
  ctx: Ctx,
  developmentId: string,
  unitId: string,
  input: UpdateUnitBody,
): Promise<UnitDto> {
  const dev = await ownForChange(ctx, developmentId, 'development.update');
  if (input.commission !== undefined) assertCan(ctx, 'development.commission', dev);
  assertCommissionCurrency(input.commission, dev.currency);
  const [before] = await repo.unitsForUpdate(ctx.tx, developmentId, [unitId]);
  if (!before) throw new AppError('UNIT_NOT_FOUND');
  const { version, ...fields } = input;
  const after = await withDbErrors(() => repo.updateUnit(ctx.tx, unitId, version, unitPatch(fields)));
  if (!after) throw new AppError('VERSION_CONFLICT');
  await recordUnitChanges(ctx, [{ before, after }]);
  if (input.commission !== undefined) await auditUnitCommission(ctx, developmentId, [{ before, after }]);
  return toUnitDto(ctx, after);
}

/** `POST /v1/developments/:id/units/bulk`: one change on up to 500 units (no `version`: the latest wins). */
export async function bulkUpdateUnits(ctx: Ctx, developmentId: string, input: BulkUpdateUnitsBody): Promise<UnitList> {
  const dev = await ownForChange(ctx, developmentId, 'development.update');
  if (input.patch.commission !== undefined) assertCan(ctx, 'development.commission', dev);
  assertCommissionCurrency(input.patch.commission, dev.currency);
  const before = await repo.unitsForUpdate(ctx.tx, developmentId, input.unitIds);
  if (before.length !== input.unitIds.length) throw new AppError('UNIT_NOT_FOUND');
  const after = await withDbErrors(() =>
    repo.updateUnits(ctx.tx, developmentId, input.unitIds, unitPatch(input.patch)),
  );
  const afterById = new Map(after.map((r) => [r.id, r]));
  const changes = before.map((b) => ({ before: b, after: afterById.get(b.id) as repo.UnitRow }));
  await recordUnitChanges(ctx, changes);
  if (input.patch.commission !== undefined) await auditUnitCommission(ctx, developmentId, changes);
  return { items: before.map((b) => toUnitDto(ctx, afterById.get(b.id) as repo.UnitRow)) };
}

/** `DELETE /v1/developments/:id/units/:unitId`: removes the unit and its history. */
export async function deleteUnit(ctx: Ctx, developmentId: string, unitId: string): Promise<void> {
  const dev = await ownForChange(ctx, developmentId, 'development.update');
  if (!(await repo.deleteUnit(ctx.tx, developmentId, unitId))) throw new AppError('UNIT_NOT_FOUND');
  await emit(ctx.tx, developmentsEvents.unitDeleted({ unitId, developmentId, agencyId: dev.agencyId }));
}

const encodeRefCursor = (ref: string) => Buffer.from(JSON.stringify([ref])).toString('base64url');

function decodeRefCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [ref] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof ref === 'string' && ref.length <= 40) return ref;
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

/** `GET /v1/developments/:id/units`: the unit table by reference, for the owner and agencies it is shared with. */
export async function listUnits(ctx: Ctx, developmentId: string, q: ListUnitsQuery): Promise<UnitPage> {
  await readable(ctx, developmentId);
  const page = await repo.listUnits(ctx.tx, developmentId, {
    limit: q.limit,
    ...(q.status ? { status: q.status } : {}),
    ...(q.cursor !== undefined ? { afterRef: decodeRefCursor(q.cursor) } : {}),
  });
  const last = page.items.at(-1);
  return {
    items: page.items.map((r) => toUnitDto(ctx, r)),
    nextCursor: page.hasMore && last ? encodeRefCursor(last.ref) : null,
  };
}

/**
 * A feed's changes to many units of one development (S7-F14), as three statements whatever the count: the units
 * locked, one `UPDATE … FROM unnest`, then history rows and events for what really changed. Returns the units written.
 */
export async function updateFeedUnits(
  ctx: Ctx,
  developmentId: string,
  changes: readonly repo.FeedUnitValues[],
): Promise<number> {
  if (changes.length === 0) return 0;
  await ownForChange(ctx, developmentId, 'development.update');
  const before = await repo.unitsForUpdate(
    ctx.tx,
    developmentId,
    changes.map((c) => c.id),
  );
  const after = await withDbErrors(() => repo.setFeedUnits(ctx.tx, developmentId, changes));
  const beforeOf = new Map(before.map((b) => [b.id, b]));
  const pairs = after.flatMap((a) => {
    const b = beforeOf.get(a.id);
    return b ? [{ before: b, after: a }] : [];
  });
  await recordUnitChanges(ctx, pairs);
  return after.length;
}
