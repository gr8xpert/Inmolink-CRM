/**
 * quality queries (PATTERNS §5). Queries only `@inmolink/db/schema/quality` — other modules' tables fail
 * `pnpm check:boundaries`. The recompute queue (S6-F3) mirrors search's `read_model_queue` (S5-F4): one row per
 * listing, a generation guard, a debounce time, a lease and `SKIP LOCKED` claims. Worker-only (`withSystem`).
 */
import type { Tx } from '@inmolink/db';
import { qualityQueue } from '@inmolink/db/schema/quality';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';

const uuidArray = (ids: readonly string[]) =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

export interface QualityChange {
  listingId: string;
  agencyId: string;
}

/**
 * Queues recomputes of these listings, due `delayMs` from now. A listing already queued gets a new generation (a
 * recompute holding it scores again later), a new due time (debounce) and its photo rechecks reset. One statement for
 * any number; rows in id order (no deadlock between two writers).
 */
export async function queueRecomputes(tx: Tx, changes: readonly QualityChange[], delayMs: number): Promise<void> {
  const unique = [...new Map(changes.map((c) => [c.listingId, c])).values()];
  if (unique.length === 0) return;
  await tx.execute(sql`
    insert into ${qualityQueue} (listing_id, owner_agency_id, due_at)
    select l, a, now() + make_interval(secs => ${delayMs / 1000})
      from unnest(${uuidArray(unique.map((c) => c.listingId))}, ${uuidArray(unique.map((c) => c.agencyId))}) as x(l, a)
     order by 1
    on conflict (listing_id) do update
      set generation = ${qualityQueue}.generation + 1, due_at = excluded.due_at, rechecks = 0,
          owner_agency_id = excluded.owner_agency_id`);
}

export interface QualityClaim {
  token: string;
  rows: { listingId: string; generation: number }[];
}

/**
 * Claims up to `limit` of an agency's due listings, oldest first, that no live recompute holds, for `leaseMs`. Rows a
 * concurrent claim is taking are skipped. `quality_queue_agency_due_idx`.
 */
export async function claimRecomputes(tx: Tx, agencyId: string, limit: number, leaseMs: number): Promise<QualityClaim> {
  const token = newId();
  const res = await tx.execute<{ listing_id: string; generation: number }>(sql`
    update ${qualityQueue} q
       set claimed_until = now() + make_interval(secs => ${leaseMs / 1000}), claim_token = ${token}
      from (select listing_id from ${qualityQueue}
             where owner_agency_id = ${agencyId} and due_at <= now()
               and (claimed_until is null or claimed_until < now())
             order by due_at
             limit ${limit}
               for update skip locked) c
     where q.listing_id = c.listing_id
    returning q.listing_id, q.generation`);
  return { token, rows: res.rows.map((r) => ({ listingId: r.listing_id, generation: r.generation })) };
}

const claimedRows = (claim: QualityClaim, ids?: ReadonlySet<string>) => {
  const rows = ids ? claim.rows.filter((r) => ids.has(r.listingId)) : claim.rows;
  return sql`unnest(${uuidArray(rows.map((r) => r.listingId))}, array[${sql.join(
    rows.map((r) => sql`${r.generation}`),
    sql`, `,
  )}]::int[]) as c(listing_id, generation)`;
};

/**
 * Photos still processing: these claimed listings are scored again `delayMs` later, at most `max` times — unless they
 * changed since the claim (that change's recompute comes first anyway). Must run before `finishRecomputes`.
 */
export async function rescheduleRecomputes(
  tx: Tx,
  claim: QualityClaim,
  ids: readonly string[],
  max: number,
  delayMs: number,
): Promise<number> {
  const pending = new Set(ids);
  if (!claim.rows.some((r) => pending.has(r.listingId))) return 0;
  const res = await tx.execute(sql`
    update ${qualityQueue} q
       set rechecks = q.rechecks + 1, due_at = now() + make_interval(secs => ${delayMs / 1000}),
           claimed_until = null, claim_token = null
      from ${claimedRows(claim, pending)}
     where q.listing_id = c.listing_id and q.generation = c.generation and q.claim_token = ${claim.token}
       and q.rechecks < ${max}`);
  return res.rowCount ?? 0;
}

/**
 * Scored: deletes the claimed rows whose generation is unchanged and frees the others (changed again since the claim:
 * scored again when due). Rows another claim took over are left alone.
 */
export async function finishRecomputes(tx: Tx, claim: QualityClaim): Promise<void> {
  if (claim.rows.length === 0) return;
  await tx.execute(sql`
    delete from ${qualityQueue} q using ${claimedRows(claim)}
     where q.listing_id = c.listing_id and q.generation = c.generation and q.claim_token = ${claim.token}`);
  await releaseRecomputes(tx, claim);
}

/**
 * Not scored (the transaction failed): frees the rows this claim still holds — by primary key (S6-F3 review: the
 * token alone has no index). `deferMs`: they become due only that much later, so a batch that keeps failing (one bad
 * listing) does not block the agency's queue head forever; the job's retries and the sweep move on to newer rows.
 */
export async function releaseRecomputes(tx: Tx, claim: QualityClaim, deferMs = 0): Promise<void> {
  if (claim.rows.length === 0) return;
  const due = deferMs > 0 ? sql`, due_at = now() + make_interval(secs => ${deferMs / 1000})` : sql``;
  await tx.execute(sql`
    update ${qualityQueue} set claimed_until = null, claim_token = null ${due}
     where listing_id = any(${uuidArray(claim.rows.map((r) => r.listingId))}) and claim_token = ${claim.token}`);
}

/** Milliseconds until the agency's next unclaimed listing is due (≤ 0: due now), or null when none is queued. */
export async function nextRecomputeDue(tx: Tx, agencyId: string): Promise<number | null> {
  const res = await tx.execute<{ ms: number | null }>(sql`
    select (extract(epoch from min(due_at) - now()) * 1000)::float8 as ms from ${qualityQueue}
     where owner_agency_id = ${agencyId} and (claimed_until is null or claimed_until < now())`);
  const ms = res.rows[0]?.ms;
  return ms === null || ms === undefined ? null : ms;
}

/** Agencies with listings overdue by more than `overdueMs` and unclaimed (their job was lost): the sweep's work. */
export async function overdueRecomputeAgencies(tx: Tx, overdueMs: number, limit: number): Promise<string[]> {
  const res = await tx.execute<{ owner_agency_id: string }>(sql`
    select distinct owner_agency_id from ${qualityQueue}
     where due_at < now() - make_interval(secs => ${overdueMs / 1000})
       and (claimed_until is null or claimed_until < now())
     limit ${limit}`);
  return res.rows.map((r) => r.owner_agency_id);
}
