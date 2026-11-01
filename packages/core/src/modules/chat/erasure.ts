import { withSystem } from '@inmolink/db';
import { chatMessages, chatParticipants, chatThreads } from '@inmolink/db/schema/chat';
import { sql } from 'drizzle-orm';

/** Rows per statement. */
const BATCH = 1_000;

/**
 * Agency erasure, the chat side (S16-04 review; S16-F5: the full tenant purge): one batch of the agency's own copies of
 * chat messages deleted (the other agency's copies are its own correspondence records); once none is left, a batch of
 * the agency's thread copies goes with their participants (the inbox rows) — nothing of the agency's chat stays.
 * Worker-only (`app_system`: no request deletes a message). `more`: call again. Idempotent.
 */
export async function eraseAgencyChat(p: { agencyId: string }): Promise<{ rows: number; more: boolean }> {
  return withSystem('chat.eraseAgencyChat', async (tx) => {
    const res = await tx.execute(sql`
      delete from ${chatMessages} where agency_id = ${p.agencyId} and id in (
        select id from ${chatMessages} where agency_id = ${p.agencyId} limit ${BATCH})
      returning 1`);
    const messages = res.rows.length;
    if (messages === BATCH) return { rows: messages, more: true };
    // one statement: a batch of threads and their participants (FK (agency_id, thread_id))
    const threads = await tx.execute(sql`
      with t as (select id from ${chatThreads} where agency_id = ${p.agencyId} order by id limit ${BATCH}),
        pa as (delete from ${chatParticipants} cp using t
                where cp.agency_id = ${p.agencyId} and cp.thread_id = t.id returning 1)
      delete from ${chatThreads} th using t
       where th.agency_id = ${p.agencyId} and th.id = t.id
      returning 1`);
    const n = threads.rows.length;
    return { rows: messages + n, more: n === BATCH };
  });
}
