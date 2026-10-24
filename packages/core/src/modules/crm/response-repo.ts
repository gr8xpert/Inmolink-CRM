import type { Tx } from '@inmolink/db';
import { leads } from '@inmolink/db/schema/crm';
import { and, eq, type SQL, sql } from 'drizzle-orm';

/**
 * The columns of a lead's first human response (S10-09), as the `SET` of an `UPDATE leads`: the earliest response wins
 * and later ones leave the row alone, so the statement is idempotent and can ride on any write that is itself a
 * response (a stage change) without a read first. An answer dated before the lead reached the inbox can only be a wrong
 * date: it is taken as given when it was logged (`now()`), so `response_seconds` is never negative or 0 by back-dating and
 * such an entry cannot displace a real earlier response (trade-off: the true time of that answer is not kept).
 */
export function humanResponseSet(at: Date, userId: string): Record<string, SQL> {
  const eff = effectiveAt(at);
  const earlier = isEarlierResponse(at);
  return {
    firstHumanResponseAt: sql`case when ${earlier} then ${eff} else ${leads.firstHumanResponseAt} end`,
    firstResponderUserId: sql`case when ${earlier} then ${userId}::uuid else ${leads.firstResponderUserId} end`,
    responseSeconds: sql`case when ${earlier}
      then floor(extract(epoch from (${eff} - ${leads.createdAt})))::int
      else ${leads.responseSeconds} end`,
  };
}

/** The response time `at` stands for: `now()` when it is dated before the lead reached the inbox. */
const effectiveAt = (at: Date): SQL =>
  sql`(case when ${at.toISOString()}::timestamptz < ${leads.createdAt} then now() else ${at.toISOString()}::timestamptz end)`;

/** True when a response at `at` displaces the lead's first one (none yet, or a later one). */
const isEarlierResponse = (at: Date): SQL =>
  sql`(${leads.firstHumanResponseAt} is null or ${leads.firstHumanResponseAt} > ${effectiveAt(at)})`;

/**
 * A member logged a reply / call / meeting on the lead: its first human response unless an earlier one stands. The
 * lead's receipt time (`created_ms`) when it became the first response (S11-F10: the KPI rollup of that day is
 * rebuilt), null when an earlier one stands. One statement.
 */
export async function applyHumanResponse(
  tx: Tx,
  agencyId: string,
  leadId: string,
  at: Date,
  userId: string,
): Promise<{ createdMs: Date } | null> {
  const [row] = await tx
    .update(leads)
    .set(humanResponseSet(at, userId))
    .where(and(eq(leads.agencyId, agencyId), eq(leads.id, leadId), isEarlierResponse(at)))
    .returning({ createdMs: leads.createdMs });
  return row ?? null;
}

/** The visitor's automatic acknowledgement went out at `at` (no-op while the website lead is not promoted yet). */
export async function applyAutoAck(tx: Tx, agencyId: string, inboundLeadId: string, at: Date | null): Promise<number> {
  const rows = await tx
    .update(leads)
    .set({ autoAckSentAt: at })
    .where(and(eq(leads.agencyId, agencyId), eq(leads.inboundLeadId, inboundLeadId)))
    .returning({ id: leads.id });
  return rows.length;
}
