import { type Tx, withSystem } from '@inmolink/db';
import {
  clientRegistrationFingerprints,
  clientRegistrationReceipts,
  clientRegistrations,
  viewingRequestReceipts,
  viewingRequests,
} from '@inmolink/db/schema/mls';
import { clock } from '@inmolink/platform/clock';
import { type AnyColumn, and, asc, eq, sql } from 'drizzle-orm';
import { registrationClaimDays } from './config';

/**
 * GDPR, the mls side (S16-F5): what a data subject export reads about the person, and the retention of the evidence.
 *
 * - `subjectRegistrations` / `subjectViewings`: the agency's client registrations and viewing requests of the contact,
 *   a page at a time — ids, the target, the validity, the viewing's status and times. Never the terms (commission,
 *   split: the agencies' business, not the person's data) nor the registered snapshot's ciphertext.
 * - `pruneExpiredRegistrations` (`mls.pruneRegistrations`, daily): a registration is kept as introduction evidence
 *   (PLAN §3 #8, GDPR Art. 17(3)(e)) for its validity plus the claim period (`registrationClaimDays`, default five
 *   years); then it goes with everything that proves it — its viewing requests (their terms end with the registration)
 *   and both sides' receipts, its fingerprints. A registration with a viewing still open is kept. Worker-only
 *   (`app_system`: no request deletes evidence), batches of `PRUNE_BATCH`, one statement each.
 */

const SUBJECT_PAGE = 1_000;
const PRUNE_BATCH = 500;
const PRUNE_MAX_BATCHES = 40;
const DAY_MS = 86_400_000;

export interface MlsSubjectPage {
  after: { at: Date; id: string } | null;
}

const after = (at: AnyColumn, id: AnyColumn, q: MlsSubjectPage) =>
  q.after ? sql`(${at}, ${id}) > (${q.after.at.toISOString()}::timestamptz, ${q.after.id}::uuid)` : undefined;

/** A page of the contact's client registrations (the introducer's, `client_registrations_contact_idx`), oldest first. */
export function subjectRegistrations(tx: Tx, agencyId: string, contactId: string, q: MlsSubjectPage) {
  return tx
    .select({
      id: clientRegistrations.id,
      targetKind: clientRegistrations.targetKind,
      targetId: clientRegistrations.targetId,
      registeredAt: clientRegistrations.registeredAt,
      registeredMs: clientRegistrations.registeredMs,
      expiresAt: clientRegistrations.expiresAt,
    })
    .from(clientRegistrations)
    .where(
      and(
        eq(clientRegistrations.agencyId, agencyId),
        eq(clientRegistrations.contactId, contactId),
        after(clientRegistrations.registeredMs, clientRegistrations.id, q),
      ),
    )
    .orderBy(asc(clientRegistrations.registeredMs), asc(clientRegistrations.id))
    .limit(SUBJECT_PAGE);
}

/** A page of the contact's viewing requests (the introducer's, `viewing_requests_contact_idx`), oldest first. */
export function subjectViewings(tx: Tx, agencyId: string, contactId: string, q: MlsSubjectPage) {
  return tx
    .select({
      id: viewingRequests.id,
      targetKind: viewingRequests.targetKind,
      targetId: viewingRequests.targetId,
      status: viewingRequests.status,
      proposedStartAt: viewingRequests.proposedStartAt,
      scheduledAt: viewingRequests.scheduledAt,
      outcome: viewingRequests.outcome,
      createdAt: viewingRequests.createdAt,
      createdMs: viewingRequests.createdMs,
    })
    .from(viewingRequests)
    .where(
      and(
        eq(viewingRequests.agencyId, agencyId),
        eq(viewingRequests.contactId, contactId),
        after(viewingRequests.createdMs, viewingRequests.id, q),
      ),
    )
    .orderBy(asc(viewingRequests.createdMs), asc(viewingRequests.id))
    .limit(SUBJECT_PAGE);
}

/**
 * One batch of registrations whose validity ended more than the claim period before `now`, deleted with their viewing
 * requests, both sides' receipts and their fingerprints in one statement (`client_registrations_expires_idx`). The FKs
 * (viewing request → registration, fingerprint → registration) are checked at the statement's end, when all are gone.
 */
async function pruneBatch(tx: Tx, cutoff: Date, limit: number): Promise<{ registrations: number; viewings: number }> {
  const res = await tx.execute(sql`
    with r as (
        select id, agency_id from ${clientRegistrations} cr
         where cr.expires_at < ${cutoff.toISOString()}::timestamptz
           and not exists (select 1 from ${viewingRequests} o
                            where o.registration_id = cr.id and o.status in ('REQUESTED', 'SCHEDULED'))
         order by cr.expires_at, cr.id limit ${limit}
         for update skip locked),
      v as (select v.id from ${viewingRequests} v join r on v.registration_id = r.id),
      vr as (delete from ${viewingRequestReceipts} x using v where x.request_id = v.id returning 1),
      vd as (delete from ${viewingRequests} x using v where x.id = v.id returning 1),
      rr as (delete from ${clientRegistrationReceipts} x using r where x.registration_id = r.id returning 1),
      f as (delete from ${clientRegistrationFingerprints} x using r
             where x.agency_id = r.agency_id and x.registration_id = r.id returning 1),
      d as (delete from ${clientRegistrations} x using r where x.id = r.id returning 1)
    select (select count(*) from d)::int as registrations, (select count(*) from vd)::int as viewings,
      (select count(*) from vr)::int as receipts, (select count(*) from rr)::int as reg_receipts,
      (select count(*) from f)::int as fingerprints`);
  const row = res.rows[0] as { registrations: number; viewings: number } | undefined;
  return { registrations: row?.registrations ?? 0, viewings: row?.viewings ?? 0 };
}

/** The daily retention sweep: registrations (and their viewing requests) past validity + claim period. */
export async function pruneExpiredRegistrations(
  opts: { now?: Date; signal?: AbortSignal } = {},
): Promise<{ registrations: number; viewings: number }> {
  const now = opts.now ?? clock.now();
  const cutoff = new Date(now.getTime() - registrationClaimDays() * DAY_MS);
  let registrations = 0;
  let viewings = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES && !opts.signal?.aborted; i++) {
    const n = await withSystem('mls.pruneRegistrations: registrations past validity and claim period', (tx) =>
      pruneBatch(tx, cutoff, PRUNE_BATCH),
    );
    registrations += n.registrations;
    viewings += n.viewings;
    if (n.registrations < PRUNE_BATCH) break;
  }
  return { registrations, viewings };
}
