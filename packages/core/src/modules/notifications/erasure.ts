import { withSystem } from '@inmolink/db';
import { notificationPreferences, notifications } from '@inmolink/db/schema/notifications';
import { and, eq, inArray, like, or, type SQL, sql } from 'drizzle-orm';

/**
 * Erasure, the notifications side (S16-04 review). A notification's `params` carry display values for its message — a
 * lead's contact name, a task's title — so an erased person's name can sit in members' feeds:
 *
 * - `redactNotifications` (contact erasure, `crm.eraseContactData`): the agency's notifications that open one of the
 *   erased contact's leads (`link`) or were raised for one of its tasks (`source_key` prefix) lose their `params` (the
 *   feed shows the type's message without a subject). Ids, types, times and read states stay.
 * - `deleteAgencyNotifications` (agency erasure): every notification and preference of the agency, a batch at a time.
 *
 * Worker-only (`withSystem`, the agency an explicit predicate). Idempotent.
 */

/** Rows per statement. */
const BATCH = 1_000;

export async function redactNotifications(p: {
  agencyId: string;
  links: readonly string[];
  sourceKeyPrefixes: readonly string[];
}): Promise<{ rows: number }> {
  if (p.links.length === 0 && p.sourceKeyPrefixes.length === 0) return { rows: 0 };
  const of: SQL[] = [];
  if (p.links.length > 0) of.push(inArray(notifications.link, [...p.links]));
  for (const prefix of p.sourceKeyPrefixes)
    of.push(like(notifications.sourceKey, `${prefix.replace(/[%_\\]/g, '\\$&')}%`));
  const rows = await withSystem('notifications.redactNotifications', (tx) =>
    tx
      .update(notifications)
      .set({ params: sql`'{}'::jsonb` })
      .where(and(eq(notifications.agencyId, p.agencyId), or(...of), sql`${notifications.params} <> '{}'::jsonb`))
      .returning({ id: notifications.id }),
  );
  return { rows: rows.length };
}

/** One batch of the agency's notifications (and, once they are gone, its preferences) deleted; `more`: call again. */
export async function deleteAgencyNotifications(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('notifications.deleteAgencyNotifications', async (tx) => {
    const res = await tx.execute(sql`
      delete from ${notifications} where agency_id = ${p.agencyId}
        and (id, created_at) in (select id, created_at from ${notifications} where agency_id = ${p.agencyId} limit ${BATCH})
      returning 1`);
    const rows = res.rows.length;
    if (rows < BATCH) {
      await tx.delete(notificationPreferences).where(eq(notificationPreferences.agencyId, p.agencyId));
    }
    return { rows, more: rows === BATCH };
  });
}
