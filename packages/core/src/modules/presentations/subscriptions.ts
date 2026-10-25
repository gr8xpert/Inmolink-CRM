import { withSystem } from '@inmolink/db';
import type { EventMeta } from '@inmolink/platform/outbox';
import { subscribe } from '@inmolink/platform/outbox';
import * as crm from '../crm';
import * as search from '../search';
import { presentationsEvents } from './events';
import * as repo from './repo';

let unsubscribe: (() => void)[] | undefined;

/** Interactions on the timeline (S12-04): an unlike takes nothing away from it. */
const ACTIVITY = { VIEW: 'SELECTION_VIEWED', LIKE: 'SELECTION_LIKED', ENQUIRE: 'SELECTION_ENQUIRED' } as const;

type Interacted = Parameters<typeof presentationsEvents.selectionInteracted>[0];

/**
 * The CRM activity of a client's interaction (S12-04): on the selection's contact — and on the item's listing when it
 * is the agency's own; null when it names neither (no contact, another agency's listing or a unit) or is an unlike.
 * Worker-only (`withSystem`: the selection's hidden contact, the target's kind and owner).
 */
export async function selectionTimelineActivity(
  payload: Interacted,
  meta: Pick<EventMeta, 'eventId' | 'agencyId' | 'createdAt'>,
): Promise<crm.RecordedActivity | null> {
  if (payload.kind === 'UNLIKE') return null;
  const { selection, doc } = await withSystem('presentations.selection.timeline', async (tx) => ({
    selection: await repo.selectionContact(tx, payload.selectionId),
    doc: payload.targetId ? (await search.readModelDocs(tx, [payload.targetId]))[0] : undefined,
  }));
  if (!selection || selection.agencyId !== meta.agencyId) return null;
  const listingId =
    doc && doc.kind === 'LISTING' && doc.agencyId === meta.agencyId ? (payload.targetId ?? undefined) : undefined;
  if (!selection.contactId && !listingId) return null;
  return {
    eventId: meta.eventId,
    agencyId: meta.agencyId,
    occurredAt: meta.createdAt.toISOString(),
    type: ACTIVITY[payload.kind],
    ...(selection.contactId ? { contactId: selection.contactId } : {}),
    ...(listingId ? { listingId } : {}),
    data: { selectionId: payload.selectionId, targetId: payload.targetId },
  };
}

/**
 * Outbox → CRM timeline (S12-04): a client's view, like or enquiry on a selection's page becomes an activity through
 * crm's own writer (`crm.recordActivity`, idempotent by event id). Called once by the worker.
 */
export function registerPresentationsSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      presentationsEvents.selectionInteracted,
      async (payload, meta) => {
        const activity = await selectionTimelineActivity(payload, meta);
        if (activity) await crm.crmJobs.recordActivity.enqueue(activity);
      },
      { name: 'presentations.selection.timeline' },
    ),
  ];
}

/** Tests. */
export function unregisterPresentationsSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}
