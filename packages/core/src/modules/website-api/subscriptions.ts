import { withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { type EventMeta, subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as crm from '../crm';
import * as identity from '../identity';
import * as search from '../search';
import * as websites from '../websites';
import {
  LEAD_NOTIFY_FALLBACK_MS,
  queueEdgePurge,
  queueNetworkFeedSweep,
  queueNetworkFeeds,
  queueSiteFeed,
  queueSiteFeeds,
  SITE_FEED_PARTNER_THROTTLE_MS,
  SITE_FEED_SOON_MS,
  websiteApiJobs,
} from './jobs';

export { queueEdgePurge };

let unsubscribe: (() => void)[] | undefined;

/** Every site of an agency gets its `s` tag purged (its status or its network view changed). */
async function purgeAgencySites(agencyId: string, meta: EventMeta): Promise<void> {
  const siteIds = await withSystem('websiteApi.edge agency sites', (tx) => websites.agencySiteIds(tx, agencyId));
  await queueEdgePurge(
    agencyId,
    siteIds.map((id) => ({ kind: 's' as const, id })),
    meta.createdAt,
  );
}

/**
 * Outbox → speed-to-lead (S7-05): a website lead queues the visitor's acknowledgement; once crm has promoted it to a
 * lead (`crm.lead.created` with its `inboundLeadId`, S10-02) the agency's notification follows, to the assigned agent;
 * a delayed fallback announces a lead the CRM never promoted — one job each per lead (enqueueing again for a
 * redelivered event is a no-op: `jobId`).
 *
 * Outbox → edge cache purge (S7-06): what websites show changed — public documents (read models rebuilt: `t`, `d`), a
 * site's setup (`s`), a key rotated or revoked (`k`), an agency's status (its sites' `s`), a preferred agency added or
 * removed (the preferred agency's sites' `s`: their network view changed; the owner's documents are rebuilt too and
 * purge their `t` tags through `search.publicDocs.changed`).
 *
 * Outbox → per-site XML feeds (S7-07): a new token generates the feed at once and purges the old URL's edge copies
 * (`f`), a revoked one purges them and deletes the stored files; a site's setup or its agency's public documents changing queues the agency's
 * live feeds (throttled per site: `queueSiteFeed`). S8-F1: a target that left the network (`networkLost`: no longer
 * public, hidden from the network, or shared more narrowly) also reaches the partner feeds that may have shown it —
 * shared with every agency: one coalesced sweep of every network feed per window (`websiteApi.sweepNetworkFeeds`);
 * shared with some: those agencies' network feeds directly — and a removed preferred agency queues that agency's
 * feeds, so it leaves partner feeds within minutes. Other network
 * changes (new listings, prices) and overrides reach partner feeds through the 6-hourly refresh
 * (`websiteApi.refreshSiteFeeds`).
 *
 * Called once by the worker; idempotent.
 */
export function registerWebsiteApiSubscriptions(): void {
  if (unsubscribe) return;
  const keyChanged = async (payload: { agencyId: string; keyId: string }, meta: EventMeta) => {
    await queueEdgePurge(payload.agencyId, [{ kind: 'k', id: payload.keyId }], meta.createdAt);
  };
  const preferredChanged = async (payload: { preferredAgencyId: string }, meta: EventMeta) => {
    await purgeAgencySites(payload.preferredAgencyId, meta);
  };
  unsubscribe = [
    subscribe(
      websites.websitesEvents.leadReceived,
      async (payload, meta) => {
        const job = { eventId: meta.eventId, leadId: payload.leadId, agencyId: payload.agencyId };
        await Promise.all([
          websiteApiJobs.sendLeadAcknowledgement.enqueue(job),
          // the agency hears of the lead even if the CRM never promotes it (a no-op once it did)
          websiteApiJobs.notifyLeadAgencyFallback.enqueue(job, { delayMs: LEAD_NOTIFY_FALLBACK_MS }),
        ]);
      },
      { name: 'websiteApi.lead.received' },
    ),
    subscribe(
      crm.crmEvents.leadCreated,
      async (payload, meta) => {
        // S10-02: the agency is told once the lead is in its inbox, so the e-mail goes to the agent it was assigned to.
        if (!payload.inboundLeadId) return;
        await websiteApiJobs.notifyLeadAgency.enqueue({
          eventId: meta.eventId,
          leadId: payload.inboundLeadId,
          agencyId: meta.agencyId,
          assignedUserId: payload.assignedUserId,
        });
      },
      { name: 'websiteApi.lead.notify' },
    ),
    subscribe(
      search.searchEvents.publicDocsChanged,
      async (payload, meta) => {
        await queueEdgePurge(
          meta.agencyId,
          [
            ...payload.targetIds.map((id) => ({ kind: 't' as const, id })),
            ...payload.developmentIds.map((id) => ({ kind: 'd' as const, id })),
          ],
          meta.createdAt,
        );
      },
      { name: 'websiteApi.edge.publicDocsChanged' },
    ),
    subscribe(
      websites.websitesEvents.siteChanged,
      async (payload, meta) => {
        await queueEdgePurge(payload.agencyId, [{ kind: 's', id: payload.siteId }], meta.createdAt);
      },
      { name: 'websiteApi.edge.siteChanged' },
    ),
    // S13-F21: a site's plan or cut-off changed: its edge copies are purged now, and again when the cut-off arrives.
    subscribe(
      websites.websitesEvents.sitePlanChanged,
      async (payload, meta) => {
        await queueEdgePurge(payload.agencyId, [{ kind: 's', id: payload.siteId }], meta.createdAt);
        if (payload.endsAt) {
          await websiteApiJobs.purgeSiteAtCutoff.enqueue(
            { agencyId: payload.agencyId, siteId: payload.siteId, endsAt: payload.endsAt },
            { delayMs: Math.max(0, Date.parse(payload.endsAt) - clock.now().getTime()) },
          );
        }
      },
      { name: 'websiteApi.edge.sitePlanChanged' },
    ),
    subscribe(
      websites.websitesEvents.feedChanged,
      async (payload, meta) => {
        await queueEdgePurge(payload.agencyId, [{ kind: 'f', id: payload.siteId }], meta.createdAt);
        if (payload.action === 'ROTATED') await queueSiteFeed(payload.siteId, payload.agencyId, SITE_FEED_SOON_MS);
        else {
          await websiteApiJobs.deleteSiteFeedFiles.enqueue({
            eventId: meta.eventId,
            siteId: payload.siteId,
            agencyId: payload.agencyId,
          });
        }
      },
      { name: 'websiteApi.feed.changed' },
    ),
    subscribe(
      websites.websitesEvents.siteChanged,
      async (payload) => {
        const live = await withSystem('websiteApi.feed siteChanged', (tx) => websites.liveSiteFeed(tx, payload.siteId));
        if (live) await queueSiteFeed(payload.siteId, payload.agencyId);
      },
      { name: 'websiteApi.feed.siteChanged' },
    ),
    subscribe(
      search.searchEvents.publicDocsChanged,
      async (payload, meta) => {
        const siteIds = await withSystem('websiteApi.feed publicDocsChanged', (tx) =>
          websites.agencyFeedSiteIds(tx, meta.agencyId),
        );
        await queueSiteFeeds(siteIds.map((siteId) => ({ siteId, agencyId: meta.agencyId })));
        const lost = payload.networkLost;
        // Shared with every agency: one coalesced sweep per window (never a platform-wide fan-out per event);
        // shared with some: those agencies' network feeds directly.
        if (lost?.all) await queueNetworkFeedSweep();
        else if (lost) {
          await queueNetworkFeeds({
            except: meta.agencyId,
            agencyIds: lost.agencyIds,
            throttleMs: SITE_FEED_PARTNER_THROTTLE_MS,
          });
        }
      },
      { name: 'websiteApi.feed.publicDocsChanged' },
    ),
    subscribe(identity.identityEvents.apiKeyRotated, keyChanged, { name: 'websiteApi.edge.apiKeyRotated' }),
    subscribe(identity.identityEvents.apiKeyRevoked, keyChanged, { name: 'websiteApi.edge.apiKeyRevoked' }),
    subscribe(
      agencies.agenciesEvents.statusChanged,
      async (payload, meta) => {
        await purgeAgencySites(payload.agencyId, meta);
      },
      { name: 'websiteApi.edge.agencyStatus' },
    ),
    subscribe(agencies.agenciesEvents.preferredAdded, preferredChanged, { name: 'websiteApi.edge.preferredAdded' }),
    subscribe(
      agencies.agenciesEvents.preferredRemoved,
      async (payload) => {
        // The removed agency's network sites no longer show the owner's PREFERRED listings (S8-F1).
        await queueNetworkFeeds({
          except: payload.agencyId,
          agencyIds: [payload.preferredAgencyId],
          throttleMs: SITE_FEED_PARTNER_THROTTLE_MS,
        });
      },
      { name: 'websiteApi.feed.preferredRemoved' },
    ),
    subscribe(agencies.agenciesEvents.preferredRemoved, preferredChanged, {
      name: 'websiteApi.edge.preferredRemoved',
    }),
  ];
}

/** Tests: drop the subscriptions again. */
export function unregisterWebsiteApiSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
