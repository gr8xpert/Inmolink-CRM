/**
 * website-api worker jobs (PATTERNS §12), pool `email`: speed-to-lead for website forms (S7-05, PLAN §3 #60).
 *
 * `websiteApi.sendLeadAcknowledgement` (on `websites.lead.received`): the visitor's acknowledgement in their language,
 * branded as the site, with up to three similar listings from the site's own inventory — found through the website
 * search path (`searchListings`: the site's policy, white-labelled cards, `<prefix>-<code>` references), never a table
 * join. Search failing or finding nothing never holds the e-mail back: it goes without suggestions.
 *
 * `websiteApi.notifyLeadAgency` (same event): the presenting agency's notification — to the site's contact e-mail, or
 * the agency's active admins when the site and profile publish none.
 *
 * Both idempotent per lead (`jobId`, and `ack_sent_at` / `agency_notified_at` checked before sending; a crash between
 * the send and the mark sends at most once more), fair-shared per agency, retried 5× with backoff. The 60 s budget:
 * outbox poll (≤ 250 ms) + queue pickup + the search (≤ engine timeout, else the Postgres fallback) + one SMTP send.
 */
import type { ListingCardDoc, UnitCardDoc, ViewingSlot, WebsiteCard, WebsiteListingsQuery } from '@inmolink/contracts';
import { withPublicRead, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { mailer } from '@inmolink/platform/email';
import { defineJob } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as identity from '../identity';
import * as search from '../search';
import * as websites from '../websites';
import { notifyLocale, renderLeadAck, renderLeadNotification } from './emails';
import { type ApiSite, searchListings, siteForKey } from './service';
import { websiteLimits } from './settings';

/** Suggestions in the acknowledgement. */
export const SIMILAR_LISTINGS = 3;
/** Similar = within this share of the enquired listing's price. */
const PRICE_BAND = 0.3;

const payload = z.object({ eventId: z.uuid(), leadId: z.uuid(), agencyId: z.uuid() });

/** The enquired target's card in the site's language (null: none, or no longer public). */
async function targetCard(site: ApiSite, lead: websites.LeadRow): Promise<ListingCardDoc | UnitCardDoc | null> {
  if (!lead.targetId) return null;
  const rows = await withPublicRead((tx) =>
    search.publicDocs(tx, [lead.targetId as string], 'card', lead.locale, site.scope.defaultLocale),
  );
  return (rows[0]?.doc as ListingCardDoc | UnitCardDoc | undefined) ?? null;
}

/**
 * Up to `SIMILAR_LISTINGS` of the site's listings like the enquired one: same transaction and type, near its place and
 * price, widening (no price band, then no place) until three are found; newest first for a general enquiry. Never the
 * enquired listing itself (compared by the reference the site shows).
 */
export async function similarListings(site: ApiSite, lead: websites.LeadRow): Promise<WebsiteCard[]> {
  const doc = await targetCard(site, lead);
  const base: Partial<WebsiteListingsQuery> = { lang: lead.locale, sort: 'newest', limit: SIMILAR_LISTINGS + 1 };
  const attempts: Partial<WebsiteListingsQuery>[] = [];
  if (doc) {
    const like: Partial<WebsiteListingsQuery> = {
      ...base,
      kind: doc.kind,
      ...(doc.kind === 'LISTING' ? { transaction: doc.transactionType } : {}),
      types: [doc.propertyType.id],
    };
    const place = doc.place.city?.id ?? doc.place.region?.id;
    const price = doc.price.onRequest ? null : doc.price.amountCents;
    const band =
      price === null
        ? {}
        : { priceMin: Math.floor(price * (1 - PRICE_BAND)), priceMax: Math.ceil(price * (1 + PRICE_BAND)) };
    if (place) attempts.push({ ...like, locations: [place], ...band }, { ...like, locations: [place] });
    attempts.push(like);
  } else {
    attempts.push(base);
  }
  const found: WebsiteCard[] = [];
  const seen = new Set<string>(lead.shownRef ? [lead.shownRef] : []);
  for (const q of attempts) {
    const page = await searchListings(site, q as WebsiteListingsQuery);
    for (const card of page.items) {
      if (seen.has(card.ref)) continue;
      seen.add(card.ref);
      found.push(card);
      if (found.length === SIMILAR_LISTINGS) return found;
    }
  }
  return found;
}

/** The lead and its site, or null when there is nothing (left) to send. */
async function load(leadId: string, done: 'ackSentAt' | 'agencyNotifiedAt', requestId: string) {
  const lead = await withSystem(`websiteApi.lead ${done}`, (tx) => websites.inboundLead(tx, leadId));
  if (!lead || lead[done]) return null;
  const site = await siteForKey({ agencyId: lead.agencyId, siteId: lead.siteId }, requestId);
  return { lead, site };
}

export const websiteApiJobs = {
  sendLeadAcknowledgement: defineJob({
    name: 'websiteApi.sendLeadAcknowledgement',
    pool: 'email',
    payload,
    jobId: (p) => p.leadId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const loaded = await load(p.leadId, 'ackSentAt', `lead-ack:${p.leadId}`);
      if (!loaded || loaded.lead.ackSkippedReason) {
        log.info({ leadId: p.leadId }, 'lead acknowledgement skipped (no lead, already sent or capped)');
        return { sent: false };
      }
      const { lead, site } = loaded;
      // A form can name anyone's address: cap the automatic replies per recipient and per site (S7-05 review).
      const skip = await withSystem('websiteApi.sendLeadAcknowledgement limits', async (tx) => {
        const reason = ackCapReached(
          await websites.ackUsage(tx, {
            siteId: lead.siteId,
            emailHash: lead.emailHash,
            since: new Date(clock.now().getTime() - DAY_MS),
          }),
          lead.keyTier === 'HIGH' ? 'HIGH' : 'STANDARD',
        );
        if (reason) await websites.markAckSkipped(tx, lead.id, reason, clock.now());
        return reason;
      });
      if (skip) {
        log.warn({ leadId: lead.id, siteId: lead.siteId, reason: skip }, 'lead acknowledgement capped');
        return { sent: false, skipped: skip };
      }
      let similar: WebsiteCard[] = [];
      try {
        similar = await similarListings(site, lead);
      } catch (err) {
        // Degrade, don't fail: the acknowledgement goes without suggestions.
        log.warn({ leadId: lead.id, err: err instanceof Error ? err.name : typeof err }, 'similar listings failed');
      }
      const message = renderLeadAck({
        to: lead.email,
        name: lead.name,
        locale: lead.locale,
        kind: lead.kind,
        ref: lead.shownRef,
        presenter: site.scope.presenter,
        similar,
      });
      // Outside any transaction (CLAUDE.md rule 6). Never log the message or the address.
      await mailer().send(message);
      const sentAt = clock.now();
      await withSystem('websiteApi.sendLeadAcknowledgement', (tx) => websites.markLeadSent(tx, lead.id, 'ack', sentAt));
      log.info(
        {
          leadId: lead.id,
          siteId: lead.siteId,
          similar: similar.length,
          latencyMs: sentAt.getTime() - lead.createdAt.getTime(),
        },
        'lead acknowledgement sent',
      );
      return { sent: true, similar: similar.length };
    },
  }),

  /**
   * Fans the agency's notification out: one `notifyLeadRecipient` job per recipient (the site's contact, else each
   * active admin), so a retry never e-mails a recipient twice.
   */
  notifyLeadAgency: defineJob({
    name: 'websiteApi.notifyLeadAgency',
    pool: 'email',
    payload,
    jobId: (p) => p.leadId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const loaded = await load(p.leadId, 'agencyNotifiedAt', `lead-notify:${p.leadId}`);
      if (!loaded) return { queued: 0 };
      const { lead, site } = loaded;
      const recipients: string[] = site.scope.presenter.email
        ? ['contact']
        : (await withSystem('websiteApi.notifyLeadAgency', (tx) => identity.listAgencyAdmins(tx, lead.agencyId))).map(
            (a) => a.userId,
          );
      for (const recipient of recipients) {
        await websiteApiJobs.notifyLeadRecipient.enqueue({ leadId: lead.id, agencyId: lead.agencyId, recipient });
      }
      const at = clock.now();
      await withSystem('websiteApi.notifyLeadAgency', (tx) => websites.markLeadSent(tx, lead.id, 'agency', at));
      log.info({ leadId: lead.id, recipients: recipients.length }, 'lead notifications queued');
      return { queued: recipients.length };
    },
  }),

  /** One recipient's notification (`recipient`: `contact` — the site's contact e-mail — or an admin's user id). */
  notifyLeadRecipient: defineJob({
    name: 'websiteApi.notifyLeadRecipient',
    pool: 'email',
    payload: z.object({
      leadId: z.uuid(),
      agencyId: z.uuid(),
      recipient: z.union([z.literal('contact'), z.uuid()]),
    }),
    jobId: (p) => `${p.leadId}:${p.recipient}`,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      const lead = await withSystem('websiteApi.notifyLeadRecipient', (tx) => websites.inboundLead(tx, p.leadId));
      if (!lead) return { sent: false };
      const site = await siteForKey({ agencyId: lead.agencyId, siteId: lead.siteId }, `lead-notify:${p.leadId}`);
      const to =
        p.recipient === 'contact'
          ? site.scope.presenter.email
            ? { email: site.scope.presenter.email, locale: site.scope.defaultLocale }
            : null
          : ((
              await withSystem('websiteApi.notifyLeadRecipient', (tx) => identity.listAgencyAdmins(tx, lead.agencyId))
            ).find((a) => a.userId === p.recipient) ?? null);
      if (!to) {
        log.info({ leadId: lead.id }, 'lead notification recipient gone');
        return { sent: false };
      }
      await mailer().send(
        renderLeadNotification({
          to: to.email,
          locale: notifyLocale(to.locale),
          kind: lead.kind,
          ref: lead.shownRef,
          siteName: site.scope.name,
          lead: {
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            message: lead.message,
            locale: lead.locale,
            marketingConsent: lead.marketingConsent,
            pageUrl: lead.pageUrl,
            slots: (lead.viewingSlots as ViewingSlot[] | null) ?? [],
          },
        }),
      );
      return { sent: true };
    },
  }),
};

const DAY_MS = 86_400_000;

/** The first acknowledgement cap this lead reaches (sent ones over the last 24 h), or null. */
export function ackCapReached(
  usage: { recipientSite: number; recipient: number; site: number },
  tier: 'STANDARD' | 'HIGH',
): websites.AckSkipReason | null {
  const l = websiteLimits();
  if (usage.recipientSite >= l.ackPerRecipientSiteDay) return 'RECIPIENT_SITE_DAILY';
  if (usage.recipient >= l.ackPerRecipientDay) return 'RECIPIENT_DAILY';
  if (usage.site >= l.ackPerSiteDay[tier]) return 'SITE_DAILY';
  return null;
}
