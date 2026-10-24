import type { LeadSource } from '@inmolink/contracts';

/**
 * Lead routing by source (PLAN §3 #12, S10-02) — pure, so the decision is one table everyone can read and test:
 *
 * | source                                                                  | inbox (holder)          | introduced      |
 * |-------------------------------------------------------------------------|-------------------------|-----------------|
 * | MARKETPLACE                                                             | the listing owner       | —               |
 * | WEBSITE, IFRAME, SELECTION, PORTFOLIO, PORTAL, CHATBOT, WHATSAPP, MANUAL | the presenting agency   | owner, if other |
 * | DEVELOPER_PORTAL                                                        | the presenting agency   | the developer   |
 *
 * The holder alone gets the lead with its client. An owner that is not the holder gets an introduction: who
 * introduced a client for which target — never the client (its details reach the owner only through a registration,
 * S11-01). Without a presenting agency (the owner's own channel) the owner holds the lead.
 */
export interface RouteInput {
  source: LeadSource;
  /** The agency whose channel the client used (a site's agency, the member's agency for a manual lead). */
  presentingAgencyId: string | null;
  /** The target's owner (null: a general enquiry, or the target is the presenting agency's own). */
  ownerAgencyId: string | null;
}

export interface Route {
  /** The agency whose inbox gets the lead (and the client). */
  holderAgencyId: string;
  /** The agency the lead is introduced to (sees the introducer and the target, never the client), or null. */
  introducedAgencyId: string | null;
}

/** Sources whose leads belong to the target's owner, whoever showed it. */
const OWNER_ROUTED: ReadonlySet<LeadSource> = new Set<LeadSource>(['MARKETPLACE']);

export function routeLead(input: RouteInput): Route {
  const owner = input.ownerAgencyId;
  const presenting = input.presentingAgencyId;
  const holder = OWNER_ROUTED.has(input.source) && owner ? owner : (presenting ?? owner);
  if (!holder) throw new Error('a lead needs a presenting agency or a target owner');
  return { holderAgencyId: holder, introducedAgencyId: owner && owner !== holder ? owner : null };
}
