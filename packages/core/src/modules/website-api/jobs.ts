/**
 * website-api worker jobs (PATTERNS §12), pool `email`: speed-to-lead for website forms (S7-05, PLAN §3 #60).
 *
 * `websiteApi.sendLeadAcknowledgement` (on `websites.lead.received`): the visitor's acknowledgement in their language,
 * branded as the site, with up to three similar listings from the site's own inventory — found through the website
 * search path (`searchListings`: the site's policy, white-labelled cards, `<prefix>-<code>` references), never a table
 * join. Search failing or finding nothing never holds the e-mail back: it goes without suggestions.
 *
 * `websiteApi.notifyLeadAgency` (on `crm.lead.created` of a promoted website lead, S10-02): the presenting agency's
 * notification — to the agent the agency's assignment rule chose; without one (rule `UNASSIGNED`, nobody in the pool,
 * the agent deactivated since), to the site's contact e-mail, or the agency's active admins when the site and profile
 * publish none. `websiteApi.notifyLeadAgencyFallback` (on `websites.lead.received`, 2 minutes later) does the same for a
 * lead the CRM never promoted.
 *
 * Both idempotent per lead (`jobId`, and `ack_sent_at` / `agency_notified_at` checked before sending), fair-shared per
 * agency, retried 5× with backoff. The acknowledgement's slot is reserved atomically before the send (caps hold under
 * concurrency) and given back if the send fails; a worker crash between the reservation and the send loses that one
 * acknowledgement rather than risk exceeding a cap. The agency notification: a crash between the send and the mark
 * sends at most once more. The 60 s budget:
 * outbox poll (≤ 250 ms) + queue pickup + the search (≤ engine timeout, else the Postgres fallback) + one SMTP send.
 *
 * Per-site XML feeds (S7-07), pool `exports`: `websiteApi.generateSiteFeed` writes one site's feed files
 * (`site-feeds.ts`) — throttled per site (`queueSiteFeed`: a burst of listing changes is one run 5 minutes after the
 * first), fair-shared per agency (one run per agency at a time, two per process: memory), idempotent (a run that
 * loses to a later one deletes its own files). Triggers: a new token (at once), the site's setup, its agency's public
 * documents (`search.publicDocs.changed`), partner feeds when a network listing left the network (S8-F1:
 * `search.publicDocs.changed` with `networkLost`, `agencies.preferred.removed`), and **schedule** `websiteApi.refreshSiteFeeds` every 15 minutes (stable
 * scheduler id = the job name): live feeds older than 6 hours (network listings and overrides name no site), at most
 * 500 per sweep, the stalest first.
 */
import type { ListingCardDoc, UnitCardDoc, ViewingSlot, WebsiteCard, WebsiteListingsQuery } from '@inmolink/contracts';
import { withPublicRead, withSystem } from '@inmolink/db';
import { cdnPurger } from '@inmolink/platform/cdn';
import { clock } from '@inmolink/platform/clock';
import { mailer } from '@inmolink/platform/email';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import * as crm from '../crm';
import * as identity from '../identity';
import * as search from '../search';
import * as websites from '../websites';
import { raiseWebsiteAlert } from './alerts';
import { EDGE_PURGE_HORIZON_MS, type EdgeTagKind, edgeTag, edgeTagsConfigured } from './edge';
import {
  addPendingPurges,
  clearPendingPurges,
  EDGE_PURGE_THROTTLE_MS,
  returnPendingPurges,
  takePendingPurges,
} from './edge-purge';
import { notifyLocale, renderLeadAck, renderLeadNotification } from './emails';
import { type ApiSite, searchListings, siteForKey } from './service';
import { websiteLimits } from './settings';
import {
  deleteSiteFeedFiles,
  generateSiteFeed,
  recordSiteFeedFailure,
  SITE_FEED_ATTEMPTS,
  SITE_FEED_MAX_AGE_MS,
  SiteFeedError,
} from './site-feeds';

/** Suggestions in the acknowledgement. */
export const SIMILAR_LISTINGS = 3;
/** Similar = within this share of the enquired listing's price. */
const PRICE_BAND = 0.3;

const payload = z.object({ eventId: z.uuid(), leadId: z.uuid(), agencyId: z.uuid() });
/** The agency notification: `leadId` is the website lead; `assignedUserId` the CRM lead's agent (S10-02), if any. */
const notifyPayload = payload.extend({ assignedUserId: z.uuid().nullable().default(null) });

/** One agency's pending edge purges (S7-06): the tags wait in redis-cache (`edge-purge.ts`), the job drains them. */
const purgePayload = z.object({ agencyId: z.uuid() });
const PURGE_ATTEMPTS = 5;

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

/**
 * Who gets a website lead's agency notification (`notifyLeadRecipient`'s `recipient`): the agent the CRM lead was
 * assigned to (S10-02: the assignment rule replaces the default choice) while they are an active member; otherwise the
 * site's contact e-mail (`contact`), or each active admin when the site and profile publish none.
 */
export async function leadNotifyRecipients(
  agencyId: string,
  siteHasContact: boolean,
  assignedUserId: string | null,
): Promise<string[]> {
  const agent = assignedUserId
    ? await withSystem('websiteApi.notifyLeadAgency agent', (tx) =>
        identity.memberRecipient(tx, agencyId, assignedUserId),
      )
    : null;
  if (agent) return [agent.userId];
  if (siteHasContact) return ['contact'];
  const admins = await withSystem('websiteApi.notifyLeadAgency', (tx) => identity.listAgencyAdmins(tx, agencyId));
  return admins.map((a) => a.userId);
}

/** Fans a website lead's agency notification out (once: `agency_notified_at`), one job per recipient. */
async function notifyAgency(
  p: { leadId: string; agencyId: string; assignedUserId: string | null },
  log: { info: (obj: object, msg: string) => void },
): Promise<{ queued: number }> {
  const loaded = await load(p.leadId, 'agencyNotifiedAt', `lead-notify:${p.leadId}`);
  if (!loaded) return { queued: 0 };
  const { lead, site } = loaded;
  const recipients = await leadNotifyRecipients(lead.agencyId, Boolean(site.scope.presenter.email), p.assignedUserId);
  for (const recipient of recipients) {
    await websiteApiJobs.notifyLeadRecipient.enqueue({ leadId: lead.id, agencyId: lead.agencyId, recipient });
  }
  const at = clock.now();
  await withSystem('websiteApi.notifyLeadAgency', (tx) => websites.markLeadSent(tx, lead.id, 'agency', at));
  log.info({ leadId: lead.id, recipients: recipients.length }, 'lead notifications queued');
  return { queued: recipients.length };
}

/**
 * How long after a website lead its fallback notification runs (`notifyLeadAgencyFallback`): beyond the promotion
 * job's retries (5 attempts, 1 s exponential backoff ≈ 15 s, plus the outbox and the queue).
 */
export const LEAD_NOTIFY_FALLBACK_MS = 2 * 60_000;

/** The lead and its site, or null when there is nothing (left) to send. */
async function load(leadId: string, done: 'ackSentAt' | 'agencyNotifiedAt', requestId: string) {
  const lead = await withSystem(`websiteApi.lead ${done}`, (tx) => websites.inboundLead(tx, leadId));
  if (!lead || lead[done]) return null;
  const site = await siteForKey({ agencyId: lead.agencyId, siteId: lead.siteId }, requestId);
  return { lead, site };
}

/**
 * S9 review: the `exports` pool's heavy jobs — site feeds (here), portal feed passes (event and nightly) and push runs
 * (`exports`) — share one per-process and one pool-wide cap (`capGroup`): each holds an upload part per file being
 * written, so they are counted together, not per job kind. The caps are the portal feeds' settings
 * (`EXPORTS_PORTAL_FEEDS_PER_PROCESS`, `EXPORTS_PORTAL_FEEDS_MAX_CONCURRENT`); `exports` sets them at boot.
 */
export const EXPORTS_FEED_CAP_GROUP = 'exports.feeds';

export interface FeedRunCaps {
  /** Heavy jobs at once in one worker process (memory; 2 measured safe: S9-03 RSS run). */
  runsPerProcess: number;
  /** Heavy jobs at once across the pool (database load). */
  maxConcurrentRuns: number;
}

let feedRunCaps: FeedRunCaps = { runsPerProcess: 2, maxConcurrentRuns: 8 };

/** Boot (worker, through `exports.configurePortalFeedJobs`): the shared caps of the `exports` pool's heavy jobs. */
export function configureFeedRunCaps(next: FeedRunCaps): void {
  for (const k of ['runsPerProcess', 'maxConcurrentRuns'] as const) {
    if (!Number.isInteger(next[k]) || next[k] < 1) throw new RangeError(`website-api: ${k} must be a positive integer`);
  }
  feedRunCaps = { ...next };
}

export const websiteApiJobs = {
  /**
   * S7-06: purges an agency's pending edge cache tags — listings and units (`t`), developments (`d`), sites (`s`),
   * API keys (`k`) — through the CDN adapter, outside any transaction: up to 100 tags (one request) per run, oldest
   * first; more left → another run after the agency's throttle window (`queueEdgePurge`). One run at a time across the
   * pool (`globalConcurrency` 1) and the adapter holds the slot for its pacing interval after the request, so the
   * account-wide purge rate holds across every worker process. Listing and development tags past
   * `EDGE_PURGE_HORIZON_MS` are dropped (expired at the edge); site and key tags never are. A failed purge puts its tags
   * back and retries with backoff; the last failed attempt raises `WebsiteEdgePurgeFailing`. Nothing to purge without
   * a configured purger (local, CI, edge cache off): the pending tags are dropped.
   */
  purgeEdgeCache: defineJob({
    name: 'websiteApi.purgeEdgeCache',
    pool: 'indexing',
    payload: purgePayload,
    group: (p) => p.agencyId,
    globalConcurrency: 1,
    attempts: PURGE_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p, { log, signal, attempt }) {
      const purger = cdnPurger();
      if (!purger || !edgeTagsConfigured()) {
        await clearPendingPurges(p.agencyId);
        return { purged: 0, skipped: 'no-edge-cache' };
      }
      const { tags, dropped, more } = await takePendingPurges(
        p.agencyId,
        clock.now().getTime() - EDGE_PURGE_HORIZON_MS,
      );
      if (tags.length > 0) {
        try {
          await purger.purgeTags(
            tags.map((t) => t.tag),
            { signal },
          );
        } catch (err) {
          await returnPendingPurges(p.agencyId, tags);
          if (attempt >= PURGE_ATTEMPTS) {
            raiseWebsiteAlert({
              kind: 'edgePurge',
              agencyId: p.agencyId,
              tags: tags.length,
              error: err instanceof Error ? err.name : 'error',
            });
          }
          throw err;
        }
      }
      if (more) await queueEdgePurgeRun(p.agencyId);
      if (tags.length > 0 || dropped > 0)
        log.info({ agencyId: p.agencyId, tags: tags.length, dropped }, 'edge cache purged');
      return { purged: tags.length, dropped };
    },
  }),

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
      // A form can name anyone's address: cap the automatic replies per recipient and per site (S7-05 review). The
      // decision and the slot are taken atomically — under advisory locks on the recipient and the site, the slot
      // counted at once (`ack_sent_at`) — so concurrent jobs for one recipient never all pass the cap.
      const reservedAt = clock.now();
      const decision = await withSystem('websiteApi.sendLeadAcknowledgement limits', async (tx) => {
        await websites.lockAckSlots(tx, { siteId: lead.siteId, emailHash: lead.emailHash });
        const reason = ackCapReached(
          await websites.ackUsage(tx, {
            siteId: lead.siteId,
            emailHash: lead.emailHash,
            since: new Date(reservedAt.getTime() - DAY_MS),
          }),
          lead.keyTier === 'HIGH' ? 'HIGH' : 'STANDARD',
        );
        if (reason) {
          await websites.markAckSkipped(tx, lead.id, reason, reservedAt);
          return { skip: reason } as const;
        }
        return { reserved: await websites.reserveAck(tx, lead.id, reservedAt) } as const;
      });
      if ('skip' in decision) {
        log.warn({ leadId: lead.id, siteId: lead.siteId, reason: decision.skip }, 'lead acknowledgement capped');
        return { sent: false, skipped: decision.skip };
      }
      if (!decision.reserved) {
        log.info({ leadId: lead.id }, 'lead acknowledgement skipped (taken by another run)');
        return { sent: false };
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
      // Outside any transaction (CLAUDE.md rule 6). Never log the message or the address. A failed send gives the slot
      // back, so the retry reserves (and re-checks the caps) again.
      try {
        await mailer().send(message);
      } catch (err) {
        await withSystem('websiteApi.sendLeadAcknowledgement release', (tx) =>
          websites.releaseAck(tx, lead.id, reservedAt),
        );
        throw err;
      }
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
   * Fans the agency's notification out: one `notifyLeadRecipient` job per recipient (the assigned agent, else the site's
   * contact, else each active admin), so a retry never e-mails a recipient twice.
   */
  notifyLeadAgency: defineJob({
    name: 'websiteApi.notifyLeadAgency',
    pool: 'email',
    payload: notifyPayload,
    jobId: (p) => p.leadId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      return notifyAgency(p, log);
    },
  }),

  /**
   * S10-02 review: the agency hears of every website lead, also one the CRM never promoted (the promotion failed for
   * good, or found no lead). Queued with the acknowledgement on `websites.lead.received`, run `LEAD_NOTIFY_FALLBACK_MS`
   * later (after the promotion's retries): a promoted lead is announced by `notifyLeadAgency` (to its agent) and this
   * does nothing; otherwise it notifies the default recipients. `agency_notified_at` keeps it to one notification.
   */
  notifyLeadAgencyFallback: defineJob({
    name: 'websiteApi.notifyLeadAgencyFallback',
    pool: 'email',
    payload,
    jobId: (p) => p.leadId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
    timeoutMs: 30_000,
    async run(p, { log }) {
      if (await crm.isInboundLeadPromoted(p.agencyId, p.leadId)) return { queued: 0, promoted: true };
      return { ...(await notifyAgency({ ...p, assignedUserId: null }, log)), promoted: false };
    },
  }),

  /** One recipient's notification (`recipient`: `contact` — the site's contact e-mail — or a member's user id). */
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
          : await withSystem('websiteApi.notifyLeadRecipient', (tx) =>
              identity.memberRecipient(tx, lead.agencyId, p.recipient),
            );
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

  /**
   * S7-07: one site's XML feed files (`generateSiteFeed`). A run over the size cap fails for good (`TOO_LARGE`, no
   * retry); other failures retry with backoff and record `GENERATION_FAILED` on the last attempt. The feed keeps
   * serving the previous run's files meanwhile. A recorded run purges the feed's edge copies (`f`).
   */
  generateSiteFeed: defineJob({
    name: 'websiteApi.generateSiteFeed',
    pool: 'exports',
    payload: z.object({ siteId: z.uuid(), agencyId: z.uuid() }),
    group: (p) => p.agencyId,
    concurrencyPerGroup: 1,
    // S9 review: one budget with the portal feed passes and push runs (`EXPORTS_FEED_CAP_GROUP`).
    capGroup: EXPORTS_FEED_CAP_GROUP,
    perProcessConcurrency: () => feedRunCaps.runsPerProcess,
    globalConcurrency: () => feedRunCaps.maxConcurrentRuns,
    attempts: SITE_FEED_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 10 * 60_000,
    async run(p, { log, signal, attempt, progress }) {
      try {
        const result = await generateSiteFeed(p.siteId, { signal, log, progress: (items) => progress({ items }) });
        if (result.runId && !result.skipped) {
          await queueEdgePurge(p.agencyId, [{ kind: 'f', id: p.siteId }], clock.now());
        }
        return result;
      } catch (err) {
        if (err instanceof SiteFeedError || attempt >= SITE_FEED_ATTEMPTS) await recordSiteFeedFailure(p.siteId, err);
        if (err instanceof SiteFeedError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
  }),

  /** S7-07 review: a revoked feed's stored files are deleted (unless a new token made it live again meanwhile). */
  deleteSiteFeedFiles: defineJob({
    name: 'websiteApi.deleteSiteFeedFiles',
    pool: 'exports',
    payload: z.object({ eventId: z.uuid(), siteId: z.uuid(), agencyId: z.uuid() }),
    jobId: (p) => p.eventId,
    group: (p) => p.agencyId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    timeoutMs: 120_000,
    async run(p, { log }) {
      return { deleted: await deleteSiteFeedFiles(p.siteId, log) };
    },
  }),

  /**
   * S8-F1: one sweep of every network site's live feed after listings shared with every agency left the network. One
   * stable throttled job (`queueNetworkFeedSweep`): however many listings, owners and events, the network feeds are
   * queued at most once per window (`SITE_FEED_NETWORK_WINDOW_MINUTES`, default 30) — never per event. Pages of 500,
   * one bulk enqueue each; idempotent (a feed already queued is throttled per site).
   */
  sweepNetworkFeeds: defineJob({
    name: 'websiteApi.sweepNetworkFeeds',
    pool: 'exports',
    payload: z.object({}),
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    timeoutMs: 5 * 60_000,
    async run(_p, { log }) {
      const queued = await queueNetworkFeeds({ throttleMs: SITE_FEED_SOON_MS });
      log.info({ feeds: queued }, 'network site feeds queued after listings left the network');
      return { queued };
    },
  }),

  /** S7-07, every 15 minutes: live feeds older than `SITE_FEED_MAX_AGE_MS` (or never generated) get a run soon. */
  refreshSiteFeeds: defineJob({
    name: 'websiteApi.refreshSiteFeeds',
    pool: 'exports',
    payload: z.object({}),
    every: 15 * 60_000,
    attempts: 1,
    timeoutMs: 60_000,
    async run(_p, { log }) {
      const due = await withSystem('websiteApi.refreshSiteFeeds', (tx) =>
        websites.dueSiteFeeds(tx, new Date(clock.now().getTime() - SITE_FEED_MAX_AGE_MS), SITE_FEED_SWEEP),
      );
      // One bulk add (S8-F1), not a round trip per feed.
      await queueSiteFeeds(due, SITE_FEED_SOON_MS);
      if (due.length > 0) log.info({ feeds: due.length }, 'site feeds queued for refresh');
      return { queued: due.length };
    },
  }),
};

/** Live feeds queued per refresh sweep (every 15 minutes: up to 48,000 a day). */
const SITE_FEED_SWEEP = 500;
/** A listing or site change: one run this long after the first change (later changes fold into it). */
export const SITE_FEED_THROTTLE_MS = 5 * 60_000;
/** A new token or a due refresh: a run within seconds. */
export const SITE_FEED_SOON_MS = 5_000;
/**
 * S8-F1: a named partner's feed (preferred agencies that lost a PREFERRED listing, a preferred agency removed). Listings
 * shared with every agency go through the coalesced sweep instead (`queueNetworkFeedSweep`). Longer than the owner's
 * window — still minutes, not the 6-hour refresh.
 */
export const SITE_FEED_PARTNER_THROTTLE_MS = 15 * 60_000;

/** Queues a run of the site's feed (S7-07), at most one per throttle window per site. */
export async function queueSiteFeed(
  siteId: string,
  agencyId: string,
  throttleMs = SITE_FEED_THROTTLE_MS,
): Promise<void> {
  await websiteApiJobs.generateSiteFeed.enqueue(
    { siteId, agencyId },
    { throttleMs, debounceKey: `site-feed:${siteId}` },
  );
}

/** Network feeds read per page (S8-F1): one bulk enqueue each (one `addBulk` per 500). */
const NETWORK_FEED_PAGE = 500;
/** Default window of the network feed sweep (S8-F1; `SITE_FEED_NETWORK_WINDOW_MINUTES`). */
export const SITE_FEED_NETWORK_WINDOW_MS = 30 * 60_000;
let networkWindowMs = SITE_FEED_NETWORK_WINDOW_MS;

/** Boot (worker, S8-F1): the network feed sweep's window. */
export function configureSiteFeedFanout(next: { networkWindowMs: number }): void {
  if (!Number.isInteger(next.networkWindowMs) || next.networkWindowMs < 60_000) {
    throw new RangeError('website-api: networkWindowMs must be an integer >= 60000');
  }
  networkWindowMs = next.networkWindowMs;
}

/** The current network feed sweep window (ms). */
export const siteFeedNetworkWindowMs = (): number => networkWindowMs;

/**
 * S8-F1: marks every network site's feed stale — one `websiteApi.sweepNetworkFeeds` per window, however often this is
 * called (stable throttle key, no tenant group: the sweep is platform-wide and no tenant can multiply it).
 */
export async function queueNetworkFeedSweep(): Promise<void> {
  await websiteApiJobs.sweepNetworkFeeds.enqueue({}, { throttleMs: networkWindowMs, debounceKey: 'network-feeds' });
}

/**
 * S8-F1: queues the live feeds of network sites — of these agencies, or of every agency (`agencyIds` omitted) — never
 * the `except` agency's, page by page (keyset by site id), one bulk enqueue per page, throttled per site.
 */
export async function queueNetworkFeeds(q: {
  throttleMs: number;
  except?: string;
  agencyIds?: readonly string[];
}): Promise<number> {
  if (q.agencyIds?.length === 0) return 0;
  let queued = 0;
  let after: string | undefined;
  for (;;) {
    const page = await withSystem('websiteApi.feed network sites', (tx) =>
      websites.networkFeedSites(tx, { except: q.except, agencyIds: q.agencyIds, after, limit: NETWORK_FEED_PAGE }),
    );
    await queueSiteFeeds(page, q.throttleMs);
    queued += page.length;
    if (page.length < NETWORK_FEED_PAGE) return queued;
    after = page[page.length - 1]?.siteId;
  }
}

/** Queues runs of these feeds in bulk (S8-F1: one `addBulk` per 500), each throttled per site like `queueSiteFeed`. */
export async function queueSiteFeeds(
  feeds: readonly { siteId: string; agencyId: string }[],
  throttleMs = SITE_FEED_THROTTLE_MS,
): Promise<void> {
  if (feeds.length === 0) return;
  await websiteApiJobs.generateSiteFeed.enqueueMany(
    feeds.map((f) => ({
      payload: { siteId: f.siteId, agencyId: f.agencyId },
      options: { throttleMs, debounceKey: `site-feed:${f.siteId}` },
    })),
  );
}

/**
 * Queues edge purges (S7-06): the tags join the agency's pending set (coalesced, `edge-purge.ts`) and the agency's
 * throttled purge run is enqueued. A redelivered event adds the same tags again: harmless.
 */
export async function queueEdgePurge(
  agencyId: string,
  items: readonly { kind: EdgeTagKind; id: string }[],
  changedAt: Date,
): Promise<void> {
  if (items.length === 0 || !edgeTagsConfigured()) return;
  const at = changedAt.getTime();
  await addPendingPurges(
    agencyId,
    items.map((i) => ({ tag: edgeTag(i.kind, i.id), at })),
  );
  await queueEdgePurgeRun(agencyId);
}

/** The agency's next purge run, at most one per throttle window (S7-06: per-tenant purge budget). */
export async function queueEdgePurgeRun(agencyId: string): Promise<void> {
  await websiteApiJobs.purgeEdgeCache.enqueue(
    { agencyId },
    { throttleMs: EDGE_PURGE_THROTTLE_MS, debounceKey: `edge-purge:${agencyId}` },
  );
}

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
