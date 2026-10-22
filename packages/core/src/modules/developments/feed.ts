/**
 * A development a feed lists (S7-F14): created once per reference with its units, later runs change only what the
 * feed changed (a unit's price, status and sizes; a development turning key-ready). Idempotent: a second run with the
 * same input writes nothing, bumps no version and emits no event. The feed never sets a commission, an access list or
 * a name after creation — those stay the owner's — so a feed development is a PRIVATE_NETWORK one shared with nobody.
 */
import { type DevelopmentStatus, MAX_UNITS_PER_BULK, type UnitStatus } from '@inmolink/contracts';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';
import { createDevelopment, updateDevelopment } from './service';
import { createUnits, updateFeedUnits } from './units';

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
  units: readonly FeedUnitInput[];
}

export interface FeedDevelopmentResult {
  development: 'created' | 'updated' | 'unchanged';
  units: { created: number; updated: number; unchanged: number };
}

const same = (a: string | number | null, b: number | null) => (a === null ? b === null : b !== null && Number(a) === b);

/**
 * Creates or updates the development of `input.ref` and its units, in the caller's transaction (the caller is a
 * member with the right to create developments; a development deleted by hand stays deleted).
 */
export async function importFeedDevelopment(ctx: Ctx, input: FeedDevelopmentInput): Promise<FeedDevelopmentResult> {
  assertCan(ctx, 'development.update');
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const status: DevelopmentStatus = input.keyReady ? 'KEY_READY' : 'OFF_PLAN';
  let current = await repo.getOwnByRefForUpdate(ctx.tx, ctx.tenant.agencyId, input.ref);
  let outcome: FeedDevelopmentResult['development'] = 'unchanged';
  if (current?.deletedAt) return { development: 'unchanged', units: counts };
  if (!current) {
    const dto = await createDevelopment(ctx, {
      ref: input.ref,
      name: input.name,
      status,
      locationId: input.locationId,
      currency: input.currency,
    });
    current = await repo.getOwnByRefForUpdate(ctx.tx, ctx.tenant.agencyId, dto.ref);
    outcome = 'created';
  } else if (status === 'KEY_READY' && current.status !== 'KEY_READY' && current.status !== 'SOLD_OUT') {
    await updateDevelopment(ctx, current.id, { version: current.version, status });
    outcome = 'updated';
  }
  if (!current) return { development: outcome, units: counts };

  const have = new Map((await repo.allUnits(ctx.tx, current.id)).map((u) => [u.ref, u]));
  const fresh: FeedUnitInput[] = [];
  const changed: repo.FeedUnitValues[] = [];
  for (const u of input.units) {
    const was = have.get(u.ref);
    if (!was) {
      fresh.push(u);
    } else if (
      was.priceCents !== u.priceCents ||
      was.status !== u.status ||
      was.bedrooms !== u.bedrooms ||
      was.bathrooms !== u.bathrooms ||
      was.propertyTypeId !== u.propertyTypeId ||
      !same(was.internalM2, u.internalM2) ||
      !same(was.terraceM2, u.terraceM2)
    ) {
      changed.push({
        id: was.id,
        propertyTypeId: u.propertyTypeId,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        internalM2: u.internalM2,
        terraceM2: u.terraceM2,
        priceCents: u.priceCents,
        status: u.status,
      });
    } else {
      counts.unchanged += 1;
    }
  }
  counts.updated += await updateFeedUnits(ctx, current.id, changed);
  for (let i = 0; i < fresh.length; i += MAX_UNITS_PER_BULK) {
    const chunk = fresh.slice(i, i + MAX_UNITS_PER_BULK);
    await createUnits(ctx, current.id, { units: chunk });
    counts.created += chunk.length;
  }
  return { development: outcome, units: counts };
}
