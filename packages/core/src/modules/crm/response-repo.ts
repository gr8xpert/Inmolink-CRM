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
  const eff = sql`(case when ${at.toISOString()}::timestamptz < ${leads.createdAt} then now() else ${at.toISOString()}::timestamptz end)`;
  const earlier = sql`(${leads.firstHumanResponseAt} is null or ${leads.firstHumanResponseAt} > ${eff})`;
  return {
    firstHumanResponseAt: sql`case when ${earlier} then ${eff} else ${leads.firstHumanResponseAt} end`,
    firstResponderUserId: sql`case when ${earlier} then ${userId}::uuid else ${leads.firstResponderUserId} end`,
    responseSeconds: sql`case when ${earlier}
      then floor(extract(epoch from (${eff} - ${leads.createdAt})))::int
      else ${leads.responseSeconds} end`,
  };
}

/** A member logged a reply / call / meeting on the lead: its first human response unless an earlier one stands. */
export async function applyHumanResponse(tx: Tx, agencyId: string, leadId: string, at: Date, userId: string) {
  await tx
    .update(leads)
    .set(humanResponseSet(at, userId))
    .where(and(eq(leads.agencyId, agencyId), eq(leads.id, leadId)));
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

export interface ResponseAggregate {
  /** Null: the whole agency. */
  userId: string | null;
  leads: number;
  responded: number;
  medianSeconds: number | null;
  avgSeconds: number | null;
}

/**
 * One statement, index-only on `leads_agency_response_idx`: for the leads received in `[from, to)` the count, the
 * answered count and the median / mean seconds — for the agency (one row) and per first responder (rows with a user).
 * Leads whose responder is unknown (backfilled) count in the agency row only.
 */
export function responseAggregatesQuery(agencyId: string, from: Date, to: Date): SQL {
  return sql`
    select first_responder_user_id as user_id, grouping(first_responder_user_id) as agency_row,
           count(*)::int as leads, count(response_seconds)::int as responded,
           percentile_cont(0.5) within group (order by response_seconds) as median,
           avg(response_seconds) as avg
      from ${leads}
     where agency_id = ${agencyId} and source <> 'MANUAL' and created_ms >= ${from.toISOString()}::timestamptz
       and created_ms < ${to.toISOString()}::timestamptz
     group by grouping sets ((), (first_responder_user_id))`;
}

export async function responseAggregates(tx: Tx, agencyId: string, from: Date, to: Date): Promise<ResponseAggregate[]> {
  const res = await tx.execute(responseAggregatesQuery(agencyId, from, to));
  const rows = res.rows as {
    user_id: string | null;
    agency_row: number;
    leads: number;
    responded: number;
    median: string | number | null;
    avg: string | number | null;
  }[];
  const num = (v: string | number | null) => (v === null ? null : Math.round(Number(v)));
  return rows
    .filter((r) => r.agency_row === 1 || r.user_id !== null)
    .map((r) => ({
      userId: r.agency_row === 1 ? null : r.user_id,
      leads: r.leads,
      responded: r.responded,
      medianSeconds: num(r.median),
      avgSeconds: num(r.avg),
    }));
}
