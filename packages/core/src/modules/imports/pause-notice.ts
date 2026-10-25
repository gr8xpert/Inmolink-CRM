import { notificationText } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import * as identity from '../identity';
import * as notifications from '../notifications';
import * as repo from './repo';

/**
 * S12-F2: the agency hears that the anomaly guard paused one of its feed connections (S6-08 / S7-F1): one
 * `IMPORT_PAUSED` notification to each of its active admins (they resume it — "accept the change" — or fix the
 * feed), in-app and in the e-mail digest. Raised by the `imports.notifyConnectionPaused` job from
 * `imports.connection.paused`, in its own system transaction (the run's transaction stays as it was). Idempotent:
 * `sourceKey` = the event's id, `at` = its time. A connection deleted or resumed before the job ran is not announced,
 * nor a pause that a later one replaced (resumed and paused again: `paused_at` is later than the event — the same
 * transaction's `now()` otherwise).
 */
export async function notifyConnectionPaused(p: {
  eventId: string;
  agencyId: string;
  connectionId: string;
  occurredAt: string;
}): Promise<{ notified: number }> {
  return withSystem(`imports.notifyConnectionPaused: connection ${p.connectionId}`, async (tx) => {
    const connection = await repo.getConnection(tx, p.connectionId);
    if (!connection || connection.agencyId !== p.agencyId || !connection.pausedAt) return { notified: 0 };
    // resumed and paused again before this job ran: the later pause's own event announces it (once)
    if (connection.pausedAt.getTime() > new Date(p.occurredAt).getTime()) return { notified: 0 };
    const admins = (await identity.agencyAdminsOf(tx, [p.agencyId])).get(p.agencyId) ?? [];
    if (admins.length === 0) return { notified: 0 };
    const res = await notifications.raiseNotifications(tx, {
      agencyId: p.agencyId,
      type: 'IMPORT_PAUSED',
      userIds: admins,
      params: { subject: notificationText(connection.name) || connection.connector },
      link: `/imports/${p.connectionId}`,
      sourceKey: `imports.paused:${p.eventId}`,
      at: new Date(p.occurredAt),
    });
    return { notified: res.notified.length };
  });
}
