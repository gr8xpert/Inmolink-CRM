import { AppError, type EraseContactBody } from '@inmolink/contracts';
import { type Tx, withTenant } from '@inmolink/db';
import { emit } from '@inmolink/platform/outbox';
import { storage } from '@inmolink/platform/storage';
import type { Ctx } from '../../context';
import * as compliance from '../compliance';
import * as notifications from '../notifications';
import * as properties from '../properties';
import * as websites from '../websites';
import * as activitiesRepo from './activities-repo';
import { crmEvents } from './events';
import { IMPORT_FINISHED_GRACE_MS, IMPORT_UPLOAD_TTL_MS, sweepContactImports } from './import';
import { assertCan } from './policy';
import * as repo from './repo';

/**
 * Contact erasure (S11-F12, a data subject's "right to be forgotten", GDPR Art. 17; the full flow with search and
 * read-model scans is S16's). The contact becomes a tombstone and every free text the agency holds about it goes:
 *
 * - **In the request's transaction** (`repo.eraseContact`, one statement): names, primary e-mail / phone, language and
 *   tags cleared, consents off, do-not-contact on, the row closed (`deleted_at`; `merged_into_id` stays null — that is
 *   how readers tell an erased contact from a merged one); its e-mails, phones, facets and notes deleted; its leads'
 *   message, visitor details and replay hashes, its tasks' titles (`repo.ERASED_TITLE`) and descriptions, its seller
 *   prospects' titles, confidential notes and seller link cleared; calendar events it attends get a new version (the
 *   ICS feed's fingerprint changes), and those where no other contact attends lose title, description and location.
 *   Closed contacts merged into it earlier lose their names too.
 * - **After the commit** (`crm.contact.erased` → `crm.eraseContactData`): its activity bodies (its own and its leads',
 *   batches of 1,000); the inbound website leads its leads came from (`websites.eraseInboundLeads`, batches of 500);
 *   `property_privates.seller_contact_id` of it and of the contacts merged into it (`properties.clearSellerContact`;
 *   no cross-module FK). Then `crm.contact.erasureCompleted` is audited with the counts.
 *
 * **Kept** (no personal data): every id and timestamp — the tombstone (id, agency, types, source, owner, consent
 * times, created / deleted times), leads (stage, source, target, response KPI times), activities (type, time, subjects,
 * actor, `data`), tasks (due, status), calendar events with other contacts (their own title), attendances (an attendee
 * without a name is left out of feeds), prospects (address, stage, price — the property's), website leads (site, kind,
 * target, locale, slots, times) and the audit rows.
 *
 * Also kept, outside crm: mls client registrations (`details_enc`, the encrypted client snapshot) and viewing requests
 * that name the contact — the evidence of who introduced the client first (PLAN §3 #8), kept for the establishment or
 * defence of legal claims (GDPR Art. 17(3)(e)). S16's retention job deletes them after the registration's validity
 * plus the claim period. The target agency's receipts and its viewing-request copies are its own controller data.
 * Chat messages (S11-03) are the participants' correspondence: out of scope.
 *
 * After erasure no activity can be logged on the contact or its leads (`logActivity` checks the lead's contact is
 * open); the leads stay in the pipeline (ids and stages kept for the reports).
 *
 * Agency admins only (`crm.contacts.erase`), never impersonating staff; `confirm: 'ERASE'`. Audited
 * (`crm.contact.erased`, ids only).
 */
export async function eraseContact(ctx: Ctx, contactId: string, input: EraseContactBody): Promise<void> {
  assertCan(ctx, 'crm.contacts.erase');
  const [contact] = await repo.lockAndLoad(ctx.tx, [contactId]);
  if (!contact) throw new AppError('CONTACT_NOT_FOUND');
  assertCan(ctx, 'crm.contacts.erase', contact);
  if (contact.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const agencyId = ctx.tenant.agencyId;
  await repo.eraseContact(ctx.tx, agencyId, contactId);
  await compliance.audit(ctx, 'crm.contact.erased', { type: 'contact', id: contactId });
  await emit(ctx.tx, crmEvents.contactErased({ agencyId, contactId }));
}

/** Activity rows per statement when an erased contact's bodies are cleared. */
const ERASE_BATCH = 1_000;
/** Inbound website leads per call when an erased contact's are cleared. */
const INBOUND_BATCH = 500;

export interface ErasureCounts {
  activities: number;
  inboundLeads: number;
  listings: number;
}

/**
 * `crm.eraseContactData` (after `crm.contact.erased`): the erased contact's (and its leads') activity bodies, in batches
 * of 1,000, a transaction each; the inbound website leads its leads came from, 500 at a time; then the listings that
 * named it (or a contact merged into it) as seller name none; last, `crm.contact.erasureCompleted` is audited with the
 * counts. Idempotent: a rerun finds nothing left (its audit row says 0, 0, 0). Under the agency's RLS: another agency's
 * id finds nothing. S16-04: also expires the contact's data subject exports and deletes their files.
 */
export async function eraseContactData(p: {
  agencyId: string;
  contactId: string;
  /**
   * S16-04 review: part of an agency erasure, which expires every export and deletes every contact import file of the
   * agency once at its end — skip those agency-wide steps here.
   */
  agencyErasure?: boolean;
}): Promise<ErasureCounts> {
  return eraseContactsData({ agencyId: p.agencyId, contactIds: [p.contactId], agencyErasure: p.agencyErasure });
}

/**
 * S16-F5: `eraseContactData` for a batch of erased contacts (an agency erasure's `SYSTEM_ERASE_BATCH`) — every step
 * one statement per table batch for the whole set, never one per contact: activity bodies (1,000 per statement), the
 * inbound website leads (500 per call), the listings' seller link (one statement, its `properties.listing.updated`
 * events one more), the members' notifications, and one `crm.contact.erasureCompleted` row per contact in one insert
 * (`auditSystemMany`, each with the batch's totals and its size). Same idempotence and RLS as `eraseContactData`.
 */
export async function eraseContactsData(p: {
  agencyId: string;
  contactIds: readonly string[];
  agencyErasure?: boolean;
}): Promise<ErasureCounts> {
  if (p.contactIds.length === 0) return { activities: 0, inboundLeads: 0, listings: 0 };
  const tenant = { agencyId: p.agencyId };
  const contactIds = [...p.contactIds];
  let activities = 0;
  for (;;) {
    const n = await withTenant(tenant, (tx) =>
      activitiesRepo.clearContactBodies(tx, p.agencyId, contactIds, ERASE_BATCH),
    );
    activities += n;
    if (n < ERASE_BATCH) break;
  }
  let inboundLeads = 0;
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const ids: string[] = await withTenant(tenant, (tx) =>
      repo.inboundLeadsOf(tx, p.agencyId, contactIds, cursor, INBOUND_BATCH),
    );
    inboundLeads += (await websites.eraseInboundLeads({ agencyId: p.agencyId, ids })).rows;
    if (ids.length < INBOUND_BATCH) break;
    after = ids[ids.length - 1] ?? null;
  }
  const merged = await withTenant(tenant, (tx) => repo.mergedIntoAny(tx, p.agencyId, contactIds));
  const erasedIds = [...contactIds, ...merged];
  const { rows: listings } = await properties.clearSellerContact({ agencyId: p.agencyId, contactIds: erasedIds });
  // S16-04 review: members' notifications naming the person (a lead's contact name, a task's title) lose their params
  const targets = await withTenant(tenant, (tx) => repo.noticeTargetsOf(tx, p.agencyId, erasedIds));
  await notifications.redactNotifications({
    agencyId: p.agencyId,
    links: targets.leadIds.map((id) => `/inbox/${id}`),
    sourceKeyPrefixes: targets.taskIds.map((id) => `crm.task:${id}:`),
  });
  if (!p.agencyErasure) {
    // S16-04: the exports that may hold the person — their data subject exports and the agency's contact / lead /
    // account exports — expire, their files deleted; and the agency's contact import files (any may list the person)
    await compliance.expireErasedExports({ agencyId: p.agencyId, scope: { subjectContactIds: erasedIds } });
    await purgeContactImportFiles({ agencyId: p.agencyId });
  }
  const counts = { activities, inboundLeads, listings };
  const metadata = contactIds.length === 1 ? { ...counts } : { ...counts, batch: contactIds.length };
  await withTenant(tenant, (tx) =>
    compliance.auditSystemMany(
      tx,
      contactIds.map((id) => ({
        type: 'crm.contact.erasureCompleted' as const,
        agencyId: p.agencyId,
        target: { type: 'contact', id },
        metadata,
      })),
    ),
  );
  return counts;
}

/** Contacts erased per transaction by the system paths (retention, agency erasure). */
export const SYSTEM_ERASE_BATCH = 100;

/**
 * S16-04: erases contacts without a member — the retention job (`RETENTION`, audited `crm.contact.anonymized` with the
 * period) and the agency erasure (`AGENCY`, audited `crm.contact.erased`). The same erasure as `eraseContact`, actor
 * `system`, in one transaction under the agency's RLS for at most `SYSTEM_ERASE_BATCH` contacts; each emits
 * `crm.contact.erased`, so `crm.eraseContactData` clears the rest after the commit. A contact closed meanwhile
 * (merged, erased) is skipped. Answers how many were erased.
 *
 * S16-F5, set-based: one statement locks the batch, one erases all of it (`repo.eraseContacts`, the merged ones
 * following), one inserts every audit row (`auditSystemMany`) and one every event (`emit` of the batch) — four
 * statements whatever the batch's size.
 */
export async function eraseContactsBySystem(p: {
  agencyId: string;
  contactIds: readonly string[];
  why: { kind: 'RETENTION'; months: number } | { kind: 'AGENCY' };
}): Promise<number> {
  const ids = p.contactIds.slice(0, SYSTEM_ERASE_BATCH);
  if (ids.length === 0) return 0;
  return withTenant({ agencyId: p.agencyId }, async (tx) => {
    const open = (await repo.lockAndLoad(tx, ids)).map((c) => c.id); // open contacts only, locked
    if (open.length === 0) return 0;
    await repo.eraseContacts(tx, p.agencyId, open);
    const retention = p.why.kind === 'RETENTION';
    const metadata: compliance.AuditMetadata =
      p.why.kind === 'RETENTION' ? { months: p.why.months } : { reason: 'agencyErasure' };
    await compliance.auditSystemMany(
      tx,
      open.map((id) => ({
        type: retention ? ('crm.contact.anonymized' as const) : ('crm.contact.erased' as const),
        agencyId: p.agencyId,
        target: { type: 'contact', id },
        metadata,
      })),
    );
    await emit(
      tx,
      open.map((contactId) => crmEvents.contactErased({ agencyId: p.agencyId, contactId })),
    );
    return open.length;
  });
}

/**
 * S16-04, `crm.anonymizeInactiveContacts` for one agency: contacts untouched for `months` (no change, lead, task or
 * activity — its leads' included — since the cutoff, no open lead, not the seller of a listing on the market) are erased, `SYSTEM_ERASE_BATCH` per transaction, at most `maxContacts` per run (the next
 * daily run continues). Answers how many were erased.
 */
export async function anonymizeInactiveContacts(p: {
  agencyId: string;
  months: number;
  now: Date;
  maxContacts: number;
  signal?: AbortSignal;
}): Promise<number> {
  const cutoff = new Date(p.now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - p.months);
  let erased = 0;
  let after: string | null = null;
  while (erased < p.maxContacts && !p.signal?.aborted) {
    const cursor: string | null = after;
    const limit = Math.min(SYSTEM_ERASE_BATCH, p.maxContacts - erased);
    const ids: string[] = await withTenant({ agencyId: p.agencyId }, (tx) =>
      repo.inactiveContactIds(tx, p.agencyId, cutoff, cursor, limit),
    );
    if (ids.length === 0) break;
    // S16-04 review: the seller of a listing still on the market is not inactive
    const sellers = await properties.activeSellerContacts({ agencyId: p.agencyId, contactIds: ids });
    erased += await eraseContactsBySystem({
      agencyId: p.agencyId,
      contactIds: ids.filter((id) => !sellers.has(id)),
      why: { kind: 'RETENTION', months: p.months },
    });
    if (ids.length < limit) break;
    after = ids[ids.length - 1] ?? null;
  }
  return erased;
}

/**
 * S16-04, agency erasure: one batch of the agency's open contacts erased (`SYSTEM_ERASE_BATCH`). `more`: call again.
 */
export async function eraseAgencyContacts(p: {
  agencyId: string;
}): Promise<{ erased: number; contactIds: string[]; more: boolean }> {
  const ids = await withTenant({ agencyId: p.agencyId }, (tx) =>
    repo.openContactIds(tx, p.agencyId, SYSTEM_ERASE_BATCH),
  );
  const erased = await eraseContactsBySystem({ agencyId: p.agencyId, contactIds: ids, why: { kind: 'AGENCY' } });
  return { erased, contactIds: ids, more: ids.length === SYSTEM_ERASE_BATCH };
}

/**
 * S16-04 review: the erased contacts and the closed contacts merged into them (their data went with them). S16-F5:
 * any number of contacts, one query.
 */
export async function erasedContactIds(p: { agencyId: string; contactIds: readonly string[] }): Promise<string[]> {
  const merged = await withTenant({ agencyId: p.agencyId }, (tx) => repo.mergedIntoAny(tx, p.agencyId, p.contactIds));
  return [...p.contactIds, ...merged];
}

/**
 * S16-04 review: every contact import file of the agency still in storage is deleted — uploads not started expire,
 * finished ones lose their file now rather than after the grace hour (any CSV may list an erased person). Running
 * imports keep theirs until they end (they delete it then). The daily sweep, scoped to the agency and to "now".
 */
export async function purgeContactImportFiles(p: { agencyId: string }): Promise<{ files: number }> {
  const now = new Date(Date.now() + IMPORT_UPLOAD_TTL_MS + IMPORT_FINISHED_GRACE_MS + 60_000);
  const { filesDeleted } = await sweepContactImports({ now, agencyIds: [p.agencyId] });
  return { files: filesDeleted };
}

/** Objects listed per page of an agency's contact import prefix. */
const IMPORT_PREFIX_PAGE = 500;

/**
 * S16-04 review, agency erasure: the agency's contact import files — the sweep's way (rows marked), then whatever is
 * still under `crm/contact-imports/<agency>/` (a file whose row is gone), one listed page at a time. `more`: call again.
 */
export async function purgeAgencyContactImports(p: {
  agencyId: string;
  signal?: AbortSignal;
}): Promise<{ files: number; more: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(p.agencyId)) throw new Error('purgeAgencyContactImports: not an agency id');
  const { files } = await purgeContactImportFiles({ agencyId: p.agencyId });
  const prefix = `crm/contact-imports/${p.agencyId.toLowerCase()}/`;
  const listed = await storage().list('private', prefix, { limit: IMPORT_PREFIX_PAGE });
  for (const o of listed.objects) {
    if (p.signal?.aborted) return { files, more: true };
    await storage().delete('private', o.key);
  }
  return { files: files + listed.objects.length, more: Boolean(listed.next) };
}

/** Rows per statement of the agency-wide text sweep. */
const AGENCY_TEXT_BATCH = 1_000;

/**
 * S16-04 review, agency erasure: one batch of the free text crm holds outside contact rows — tasks, calendar events,
 * seller prospects and activities with or without a contact (their titles `—`, descriptions, locations, confidential
 * notes and bodies cleared), leads' messages and visitor details, and contact notes. `more`: call again.
 */
export async function eraseAgencyCrmText(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  const rows = await withTenant({ agencyId: p.agencyId }, (tx) =>
    repo.clearAgencyText(tx, p.agencyId, AGENCY_TEXT_BATCH),
  );
  return { rows, more: rows > 0 };
}

/** S16-04: whether `contactId` is an open contact of the agency (`SUBJECT` exports; under the caller's RLS). */
export const openContactExists = (tx: Tx, agencyId: string, contactId: string) =>
  repo.openContactExists(tx, agencyId, contactId);
