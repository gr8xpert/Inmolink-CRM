/**
 * The developments a feed lists (S7-F14, batched in S8-F3): created once per reference with their units; later runs
 * change only what the feed changed — the development's name, place and turning key-ready, a unit's price, status
 * and sizes — and withdraw the AVAILABLE units the feed created and its price list no longer names (never a unit
 * added by hand, never a RESERVED or SOLD one; a list that drops more than half of the feed's units withdraws none
 * and is reported as held — a truncated answer must not empty a development). Idempotent: a second run with the same input writes
 * nothing, bumps no version and emits no event. The feed never sets a commission or an access list — those stay the
 * owner's — so a feed development is a PRIVATE_NETWORK one shared with nobody.
 *
 * A whole import batch is a fixed number of statements, whatever its size: the developments locked by reference and
 * their units read (one statement each), the diff in memory, then one statement per kind of write. Only when that
 * batch write fails does each development get its own savepoint, so one bad development is skipped alone.
 */
import { type DevelopmentStatus, MAX_UNITS_PER_DEVELOPMENT, type UnitStatus } from '@inmolink/contracts';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit, type OutboxMessage } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { developmentsEvents } from './events';
import { can } from './policy';
import * as repo from './repo';
import { actorId, withDbErrors } from './service';
import { unitChangeRecords } from './units';

export interface FeedUnitInput {
  ref: string;
  propertyTypeId: string;
  priceCents: number | null;
  internalM2: number | null;
  terraceM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  status: UnitStatus;
}

export interface FeedDevelopmentInput {
  /** The feed's reference of the development (unique in the agency). */
  ref: string;
  name: string;
  keyReady: boolean | null;
  locationId: string;
  currency: string;
  /**
   * The development's whole price list. AVAILABLE feed units it no longer names are withdrawn; an empty list, or one
   * dropping more than half of the feed's units, withdraws none.
   */
  units: readonly FeedUnitInput[];
}

export interface FeedDevelopmentsResult {
  developments: { created: number; updated: number; unchanged: number };
  units: { created: number; updated: number; unchanged: number; withdrawn: number };
  /** The developments not stored, by reference, with the error code; the rest of the batch is stored. */
  skipped: Map<string, string>;
  /** Developments stored without withdrawing units: their list dropped more than half of the feed's units. */
  held: Map<string, { dropped: number; feedUnits: number }>;
}

/** A price list may drop at most this share of a development's feed units at once; more looks truncated. */
export const FEED_UNITS_MAX_WITHDRAW_SHARE = 0.5;

const emptyResult = (): FeedDevelopmentsResult => ({
  developments: { created: 0, updated: 0, unchanged: 0 },
  units: { created: 0, updated: 0, unchanged: 0, withdrawn: 0 },
  skipped: new Map(),
  held: new Map(),
});

function addInto(total: FeedDevelopmentsResult, part: FeedDevelopmentsResult): void {
  for (const k of ['created', 'updated', 'unchanged'] as const) total.developments[k] += part.developments[k];
  for (const k of ['created', 'updated', 'unchanged', 'withdrawn'] as const) total.units[k] += part.units[k];
  for (const [ref, code] of part.skipped) total.skipped.set(ref, code);
  for (const [ref, held] of part.held) total.held.set(ref, held);
}

const same = (a: string | number | null, b: number | null) => (a === null ? b === null : b !== null && Number(a) === b);

const unitChanged = (was: repo.UnitListRow, u: FeedUnitInput) =>
  was.priceCents !== u.priceCents ||
  was.status !== u.status ||
  was.bedrooms !== u.bedrooms ||
  was.bathrooms !== u.bathrooms ||
  was.propertyTypeId !== u.propertyTypeId ||
  !same(was.internalM2, u.internalM2) ||
  !same(was.terraceM2, u.terraceM2);

/** The first unit of each reference (a price list naming one twice would break `units_development_ref_uq`). */
function uniqueUnits(units: readonly FeedUnitInput[]): FeedUnitInput[] {
  const seen = new Set<string>();
  return units.filter((u) => !seen.has(u.ref) && seen.add(u.ref));
}

/**
 * Values the database refuses — any data exception (class 22: out of range, too long, malformed) and the integrity
 * checks a development's data can break (not null, foreign key, unique, check): the feed's data, not a fault.
 */
const INTEGRITY_CODES = new Set(['23502', '23503', '23505', '23514']);
const isDataError = (code: string) => code.startsWith('22') || INTEGRITY_CODES.has(code);

/** The error as the AppError a development is skipped with, or the error itself when it is not about the data. */
function feedDataError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code && isDataError(code)
    ? new AppError('VALIDATION_FAILED', { field: 'development', reason: 'invalid' })
    : err;
}

/**
 * Creates or updates the developments of a feed batch and their units, in the caller's transaction (the caller is a
 * member with the right to create and update developments; a development deleted by hand stays deleted). A
 * development that cannot be stored — refused by policy, over the unit limit, or failing in the database — is
 * reported in `skipped` and leaves the others stored.
 */
export async function importFeedDevelopments(
  ctx: Ctx,
  inputs: readonly FeedDevelopmentInput[],
): Promise<FeedDevelopmentsResult> {
  const byRef = new Map<string, FeedDevelopmentInput>();
  for (const input of inputs) if (!byRef.has(input.ref)) byRef.set(input.ref, input);
  const todo = [...byRef.values()];
  const total = emptyResult();
  if (todo.length === 0) return total;
  try {
    addInto(total, await ctx.tx.transaction((sp) => writeBatch({ ...ctx, tx: sp }, todo)));
    return total;
  } catch (err) {
    if (!(feedDataError(err) instanceof AppError)) throw err;
  }
  // The batch write failed (one development's data): each development again, alone in its own savepoint.
  for (const input of todo) {
    try {
      addInto(total, await ctx.tx.transaction((sp) => writeBatch({ ...ctx, tx: sp }, [input])));
    } catch (err) {
      const appError = feedDataError(err);
      if (!(appError instanceof AppError)) throw err;
      total.skipped.set(input.ref, appError.code);
    }
  }
  return total;
}

interface Plan {
  input: FeedDevelopmentInput;
  developmentId: string;
  currency: string;
  fresh: FeedUnitInput[];
  changed: repo.FeedUnitValues[];
  dropped: repo.UnitListRow[];
  unchanged: number;
}

/** One batch: two reads, the diff in memory, then one statement per kind of write. */
async function writeBatch(ctx: Ctx, inputs: readonly FeedDevelopmentInput[]): Promise<FeedDevelopmentsResult> {
  const out = emptyResult();
  if (!can(ctx, 'development.update')) {
    for (const input of inputs) out.skipped.set(input.ref, 'FORBIDDEN');
    return out;
  }
  const canCreate = can(ctx, 'development.create');
  const agencyId = ctx.tenant.agencyId;
  const userId = actorId(ctx);

  const current = new Map(
    (
      await repo.ownByRefsForUpdate(
        ctx.tx,
        agencyId,
        inputs.map((i) => i.ref),
      )
    ).map((d) => [d.ref, d]),
  );
  const live = [...current.values()].filter((d) => !d.deletedAt);
  const unitsOf = new Map<string, repo.UnitListRow[]>(live.map((d) => [d.id, []]));
  for (const u of await repo.unitsOfDevelopments(
    ctx.tx,
    agencyId,
    live.map((d) => d.id),
  )) {
    unitsOf.get(u.developmentId)?.push(u);
  }

  const newDevelopments: repo.FeedDevelopmentInsert[] = [];
  const devChanges: (repo.FeedDevelopmentValues & { changed: string[] })[] = [];
  const plans: Plan[] = [];
  for (const input of inputs) {
    const dev = current.get(input.ref);
    if (dev?.deletedAt) {
      out.developments.unchanged += 1;
      continue;
    }
    if (!dev && !canCreate) {
      out.skipped.set(input.ref, 'FORBIDDEN');
      continue;
    }
    const units = uniqueUnits(input.units);
    const have = new Map((dev ? (unitsOf.get(dev.id) ?? []) : []).map((u) => [u.ref, u]));
    const plan: Plan = {
      input,
      developmentId: dev?.id ?? newId(),
      currency: dev?.currency ?? input.currency,
      fresh: [],
      changed: [],
      dropped: [],
      unchanged: 0,
    };
    for (const u of units) {
      const was = have.get(u.ref);
      if (!was) plan.fresh.push(u);
      else if (unitChanged(was, u)) plan.changed.push({ ...u, id: was.id, developmentId: was.developmentId });
      else plan.unchanged += 1;
    }
    if (units.length > 0) {
      const sent = new Set(units.map((u) => u.ref));
      const feedUnits = [...have.values()].filter((u) => u.fromFeed);
      const dropped = feedUnits.filter((u) => u.status === 'AVAILABLE' && !sent.has(u.ref));
      if (dropped.length > feedUnits.length * FEED_UNITS_MAX_WITHDRAW_SHARE) {
        out.held.set(input.ref, { dropped: dropped.length, feedUnits: feedUnits.length });
      } else {
        plan.dropped = dropped;
      }
    }
    if (have.size - plan.dropped.length + plan.fresh.length > MAX_UNITS_PER_DEVELOPMENT) {
      out.skipped.set(input.ref, 'DEVELOPMENT_UNIT_LIMIT');
      continue;
    }
    plans.push(plan);
    if (!dev) {
      newDevelopments.push({
        id: plan.developmentId,
        ref: input.ref,
        name: input.name,
        status: input.keyReady ? 'KEY_READY' : 'OFF_PLAN',
        locationId: input.locationId,
        currency: input.currency,
      });
      continue;
    }
    // Turning key-ready is the only status a feed moves (never back, never out of SOLD_OUT).
    const status: DevelopmentStatus =
      input.keyReady && dev.status !== 'KEY_READY' && dev.status !== 'SOLD_OUT' ? 'KEY_READY' : dev.status;
    const changed = [
      ...(dev.name !== input.name ? ['name'] : []),
      ...(dev.locationId !== input.locationId ? ['locationId'] : []),
      ...(dev.status !== status ? ['status'] : []),
    ];
    if (changed.length > 0) {
      devChanges.push({ id: dev.id, name: input.name, locationId: input.locationId, status, changed });
    } else {
      out.developments.unchanged += 1;
    }
  }

  const events: OutboxMessage[] = [];
  const created = await withDbErrors(() => repo.insertFeedDevelopments(ctx.tx, agencyId, newDevelopments));
  for (const d of created)
    events.push(developmentsEvents.created({ developmentId: d.id, agencyId, version: d.version }));
  const updated = await withDbErrors(() => repo.setFeedDevelopments(ctx.tx, agencyId, devChanges));
  const changedOf = new Map(devChanges.map((c) => [c.id, c.changed]));
  for (const d of updated) {
    events.push(
      developmentsEvents.updated({
        developmentId: d.id,
        agencyId,
        version: d.version,
        changed: changedOf.get(d.id) ?? [],
      }),
    );
  }
  out.developments.created += created.length;
  out.developments.updated += updated.length;

  const fresh: repo.FeedUnitInsert[] = plans.flatMap((p) =>
    p.fresh.map((u) => ({ ...u, id: newId(), developmentId: p.developmentId, currency: p.currency })),
  );
  out.units.created += await withDbErrors(() => repo.insertFeedUnits(ctx.tx, agencyId, fresh));
  const prices: Parameters<typeof repo.insertPriceListHistories>[1]['prices'][number][] = [];
  const statuses: Parameters<typeof repo.insertPriceListHistories>[1]['statuses'][number][] = [];
  for (const u of fresh) {
    statuses.push({ id: newId(), unitId: u.id, from: null, to: u.status });
    if (u.priceCents !== null) {
      prices.push({ id: newId(), unitId: u.id, from: null, to: u.priceCents, currency: u.currency });
    }
    events.push(developmentsEvents.unitCreated({ unitId: u.id, developmentId: u.developmentId, agencyId, version: 1 }));
  }

  const before = new Map(plans.flatMap((p) => [...(unitsOf.get(p.developmentId) ?? [])].map((u) => [u.id, u])));
  const after = await withDbErrors(() =>
    repo.setFeedUnits(
      ctx.tx,
      agencyId,
      plans.flatMap((p) => p.changed),
    ),
  );
  const records = unitChangeRecords(
    ctx,
    after.flatMap((a) => {
      const b = before.get(a.id);
      return b ? [{ before: b, after: a }] : [];
    }),
  );
  for (const s of records.statuses) {
    statuses.push({ id: s.id, unitId: s.unitId, from: s.fromStatus ?? null, to: s.toStatus });
  }
  for (const p of records.prices) {
    prices.push({
      id: p.id,
      unitId: p.unitId,
      from: p.previousPriceCents ?? null,
      to: p.priceCents ?? null,
      currency: p.currency,
    });
  }
  events.push(...records.events);
  out.units.updated += after.length;

  const dropped = plans.flatMap((p) => p.dropped);
  const withdrawn = new Set(
    await repo.withdrawFeedUnits(
      ctx.tx,
      agencyId,
      [...new Set(dropped.map((u) => u.developmentId))],
      dropped.map((u) => u.id),
    ),
  );
  for (const u of dropped) {
    if (!withdrawn.has(u.id)) continue;
    events.push(developmentsEvents.unitDeleted({ unitId: u.id, developmentId: u.developmentId, agencyId }));
  }
  out.units.withdrawn += withdrawn.size;
  out.units.unchanged += plans.reduce((n, p) => n + p.unchanged, 0);

  await repo.insertPriceListHistories(ctx.tx, {
    agencyId,
    priceListId: null,
    changedByUserId: userId,
    prices,
    statuses,
  });
  await emit(ctx.tx, events);
  return out;
}
