import { notificationText } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import * as notifications from '../notifications';
import * as leadsRepo from './leads-repo';

/**
 * S12-F2: `LEAD_ASSIGNED` — the member a lead was assigned to hears of it in-app (and in the e-mail digest), from
 * `crm.lead.created` (the agency's rule or the member entering it chose an assignee) and `crm.lead.updated` (a
 * reassignment). Raised by the `crm.notifyLeadAssigned` job after the commit, so the lead's own request pays nothing.
 *
 * - The member who made the assignment is left out (assigning a lead to yourself tells you nothing).
 * - A lead reassigned again before the job ran is not announced to the earlier assignee (the current one is checked).
 * - A website lead (`inbound`) is already mailed to its agent at once (website-api's lead e-mail): in-app only, so the
 *   digest does not mail it a second time.
 * - Idempotent: `sourceKey` = the event's id, `at` = its time — a redelivered event or a retried job raises nothing more.
 */
export async function notifyLeadAssigned(p: {
  eventId: string;
  agencyId: string;
  leadId: string;
  userId: string;
  assignedBy: string | null;
  inbound: boolean;
  occurredAt: string;
}): Promise<{ notified: number }> {
  return withSystem(`crm.notifyLeadAssigned: lead ${p.leadId}`, async (tx) => {
    const lead = await leadsRepo.leadNotice(tx, p.agencyId, p.leadId);
    if (!lead || lead.assignedUserId !== p.userId) return { notified: 0 };
    const name = [lead.firstName, lead.lastName].filter((v) => v?.trim()).join(' ');
    const subject = notificationText([name, lead.shownRef].filter(Boolean).join(' · ')) || lead.source;
    const res = await notifications.raiseNotifications(tx, {
      agencyId: p.agencyId,
      actorUserId: p.assignedBy,
      type: 'LEAD_ASSIGNED',
      userIds: [p.userId],
      params: { subject },
      link: `/inbox/${p.leadId}`,
      sourceKey: `crm.lead:${p.eventId}`,
      at: new Date(p.occurredAt),
      inAppOnly: p.inbound,
    });
    return { notified: res.notified.length };
  });
}
