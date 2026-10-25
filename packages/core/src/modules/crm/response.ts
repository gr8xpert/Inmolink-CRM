import { AppError, type ResponseTimeKpiDto, type ResponseTimeQuery } from '@inmolink/contracts';
import { withTenant } from '@inmolink/db';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import * as billing from '../billing';
import * as identity from '../identity';
import { crmEvents } from './events';
import { assertCan } from './policy';
import { mergeResponseParts } from './report-rollups';
import * as rollupsRepo from './report-rollups-repo';
import * as responseRepo from './response-repo';

/**
 * Response-time KPI (S10-09, PLAN §3 #60). Business-hours-agnostic in R1: wall-clock seconds from the lead reaching
 * the inbox (`created_at`) to its first human response.
 *
 * What is a human response (the crm service writes it in the transaction of the action, no trigger):
 *  - a logged e-mail, call or meeting on the lead (`logActivity`, at its `occurredAt`),
 *  - a status or stage change by a member (`updateLead`, `moveLead`; a reorder inside a column or an assignment is not).
 * The earliest one wins and the columns are set once (later ones leave them alone), so replays are harmless. The
 * system never responds: the automatic acknowledgement (`auto_ack_sent_at`), promotion and the activities written from
 * outbox events (`LEAD_CREATED`, `STAGE_CHANGED`) do not count. Attributed to the member who responded.
 */

/** Activity types that answer a lead (a viewing or a note does not). */
export const RESPONSE_ACTIVITY_TYPES: ReadonlySet<string> = new Set(['EMAIL', 'CALL', 'MEETING']);

/** The first-response columns' input for the acting member (`assertCan` has already refused non-members). */
export function humanResponseOf(ctx: Ctx, at: Date): { at: Date; userId: string } {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return { at, userId: ctx.actor.userId };
}

/**
 * A member logged an answer on a lead (one statement; when it became the lead's first response, a second:
 * `crm.lead.responded`, S11-F10 — the KPI rollup of the lead's day is rebuilt from it).
 */
export async function recordHumanResponse(ctx: Ctx, leadId: string, at: Date): Promise<void> {
  const r = humanResponseOf(ctx, at);
  const first = await responseRepo.applyHumanResponse(ctx.tx, ctx.tenant.agencyId, leadId, r.at, r.userId);
  if (first) {
    await emit(
      ctx.tx,
      crmEvents.leadResponded({ agencyId: ctx.tenant.agencyId, leadId, receivedMs: first.createdMs.getTime() }),
    );
  }
}

/**
 * `websiteApi.sendLeadAcknowledgement` sent the visitor's acknowledgement: remembered on the lead when it exists (a lead
 * promoted later copies it from the website lead; `at` null: the reservation was released, nothing went out). Never a human
 * response.
 */
export function recordAutoAck(p: { agencyId: string; inboundLeadId: string; at: Date | null }): Promise<number> {
  return withTenant({ agencyId: p.agencyId }, (tx) => responseRepo.applyAutoAck(tx, p.agencyId, p.inboundLeadId, p.at));
}

/**
 * `GET /v1/crm/kpis/response-time`: the agency's and each first responder's median response time for the leads
 * received in the range (≤ 92 days). Leads without a human response are counted but stay out of the medians. Two
 * queries (the numbers, the members' names). S11-F10: the range's whole UTC days come from `crm_response_rollups`
 * (every second kept, so the medians stay exact), the partial days at its ends straight from `leads`.
 */
export async function getResponseTimeKpi(ctx: Ctx, query: ResponseTimeQuery): Promise<ResponseTimeKpiDto> {
  assertCan(ctx, 'crm.leads.read');
  // S13-F21: reports are Standard and up (PLAN §11).
  await billing.requirePlan(ctx, 'reports_standard');
  const from = new Date(query.from);
  const to = new Date(query.to);
  const rows = mergeResponseParts(await rollupsRepo.responseKpiParts(ctx.tx, ctx.tenant.agencyId, from, to));
  const agency = rows.find((r) => r.userId === null);
  const agents = rows.filter((r) => r.userId !== null && r.responded > 0);
  const names = await identity.memberNames(
    ctx,
    agents.map((r) => r.userId as string),
  );
  agents.sort(
    (x, y) => (x.medianSeconds ?? 0) - (y.medianSeconds ?? 0) || (x.userId as string).localeCompare(y.userId as string),
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    leads: agency?.leads ?? 0,
    responded: agency?.responded ?? 0,
    medianSeconds: agency?.medianSeconds ?? null,
    avgSeconds: agency?.avgSeconds ?? null,
    agents: agents.map((r) => ({
      userId: r.userId as string,
      name: names.get(r.userId as string) ?? null,
      responded: r.responded,
      medianSeconds: r.medianSeconds,
      avgSeconds: r.avgSeconds,
    })),
  };
}
