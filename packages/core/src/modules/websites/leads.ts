/**
 * Inbound website leads (S7-05, PLAN §3 #12 #60, §9.1): the record of a visitor's enquiry or viewing request, owned by
 * the site's agency — the presenting agency, also when the listing is another agency's network listing (whose owner
 * never reads it: STRICT row, `owner_agency_id` only names the introducer relation for S10-02, which promotes inbound
 * leads to CRM leads).
 *
 * Intake (feed-api, `website-api.submitLead`) calls `recordInboundLead` in a `withIntake` transaction pinned to the
 * site's agency: the row and its `websites.lead.received` event commit together (the acknowledgement and the agency's
 * notification follow in worker jobs). A repeated submission with the same idempotency key on the same site returns
 * the first lead's receipt and creates nothing; keys are kept `LEAD_IDEMPOTENCY_HOURS` (`pruneLeadIdempotency`).
 */
import type { Tx } from '@inmolink/db';
import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { websitesEvents } from './events';
import * as repo from './leads-repo';

export type { AckSkipReason, LeadKind, LeadReceipt, LeadRow, LeadVerification } from './leads-repo';

/** How long a site's idempotency key names its lead (api rules: replay for 24 h). */
export const LEAD_IDEMPOTENCY_HOURS = 24;
/** Keys cleared per statement by the prune, and statements per run. */
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 20;

export interface InboundLead {
  id: string;
  /** The presenting agency: the site's. */
  agencyId: string;
  siteId: string;
  kind: repo.LeadKind;
  idempotencyHash: string;
  requestHash: string;
  verification: repo.LeadVerification;
  /** The listing or unit asked about, as the site showed it; `ownerAgencyId` null when it is the site agency's own. */
  target: { kind: 'LISTING' | 'UNIT'; id: string; ownerAgencyId: string | null; shownRef: string } | null;
  locale: string;
  name: string;
  email: string;
  /** HMAC of the normalized e-mail (acknowledgement limits). */
  emailHash: string;
  /** The posting key's rate tier (the site's daily acknowledgement cap). */
  keyTier: 'STANDARD' | 'HIGH';
  phone: string | null;
  message: string | null;
  viewingSlots: unknown[] | null;
  marketingConsent: boolean;
  pageUrl: string | null;
}

/**
 * Records an inbound lead with its `websites.lead.received` event in the caller's intake transaction — one statement
 * — or, when the site already has a lead for this idempotency key, returns that lead's receipt (`created: false`) and
 * writes nothing (one more statement); null receipt: the key is taken by a lead older than the replay window that the
 * hourly prune has not cleared yet.
 */
export async function recordInboundLead(
  tx: Tx,
  lead: InboundLead,
): Promise<{ receipt: repo.LeadReceipt | null; created: boolean }> {
  const event = websitesEvents.leadReceived({ leadId: lead.id, agencyId: lead.agencyId, siteId: lead.siteId });
  const inserted = await repo.insertLeadWithEvent(
    tx,
    {
      id: lead.id,
      agencyId: lead.agencyId,
      siteId: lead.siteId,
      kind: lead.kind,
      idempotencyHash: lead.idempotencyHash,
      requestHash: lead.requestHash,
      verification: lead.verification,
      targetKind: lead.target?.kind ?? null,
      targetId: lead.target?.id ?? null,
      ownerAgencyId: lead.target?.ownerAgencyId ?? null,
      shownRef: lead.target?.shownRef ?? null,
      locale: lead.locale,
      name: lead.name,
      email: lead.email,
      emailHash: lead.emailHash,
      keyTier: lead.keyTier,
      phone: lead.phone,
      message: lead.message,
      viewingSlots: lead.viewingSlots,
      marketingConsent: lead.marketingConsent,
      pageUrl: lead.pageUrl,
    },
    event,
  );
  if (inserted) return { receipt: inserted, created: true };
  // The key is taken: by a committed lead (a concurrent insert of the same key waited for it to commit).
  return { receipt: await leadByIdempotency(tx, lead.siteId, lead.idempotencyHash), created: false };
}

/** Start of the replay window: a key older than this names no lead any more. */
const replaySince = () => new Date(clock.now().getTime() - LEAD_IDEMPOTENCY_HOURS * 3_600_000);

/** The lead a site's idempotency key names within the replay window (intake: its receipt only). */
export function leadByIdempotency(tx: Tx, siteId: string, idempotencyHash: string): Promise<repo.LeadReceipt | null> {
  return repo.leadByIdempotency(tx, siteId, idempotencyHash, replaySince());
}

/** Acknowledgements already sent since `since` to the recipient (per site, everywhere) and by the site (`app_system`). */
export function ackUsage(tx: Tx, q: { siteId: string; emailHash: string; since: Date }) {
  return repo.ackUsage(tx, q);
}

/** Records that a lead gets no acknowledgement (a daily cap), and why. */
export function markAckSkipped(tx: Tx, id: string, reason: repo.AckSkipReason, at: Date): Promise<void> {
  return repo.markAckSkipped(tx, id, reason, at);
}

/** A lead by id, for the acknowledgement and notification jobs (`app_system` transaction). */
export function inboundLead(tx: Tx, id: string): Promise<repo.LeadRow | null> {
  return repo.leadById(tx, id);
}

/** Records that the visitor's acknowledgement (`ack`) or the agency's notification (`agency`) was sent. */
export function markLeadSent(tx: Tx, id: string, what: 'ack' | 'agency', at: Date): Promise<void> {
  return repo.markLeadSent(tx, id, what, at);
}

/** Clears idempotency keys older than the replay window, in batches. Returns the keys cleared. */
export async function pruneLeadIdempotency(now: Date): Promise<number> {
  const before = new Date(now.getTime() - LEAD_IDEMPOTENCY_HOURS * 3_600_000);
  let total = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
    const n = await withSystem('websites.pruneLeadIdempotency', (tx) =>
      repo.clearIdempotencyKeys(tx, before, PRUNE_BATCH),
    );
    total += n;
    if (n < PRUNE_BATCH) break;
  }
  return total;
}
