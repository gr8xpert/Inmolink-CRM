/**
 * Inbound website lead queries (S7-05, PATTERNS §5). Intake runs as `app_intake` under `withIntake` (feed-api: insert,
 * and read back the idempotency columns only — the role cannot read the rest); the acknowledgement jobs and the
 * replay-window prune run as `app_system`. Queries only `@inmolink/db/schema/websites`.
 */
import type { Tx } from '@inmolink/db';
import { websiteLeads } from '@inmolink/db/schema/websites';
import { emitFrom, type OutboxMessage } from '@inmolink/platform/outbox';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

export type LeadKind = (typeof websiteLeads.$inferSelect)['kind'];
export type LeadVerification = (typeof websiteLeads.$inferSelect)['verification'];

export type NewLeadRow = typeof websiteLeads.$inferInsert & {
  id: string;
  agencyId: string;
  /** Null: a portal lead (S15-02; `agency_id` is the listing owner). */
  siteId: string | null;
  idempotencyHash: string;
};

/** What intake may read back: the idempotency columns (`app_intake`'s column grant). */
export interface LeadReceipt {
  id: string;
  kind: LeadKind;
  requestHash: string;
}

/**
 * Inserts the lead and its event in **one** statement (a writable CTE: the event is written only when the row was),
 * unless the site already has a lead with this idempotency key (`website_leads_idempotency_uq`; a portal lead, S15-02:
 * `website_leads_portal_idempotency_uq`). Returns the new row's receipt, or null when the key was taken
 * (a replay, or a concurrent duplicate).
 */
export async function insertLeadWithEvent(tx: Tx, row: NewLeadRow, event: OutboxMessage): Promise<LeadReceipt | null> {
  const insert = tx
    .insert(websiteLeads)
    .values(row)
    .onConflictDoNothing(
      row.siteId === null
        ? {
            target: [websiteLeads.idempotencyHash],
            where: sql`${websiteLeads.siteId} is null and ${websiteLeads.idempotencyHash} is not null`,
          }
        : {
            target: [websiteLeads.siteId, websiteLeads.idempotencyHash],
            where: sql`${websiteLeads.idempotencyHash} is not null`,
          },
    )
    .returning({ id: websiteLeads.id, kind: websiteLeads.kind, requestHash: websiteLeads.requestHash });
  const res = await tx.execute<{ id: string; kind: LeadKind; request_hash: string }>(sql`
    with ins as (${insert.getSQL()}), ev as (${emitFrom(event, sql`ins`, { agencyId: row.agencyId })})
    select id, kind, request_hash from ins`);
  const r = res.rows[0];
  return r ? { id: r.id, kind: r.kind, requestHash: r.request_hash } : null;
}

/**
 * The lead a site's idempotency key names within the replay window (`since`: the window's start). `siteId` null: the
 * portal's (S15-02) — of the agency the intake transaction is pinned to (RLS; `app_intake` cannot read `agency_id`).
 */
export async function leadByIdempotency(
  tx: Tx,
  siteId: string | null,
  idempotencyHash: string,
  since: Date,
): Promise<LeadReceipt | null> {
  const rows = await tx
    .select({ id: websiteLeads.id, kind: websiteLeads.kind, requestHash: websiteLeads.requestHash })
    .from(websiteLeads)
    .where(
      and(
        siteId === null ? isNull(websiteLeads.siteId) : eq(websiteLeads.siteId, siteId),
        eq(websiteLeads.idempotencyHash, idempotencyHash),
        gt(websiteLeads.createdAt, since),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface LeadRow {
  id: string;
  agencyId: string;
  /** Null: a portal lead (S15-02). */
  siteId: string | null;
  kind: LeadKind;
  targetKind: string | null;
  targetId: string | null;
  /** The target's owner when it is not the presenting agency's (a network listing): the introduced agency (S10-02). */
  ownerAgencyId: string | null;
  shownRef: string | null;
  locale: string;
  name: string;
  email: string;
  emailHash: string;
  keyTier: string;
  phone: string | null;
  message: string | null;
  viewingSlots: unknown;
  marketingConsent: boolean;
  pageUrl: string | null;
  ackSentAt: Date | null;
  ackSkippedReason: string | null;
  agencyNotifiedAt: Date | null;
  createdAt: Date;
}

/**
 * A lead as the acknowledgement and notification jobs (`app_system`) and the CRM promotion (S10-02: the site agency's
 * own `tx`, RLS) read it, by id.
 */
export async function leadById(tx: Tx, id: string): Promise<LeadRow | null> {
  const rows = await tx
    .select({
      id: websiteLeads.id,
      agencyId: websiteLeads.agencyId,
      siteId: websiteLeads.siteId,
      kind: websiteLeads.kind,
      targetKind: websiteLeads.targetKind,
      targetId: websiteLeads.targetId,
      ownerAgencyId: websiteLeads.ownerAgencyId,
      shownRef: websiteLeads.shownRef,
      locale: websiteLeads.locale,
      name: websiteLeads.name,
      email: websiteLeads.email,
      emailHash: websiteLeads.emailHash,
      keyTier: websiteLeads.keyTier,
      phone: websiteLeads.phone,
      message: websiteLeads.message,
      viewingSlots: websiteLeads.viewingSlots,
      marketingConsent: websiteLeads.marketingConsent,
      pageUrl: websiteLeads.pageUrl,
      ackSentAt: websiteLeads.ackSentAt,
      ackSkippedReason: websiteLeads.ackSkippedReason,
      agencyNotifiedAt: websiteLeads.agencyNotifiedAt,
      createdAt: websiteLeads.createdAt,
    })
    .from(websiteLeads)
    .where(eq(websiteLeads.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Records that the visitor's acknowledgement (`ack`) or the agency's notification (`agency`) went out. */
export async function markLeadSent(tx: Tx, id: string, what: 'ack' | 'agency', at: Date): Promise<void> {
  await tx
    .update(websiteLeads)
    .set(what === 'ack' ? { ackSentAt: at, updatedAt: at } : { agencyNotifiedAt: at, updatedAt: at })
    .where(eq(websiteLeads.id, id));
}

/** Records that no acknowledgement goes out, and why (a daily cap). */
export async function markAckSkipped(tx: Tx, id: string, reason: AckSkipReason, at: Date): Promise<void> {
  await tx.update(websiteLeads).set({ ackSkippedReason: reason, updatedAt: at }).where(eq(websiteLeads.id, id));
}

export type AckSkipReason = 'RECIPIENT_SITE_DAILY' | 'RECIPIENT_DAILY' | 'SITE_DAILY';

/**
 * Serializes acknowledgement cap decisions for one recipient and one site until the transaction ends (S7-05 review):
 * transaction-scoped advisory locks, always recipient first, then site, so two deciders never wait on each other in a
 * cycle.
 */
export async function lockAckSlots(tx: Tx, q: { siteId: string; emailHash: string }): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`lead-ack-recipient:${q.emailHash}`}, 0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`lead-ack-site:${q.siteId}`}, 0))`);
}

/**
 * Takes the lead's acknowledgement slot (`ack_sent_at` = `at`, so the caps count it at once) unless it is already
 * taken or skipped. Returns whether this call took it.
 */
export async function reserveAck(tx: Tx, id: string, at: Date): Promise<boolean> {
  const res = await tx.execute(sql`
    update ${websiteLeads} set ack_sent_at = ${at}, updated_at = ${at}
     where id = ${id} and ack_sent_at is null and ack_skipped_reason is null`);
  return (res.rowCount ?? 0) === 1;
}

/** Gives a reserved acknowledgement slot back (the send failed; the retry reserves again). */
export async function releaseAck(tx: Tx, id: string, at: Date): Promise<void> {
  await tx.execute(sql`update ${websiteLeads} set ack_sent_at = null where id = ${id} and ack_sent_at = ${at}`);
}

/**
 * Acknowledgements sent since `since`: to this recipient by this site, to this recipient by any site (cross-tenant:
 * `app_system` only), and by this site at all. One statement (`website_leads_recipient_ack_idx`, `…_site_ack_idx`).
 */
export async function ackUsage(
  tx: Tx,
  q: { siteId: string; emailHash: string; since: Date },
): Promise<{ recipientSite: number; recipient: number; site: number }> {
  const res = await tx.execute<{ recipient_site: string; recipient: string; site: string }>(sql`
    select (select count(*) from ${websiteLeads} where email_hash = ${q.emailHash} and ack_sent_at > ${q.since}
               and site_id = ${q.siteId}) as recipient_site,
           (select count(*) from ${websiteLeads} where email_hash = ${q.emailHash} and ack_sent_at > ${q.since}) as recipient,
           (select count(*) from ${websiteLeads} where site_id = ${q.siteId} and ack_sent_at > ${q.since}) as site`);
  const r = res.rows[0];
  return { recipientSite: Number(r?.recipient_site), recipient: Number(r?.recipient), site: Number(r?.site) };
}

/**
 * Clears the idempotency keys of leads created before `before` (the replay window is over), at most `limit` rows per
 * call (`website_leads_idempotency_created_idx`). Returns the rows cleared.
 */
export async function clearIdempotencyKeys(tx: Tx, before: Date, limit: number): Promise<number> {
  const res = await tx.execute(sql`
    update ${websiteLeads} set idempotency_hash = null
     where id in (select id from ${websiteLeads}
                   where idempotency_hash is not null and created_at < ${before}
                   order by created_at limit ${limit}
                   for update skip locked)`);
  return res.rowCount ?? 0;
}

/**
 * A crm contact erasure (S11-F12): the agency's inbound leads `ids` lose the visitor's name, e-mail (and its hash),
 * phone, message, page and replay key. Kept: id, site, kind, target, locale, consent flag, viewing slots (times only)
 * and the send / create times. Only rows not cleared yet are touched (a rerun changes nothing). One statement on the
 * primary key; returns the rows cleared.
 */
export async function eraseLeads(tx: Tx, agencyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(websiteLeads)
    .set({
      name: '',
      email: '',
      emailHash: '',
      phone: null,
      message: null,
      pageUrl: null,
      idempotencyHash: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(websiteLeads.agencyId, agencyId),
        inArray(websiteLeads.id, [...ids]),
        sql`(${websiteLeads.email} <> '' or ${websiteLeads.name} <> '' or ${websiteLeads.phone} is not null
          or ${websiteLeads.message} is not null or ${websiteLeads.pageUrl} is not null)`,
      ),
    )
    .returning({ id: websiteLeads.id });
  return rows.length;
}
