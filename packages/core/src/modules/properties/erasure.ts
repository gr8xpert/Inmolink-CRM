import { type Tx, withSystem } from '@inmolink/db';
import { properties } from '@inmolink/db/schema/properties';
import { emit } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { propertiesEvents } from './events';

/**
 * Agency erasure, the listings side (S16-F5, the full tenant purge after an `ERASE_AGENCY`): every listing of the
 * erased agency leaves for good, in two bounded steps the compliance worker drives —
 *
 * 1. `retireAgencyListings`: a batch of the agency's live listings is soft-deleted (`deleted_at = now()`), with one
 *    `properties.listing.deleted` per listing in one `emit` statement — the network, websites, read models and the
 *    search index drop them as for any delete (the subscribers do it after the commit).
 * 2. `agencyListingsForPurge` (media's `purgeAgencyListings`, which reads its own media rows first): the agency's
 *    soft-deleted listings, locked, whatever their restore window — an erased agency restores nothing; then
 *    `purgeListings` deletes them (children cascade) with one `properties.listing.purged` each.
 *
 * Worker-only (`withSystem`, the agency an explicit predicate). Idempotent: a rerun finds nothing left.
 */

/** Listings soft-deleted per statement. */
const RETIRE_BATCH = 500;

export async function retireAgencyListings(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('properties.retireAgencyListings', async (tx) => {
    const res = await tx.execute(sql`
      update ${properties} l set deleted_at = now(), version = l.version + 1, updated_at = now()
        from (select id from ${properties} where agency_id = ${p.agencyId} and deleted_at is null
               order by id limit ${RETIRE_BATCH} for update skip locked) b
       where l.agency_id = ${p.agencyId} and l.id = b.id
      returning l.id, l.version`);
    const rows = res.rows as { id: string; version: number }[];
    await emit(
      tx,
      rows.map((l) => propertiesEvents.deleted({ listingId: l.id, agencyId: p.agencyId, version: l.version })),
      { agencyId: p.agencyId },
    );
    // S16-F5 review: `skip locked` may leave a listing another transaction holds — the phase goes on while any live one
    // is left (a later call retires it), never on a short batch alone
    const left = await tx.execute(
      sql`select exists (select 1 from ${properties} where agency_id = ${p.agencyId} and deleted_at is null) as left`,
    );
    return { rows: rows.length, more: Boolean((left.rows[0] as { left: boolean } | undefined)?.left) };
  });
}

/**
 * S16-F5 review: whether a soft-deleted listing of the agency is still there (a batch's worth more, or one another
 * transaction holds) — the purge's "done" check. Live ones are the retire step's (it ends only when none is left).
 */
export async function agencyHasDeletedListings(tx: Tx, agencyId: string): Promise<boolean> {
  const res = await tx.execute(
    sql`select exists (select 1 from ${properties} where agency_id = ${agencyId} and deleted_at is not null) as any`,
  );
  return Boolean((res.rows[0] as { any: boolean } | undefined)?.any);
}

/** Up to `limit` soft-deleted listings of the agency, locked in `tx` for the purge (worker `tx`, `app_system`). */
export async function agencyListingsForPurge(tx: Tx, agencyId: string, limit: number): Promise<string[]> {
  const res = await tx.execute(sql`
    select id from ${properties} where agency_id = ${agencyId} and deleted_at is not null
     order by id limit ${limit} for update skip locked`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}
