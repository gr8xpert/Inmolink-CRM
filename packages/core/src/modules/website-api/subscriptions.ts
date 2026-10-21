import { withSystem } from '@inmolink/db';
import { type EventMeta, subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as identity from '../identity';
import * as search from '../search';
import * as websites from '../websites';
import { type EdgeTagKind, edgeTag, edgeTagsConfigured } from './edge';
import { addPendingPurges } from './edge-purge';
import { queueEdgePurgeRun, websiteApiJobs } from './jobs';

let unsubscribe: (() => void)[] | undefined;

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
 * Outbox → speed-to-lead (S7-05): a website lead queues the visitor's acknowledgement and the agency's notification,
 * one job each per lead (enqueueing again for a redelivered event is a no-op: `jobId`).
 *
 * Outbox → edge cache purge (S7-06): what websites show changed — public documents (read models rebuilt: `t`, `d`), a
 * site's setup (`s`), a key rotated or revoked (`k`), an agency's status (its sites' `s`), a preferred agency added or
 * removed (the preferred agency's sites' `s`: their network view changed; the owner's documents are rebuilt too and
 * purge their `t` tags through `search.publicDocs.changed`).
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
          websiteApiJobs.notifyLeadAgency.enqueue(job),
        ]);
      },
      { name: 'websiteApi.lead.received' },
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
