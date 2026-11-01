import { withSystem } from '@inmolink/db';
import { chatMessages, chatThreads } from '@inmolink/db/schema/chat';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

/** Messages per statement. */
const BATCH = 1_000;

/**
 * Agency erasure, the chat side (S16-04 review): one batch of the agency's own copies of chat messages deleted (the
 * other agency's copies are its own correspondence records); once none is left, the agency's thread copies lose their
 * titles and subjects. Ids, kinds, participants and times stay. Worker-only (`app_system`: no request deletes a
 * message). `more`: call again. Idempotent.
 */
export async function eraseAgencyChat(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('chat.eraseAgencyChat', async (tx) => {
    const res = await tx.execute(sql`
      delete from ${chatMessages} where agency_id = ${p.agencyId} and id in (
        select id from ${chatMessages} where agency_id = ${p.agencyId} limit ${BATCH})
      returning 1`);
    let rows = res.rows.length;
    if (rows < BATCH) {
      const threads = await tx
        .update(chatThreads)
        .set({ title: null, subject: null })
        .where(
          and(eq(chatThreads.agencyId, p.agencyId), or(isNotNull(chatThreads.title), isNotNull(chatThreads.subject))),
        )
        .returning({ id: chatThreads.id });
      rows += threads.length;
    }
    return { rows, more: res.rows.length === BATCH };
  });
}
