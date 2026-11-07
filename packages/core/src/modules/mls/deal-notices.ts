import { withSystem } from '@inmolink/db';
import type { EventMeta, EventPayload } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as notifications from '../notifications';
import { dealChatContext } from './chat-context';
import type { mlsEvents } from './events';

/** The dashboard path of a deal (the `DEAL_UPDATED` notification's link; the deal room, R2-04c). */
export const dealLink = (dealId: string) => `/deals/${dealId}`;

/** The moves whose message names the agency that made them. */
const NAMED: ReadonlySet<string> = new Set([
  'OPENED',
  'ADVANCED',
  'PRICE_CHANGED',
  'CONFIRMED',
  'WITHDRAWN',
  'DISPUTED',
]);

/**
 * `mls.notifyDeal` (R2-04b; one job per `mls.deal.changed`, job ID = the event's id): the deal's members on the side to
 * tell get a `DEAL_UPDATED` notification — the other party's after a party's move, the event's own agency after a staff
 * mediation (staff write one event per party). Across agencies, so in the job's own `withSystem` transaction
 * (`sourceKey` = event + agency: idempotent).
 *
 * The event is not trusted beyond its writer: staff may write `mls.deal.changed` for any agency, and a payload names
 * agencies it does not prove. So the deal is re-read (both copies, naming each other), the event's agency
 * (`meta.agencyId`, RLS-checked when written) must be one of its two parties, and the agency told is derived from the
 * deal's copies — never from the payload's `introducerAgencyId` / `ownerAgencyId`. Anything else notifies nobody.
 * Never the client: the subject is the listing's reference, the actor the counterpart agency's directory name.
 */
export async function notifyDealChange(
  p: EventPayload<typeof mlsEvents.dealChanged>,
  meta: Pick<EventMeta, 'eventId' | 'agencyId' | 'createdAt'>,
): Promise<{ notified: number }> {
  return withSystem(`mls.notifyDeal: deal ${p.dealId}`, async (tx) => {
    const d = await dealChatContext(tx, p.dealId);
    if (!d) return { notified: 0 };
    const parties = [d.introducerAgencyId, d.ownerAgencyId];
    if (!parties.includes(meta.agencyId)) return { notified: 0 };
    const other = meta.agencyId === d.introducerAgencyId ? d.ownerAgencyId : d.introducerAgencyId;
    const agencyId = p.by === 'STAFF' ? meta.agencyId : other;
    const userIds = agencyId === d.introducerAgencyId ? d.introducerUserIds : d.ownerUserIds;
    if (userIds.length === 0) return { notified: 0 };
    const counterpart = agencyId === d.introducerAgencyId ? d.ownerAgencyId : d.introducerAgencyId;
    const names = p.by === 'STAFF' ? new Map<string, string>() : await agencies.directoryNamesOf(tx, [counterpart]);
    const res = await notifications.raiseNotifications(tx, {
      agencyId,
      type: 'DEAL_UPDATED',
      userIds,
      params: {
        actor: names.get(counterpart) ?? '',
        // an agency missing from the directory has no name to show: the message says "Deal updated" instead
        action: names.has(counterpart) || !NAMED.has(p.action) ? p.action : 'UPDATED',
        subject: d.subject ?? `#${p.dealId.slice(-8)}`,
        stage: d.stage,
      },
      link: dealLink(p.dealId),
      sourceKey: `${meta.eventId}:${agencyId}`,
      at: meta.createdAt,
    });
    return { notified: res.notified.length };
  });
}
