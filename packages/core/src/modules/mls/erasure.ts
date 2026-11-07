import { withSystem } from '@inmolink/db';
import { clientRegistrationFingerprints, clientRegistrations } from '@inmolink/db/schema/mls';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { registeredClientCipher } from './config';

/**
 * Erasure, the mls side (S16-04 review). A client registration holds the client's details as registered
 * (`details_enc`, decryptable while the key lives) and keyed fingerprints of their e-mails and phones:
 *
 * - The registration row stays — ids, the target, the contact id, the validity and the target owner's receipt are the
 *   evidence of who introduced the client first (PLAN §3 #8; GDPR Art. 17(3)(e)). Its `details_enc` becomes the
 *   encryption of an empty client (`ERASED_CLIENT`: no name, no e-mail, no phone), so nothing of the person can be
 *   decrypted any more; readers show an unnamed client.
 * - Its fingerprints are deleted: they are personal data (an HMAC of the e-mail / phone, reversible by anyone holding
 *   `HMAC_KEY` and a guess). With them goes the "first valid wins" protection for that client — another agency can
 *   register the same person again; the erased registration still proves the earlier introduction by its dates.
 *
 * `eraseContactRegistrations`: a contact erasure (`mls.eraseContactRegistrations` on `crm.contact.erased`), the erased
 * contacts' registrations. `eraseAgencyRegistrations`: an agency erasure, a batch of the agency's registrations at a
 * time. Viewing requests hold no free text about the client (ids, terms, times) and stay. Worker-only (`app_system`:
 * `details_enc` is not writable by members; the agency is an explicit predicate). Idempotent: an erased registration
 * is rewritten with the same empty client.
 */

export const ERASED_CLIENT = { firstName: null, lastName: null, emails: [], phones: [] } as const;

/** Registrations per transaction. */
const BATCH = 200;

type SystemTx = Parameters<Parameters<typeof withSystem>[1]>[0];

async function eraseRows(tx: SystemTx, agencyId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await tx
    .delete(clientRegistrationFingerprints)
    .where(
      and(
        eq(clientRegistrationFingerprints.agencyId, agencyId),
        inArray(clientRegistrationFingerprints.registrationId, [...ids]),
      ),
    );
  // one statement: each row's own ciphertext (bound to agency, table, column and row)
  const values = ids.map(
    (id) =>
      sql`(${id}::uuid, ${registeredClientCipher.encrypt(agencyId, id, { ...ERASED_CLIENT, emails: [], phones: [] })})`,
  );
  const res = await tx.execute(sql`
    update ${clientRegistrations} r set details_enc = v.enc
      from (values ${sql.join(values, sql`, `)}) as v(id, enc)
     where r.agency_id = ${agencyId} and r.id = v.id
    returning r.id`);
  return res.rows.length;
}

export async function eraseContactRegistrations(p: {
  agencyId: string;
  contactIds: readonly string[];
}): Promise<{ registrations: number }> {
  if (p.contactIds.length === 0) return { registrations: 0 };
  let total = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const n: { erased: number; last: string | null; full: boolean } = await withSystem(
      'mls.eraseContactRegistrations',
      async (tx) => {
        const ids = (
          await tx
            .select({ id: clientRegistrations.id })
            .from(clientRegistrations)
            .where(
              and(
                eq(clientRegistrations.agencyId, p.agencyId),
                inArray(clientRegistrations.contactId, [...p.contactIds]),
                cursor ? gt(clientRegistrations.id, cursor) : undefined,
              ),
            )
            .orderBy(clientRegistrations.id)
            .limit(BATCH)
        ).map((r) => r.id);
        return {
          erased: await eraseRows(tx, p.agencyId, ids),
          last: ids[ids.length - 1] ?? null,
          full: ids.length === BATCH,
        };
      },
    );
    total += n.erased;
    if (!n.full) break;
    after = n.last;
  }
  return { registrations: total };
}

/** One batch of the agency's registrations after `after` (by id); `last` is the next call's `after`, null when done. */
export async function eraseAgencyRegistrations(p: {
  agencyId: string;
  after: string | null;
}): Promise<{ registrations: number; last: string | null }> {
  return withSystem('mls.eraseAgencyRegistrations', async (tx) => {
    const ids = (
      await tx
        .select({ id: clientRegistrations.id })
        .from(clientRegistrations)
        .where(
          and(eq(clientRegistrations.agencyId, p.agencyId), p.after ? gt(clientRegistrations.id, p.after) : undefined),
        )
        .orderBy(clientRegistrations.id)
        .limit(BATCH)
    ).map((r) => r.id);
    const n = await eraseRows(tx, p.agencyId, ids);
    return { registrations: n, last: ids.length === BATCH ? (ids[ids.length - 1] ?? null) : null };
  });
}

/**
 * Agency erasure, the deal-room side (R2-04b review): a batch of the agency's own uploads to deals loses what names
 * people — the uploading member's name and the file name (it may carry a client's, e.g. "Arras - <name>.pdf"; it
 * becomes `<kind>.pdf`) — on both parties' copies. The rows and the PDFs stay: they are the deal's evidence, shared
 * with the other party (STATUS Decisions, R2-04b). Worker-only (`app_system`). `more`: call again. Idempotent.
 */
export async function eraseAgencyDealDocuments(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('mls.eraseAgencyDealDocuments', async (tx) => {
    const res = await tx.execute(sql`
      with b as (
        select dd.id, dd.deal_id from deal_documents dd
         where dd.agency_id = ${p.agencyId} and dd.uploader_agency_id = ${p.agencyId}
           and (dd.uploader_name <> '' or dd.file_name <> lower(dd.kind) || '.pdf')
         order by dd.id limit ${BATCH}),
      c as (
        select b.id, ${p.agencyId}::uuid as agency_id from b
        union all
        select b.id, d.peer_agency_id from b join deals d on d.agency_id = ${p.agencyId} and d.id = b.deal_id)
      update deal_documents dd set uploader_name = '', file_name = lower(dd.kind) || '.pdf'
        from c where dd.agency_id = c.agency_id and dd.id = c.id
      returning dd.agency_id = ${p.agencyId}::uuid as own`);
    const own = res.rows.filter((r) => (r as { own: boolean }).own).length;
    return { rows: res.rows.length, more: own === BATCH };
  });
}

/** What an erased agency's dispute texts become (the checks need 1–2,000 characters). */
export const ERASED_DISPUTE_TEXT = '[erased]';

/**
 * Agency erasure, the disputes side (R2-04c security review): a batch of the agency's own disputes of deals loses its
 * free text — the reason a member wrote and staff's note (either may name the client). The rows stay (status, times:
 * the mediation's record). Worker-only (`app_system`). `more`: call again. Idempotent.
 */
export async function eraseAgencyDealDisputes(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('mls.eraseAgencyDealDisputes', async (tx) => {
    const res = await tx.execute(sql`
      with b as (
        select id from deal_disputes
         where agency_id = ${p.agencyId}
           and (reason <> ${ERASED_DISPUTE_TEXT} or coalesce(resolution_note, ${ERASED_DISPUTE_TEXT}) <> ${ERASED_DISPUTE_TEXT})
         order by id limit ${BATCH})
      update deal_disputes dd
         set reason = ${ERASED_DISPUTE_TEXT},
             resolution_note = case when dd.resolution_note is null then null else ${ERASED_DISPUTE_TEXT} end,
             updated_at = now()
        from b where dd.agency_id = ${p.agencyId} and dd.id = b.id
      returning dd.id`);
    return { rows: res.rows.length, more: res.rows.length === BATCH };
  });
}
