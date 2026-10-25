import type { Tx } from '@inmolink/db';
import { contacts, leadIntroductions, leadRoutingSettings, leads, pipelineStages } from '@inmolink/db/schema/crm';
import { newId } from '@inmolink/platform/ids';
import { and, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';
import { DEFAULT_STAGES } from './pipeline-defaults';
import { stageWriteLock } from './report-rollups-repo';
import { humanResponseSet } from './response-repo';

/**
 * Lead queries (S10-02, PATTERNS §5): the holder's leads (STRICT), the owner's introductions (NETWORK_READ on
 * `owner_agency_id`, immutable), the agency's assignment rule. Queries only `@inmolink/db/schema/crm`. Lists page by
 * `rowAfter` / `rowOrder` (`keyset.ts`): index conditions under RLS.
 */

/** A lead's own columns (no contact). */
const ownColumns = {
  id: leads.id,
  agencyId: leads.agencyId,
  source: leads.source,
  kind: leads.kind,
  status: leads.status,
  stageId: leads.stageId,
  presentingAgencyId: leads.presentingAgencyId,
  ownerAgencyId: leads.ownerAgencyId,
  targetKind: leads.targetKind,
  targetId: leads.targetId,
  shownRef: leads.shownRef,
  locale: leads.locale,
  assignedUserId: leads.assignedUserId,
  assignedAt: leads.assignedAt,
  firstRespondedAt: leads.firstRespondedAt,
  createdAt: leads.createdAt,
  createdMs: leads.createdMs,
};
const leadColumns = {
  ...ownColumns,
  contactId: contacts.id,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactEmail: contacts.primaryEmail,
  contactPhone: contacts.primaryPhone,
};
const detailOwnColumns = {
  message: leads.message,
  visitorName: leads.visitorName,
  visitorEmail: leads.visitorEmail,
  visitorPhone: leads.visitorPhone,
  visitorMarketingConsent: leads.visitorMarketingConsent,
  inboundLeadId: leads.inboundLeadId,
  createdBy: leads.createdBy,
  version: leads.version,
  updatedAt: leads.updatedAt,
};
const detailColumns = { ...leadColumns, ...detailOwnColumns };

export interface LeadListRow {
  id: string;
  agencyId: string;
  source: string;
  kind: string;
  status: string;
  stageId: string;
  presentingAgencyId: string | null;
  ownerAgencyId: string | null;
  targetKind: string | null;
  targetId: string | null;
  shownRef: string | null;
  locale: string | null;
  assignedUserId: string | null;
  assignedAt: Date | null;
  firstRespondedAt: Date | null;
  createdAt: Date;
  createdMs: Date;
  contactId: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}
export interface LeadRow extends LeadListRow {
  message: string | null;
  visitorName: string | null;
  visitorEmail: string | null;
  visitorPhone: string | null;
  visitorMarketingConsent: boolean | null;
  inboundLeadId: string | null;
  createdBy: string | null;
  version: number;
  updatedAt: Date;
}

/** A new lead, with its stage, rank and entry time (`pipeline.entryStage`, `placement`). */
export type NewLead = Omit<typeof leads.$inferInsert, 'version' | 'createdAt' | 'updatedAt'> & { id: string };

/** Inserts a lead and answers the columns the database set (the caller builds the answer without reading it back). */
export async function insertLead(
  tx: Tx,
  row: NewLead,
): Promise<{ createdAt: Date; createdMs: Date; updatedAt: Date; version: number }> {
  const [out] = await tx.insert(leads).values(row).returning({
    createdAt: leads.createdAt,
    createdMs: leads.createdMs,
    updatedAt: leads.updatedAt,
    version: leads.version,
  });
  if (!out) throw new Error('lead insert returned no row');
  return out;
}

export async function insertIntroduction(tx: Tx, row: typeof leadIntroductions.$inferInsert): Promise<void> {
  await tx.insert(leadIntroductions).values(row);
}

/**
 * Serializes the promotion of one inbound lead until the transaction ends (a redelivered event's job and a retry never
 * both create the lead).
 */
export async function lockInbound(tx: Tx, inboundLeadId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`crm-lead-inbound:${inboundLeadId}`}, 0))`);
}

/** The lead promoted from this inbound lead (`leads_inbound_uq`). */
export async function leadIdByInbound(tx: Tx, agencyId: string, inboundLeadId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.inboundLeadId, inboundLeadId)));
  return row?.id ?? null;
}

/** The lead a member's earlier `POST` with the same `Idempotency-Key` created within `since`, with its body hash. */
export async function leadByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ id: string; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ id: leads.id, requestHash: leads.requestHash })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.idempotencyHash, hash), gt(leads.createdAt, since)));
  return row ?? null;
}

/**
 * One lead with its contact's summary (one query); `forUpdate` locks the lead row — and, first, takes the agency's
 * stage-write lock (S12-F6: a status change is a stage move the stage-count pass must not step over).
 */
export async function getLead(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<LeadRow | null> {
  const q = tx
    .select(opts.forUpdate ? { ...detailColumns, stageLock: stageWriteLock(leads.agencyId) } : detailColumns)
    .from(leads)
    .innerJoin(contacts, and(eq(contacts.agencyId, leads.agencyId), eq(contacts.id, leads.contactId)))
    .where(eq(leads.id, id));
  const [row] = opts.forUpdate ? await q.for('update', { of: leads }) : await q;
  return (row as LeadRow | undefined) ?? null;
}

export interface LeadListFilter {
  status?: string;
  /** One pipeline stage (S10-03, `leads_agency_stage_created_idx`). */
  stageId?: string;
  source?: string;
  /** A member's id, or null: unassigned leads. */
  assignedUserId?: string | null;
}

/**
 * The agency's inbox, newest first, with each lead's contact summary — one query. Keyset on
 * `leads_agency_created_idx`, `…_assigned_created_idx` (my / unassigned), `…_status_created_idx` or
 * `…_source_created_idx`; every condition (`=`, `is null`, the cursor's row comparison on plain columns) is leakproof,
 * so it stays an index condition under RLS.
 */
export async function listLeads(
  tx: Tx,
  agencyId: string,
  filter: LeadListFilter,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<LeadListRow[]> {
  return (await leadsPageQuery(tx, agencyId, filter, page)) as LeadListRow[];
}

/** The statement of `listLeads`, not yet run (the EXPLAIN tests run the repo's own query). */
export function leadsPageQuery(
  tx: Tx,
  agencyId: string,
  filter: LeadListFilter,
  page: { limit: number; cursor?: KeysetCursor },
) {
  const where: (SQL | undefined)[] = [eq(leads.agencyId, agencyId), rowAfter(leads.createdMs, leads.id, page.cursor)];
  if (filter.status) where.push(eq(leads.status, filter.status));
  if (filter.stageId) where.push(eq(leads.stageId, filter.stageId));
  if (filter.source) where.push(eq(leads.source, filter.source));
  if (filter.assignedUserId !== undefined) {
    where.push(
      filter.assignedUserId === null ? isNull(leads.assignedUserId) : eq(leads.assignedUserId, filter.assignedUserId),
    );
  }
  return tx
    .select(leadColumns)
    .from(leads)
    .innerJoin(contacts, and(eq(contacts.agencyId, leads.agencyId), eq(contacts.id, leads.contactId)))
    .where(and(...where))
    .orderBy(...rowOrder(leads.createdMs, leads.id))
    .limit(page.limit + 1);
}

export async function updateLeadWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<typeof leads.$inferInsert>,
  response?: { at: Date; userId: string },
): Promise<{ id: string; version: number } | null> {
  const [row] = await tx
    .update(leads)
    .set({
      ...patch,
      ...(response ? humanResponseSet(response.at, response.userId) : {}),
      version: sql`${leads.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(leads.id, id), eq(leads.version, version)))
    .returning({ id: leads.id, version: leads.version });
  return row ?? null;
}

// ---- introductions (the owner's side) ------------------------------------------------------------------------------

const introductionColumns = {
  leadId: leadIntroductions.leadId,
  agencyId: leadIntroductions.agencyId,
  source: leadIntroductions.source,
  kind: leadIntroductions.kind,
  targetKind: leadIntroductions.targetKind,
  targetId: leadIntroductions.targetId,
  handEntered: leadIntroductions.handEntered,
  createdAt: leadIntroductions.createdAt,
  createdMs: leadIntroductions.createdMs,
};
export type IntroductionRow = { [K in keyof typeof introductionColumns]: (typeof leadIntroductions.$inferSelect)[K] };

/**
 * Introductions to `ownerAgencyId` (the caller), newest first: keyset on `lead_introductions_owner_created_idx`
 * (`owner_agency_id = ?` is leakproof: an index condition under RLS).
 */
export async function listIntroductions(
  tx: Tx,
  ownerAgencyId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<IntroductionRow[]> {
  return tx
    .select(introductionColumns)
    .from(leadIntroductions)
    .where(
      and(
        eq(leadIntroductions.ownerAgencyId, ownerAgencyId),
        rowAfter(leadIntroductions.createdMs, leadIntroductions.leadId, page.cursor),
      ),
    )
    .orderBy(...rowOrder(leadIntroductions.createdMs, leadIntroductions.leadId))
    .limit(page.limit + 1);
}

// ---- assignment rule ------------------------------------------------------------------------------------------------

export interface RoutingRow {
  mode: string;
  agentUserIds: string[];
  lastAssignedUserId: string | null;
  version: number;
}

/** The agency's rule; `forUpdate` locks it (assignments advance `last_assigned_user_id` one lead at a time). */
export async function getRouting(
  tx: Tx,
  agencyId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<RoutingRow | null> {
  const q = tx
    .select({
      mode: leadRoutingSettings.mode,
      agentUserIds: leadRoutingSettings.agentUserIds,
      lastAssignedUserId: leadRoutingSettings.lastAssignedUserId,
      version: leadRoutingSettings.version,
    })
    .from(leadRoutingSettings)
    .where(eq(leadRoutingSettings.agencyId, agencyId));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

/**
 * Writes the rule at `version` (0: the agency has none yet), one statement; null when `version` is stale (or a
 * concurrent first write won).
 */
export async function saveRouting(
  tx: Tx,
  agencyId: string,
  version: number,
  rule: { mode: string; agentUserIds: string[] },
): Promise<RoutingRow | null> {
  const returning = {
    mode: leadRoutingSettings.mode,
    agentUserIds: leadRoutingSettings.agentUserIds,
    lastAssignedUserId: leadRoutingSettings.lastAssignedUserId,
    version: leadRoutingSettings.version,
  };
  if (version === 0) {
    const [row] = await tx
      .insert(leadRoutingSettings)
      .values({ agencyId, mode: rule.mode, agentUserIds: rule.agentUserIds })
      .onConflictDoNothing()
      .returning(returning);
    return row ?? null;
  }
  const [row] = await tx
    .update(leadRoutingSettings)
    .set({
      mode: rule.mode,
      agentUserIds: rule.agentUserIds,
      version: sql`${leadRoutingSettings.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(leadRoutingSettings.agencyId, agencyId), eq(leadRoutingSettings.version, version)))
    .returning(returning);
  return row ?? null;
}

/**
 * What receiving a lead starts from, in one statement: the holder's entry stage (`NEW`) — seeding its default stages
 * (`DEFAULT_STAGES`) when it has none — and its assignment rule (unlocked). `stageId` is null only when a concurrent
 * first seed won (its rows are not in this statement's snapshot): the caller reads the stage again.
 */
export async function entryStageAndRule(
  tx: Tx,
  agencyId: string,
): Promise<{ stageId: string | null; rule: RoutingRow | null }> {
  const values = sql.join(
    DEFAULT_STAGES.map((key, position) => sql`(${newId()}::uuid, ${key}, ${position}::int)`),
    sql`, `,
  );
  const res = await tx.execute<{
    stage_id: string | null;
    mode: string | null;
    agent_user_ids: string[] | null;
    last_assigned_user_id: string | null;
    version: number | null;
  }>(sql`
    with seeded as (
      insert into ${pipelineStages} (id, agency_id, seed_key, status, position)
      select d.id, ${agencyId}::uuid, d.k, d.k, d.pos from (values ${values}) as d(id, k, pos)
       where not exists (select 1 from ${pipelineStages} e where e.agency_id = ${agencyId})
      on conflict do nothing
      returning id, status
    ),
    entry as (
      select id from seeded where status = 'NEW'
      union all
      select id from ${pipelineStages} where agency_id = ${agencyId} and status = 'NEW'
      limit 1
    )
    select (select id from entry) as stage_id, r.mode, r.agent_user_ids, r.last_assigned_user_id, r.version,
           ${stageWriteLock(sql`${agencyId}::uuid`)} as stage_lock
      from (values (1)) as one(x)
      left join ${leadRoutingSettings} r on r.agency_id = ${agencyId}`);
  const row = res.rows[0];
  return {
    stageId: row?.stage_id ? String(row.stage_id) : null,
    rule:
      row?.mode != null
        ? {
            mode: row.mode,
            agentUserIds: (row.agent_user_ids ?? []).map(String),
            lastAssignedUserId: row.last_assigned_user_id ? String(row.last_assigned_user_id) : null,
            version: Number(row.version),
          }
        : null,
  };
}

/** The round robin's position after an assignment (the row is locked by the caller). */
export async function setLastAssigned(tx: Tx, agencyId: string, userId: string): Promise<void> {
  await tx
    .update(leadRoutingSettings)
    .set({ lastAssignedUserId: userId })
    .where(eq(leadRoutingSettings.agencyId, agencyId));
}

/**
 * S12-F2: what a `LEAD_ASSIGNED` notification shows (system role, the agency named): the current assignee and
 * version, the contact's name and the reference shown. One statement.
 */
export async function leadNotice(
  tx: Tx,
  agencyId: string,
  id: string,
): Promise<{
  assignedUserId: string | null;
  version: number;
  source: string;
  shownRef: string | null;
  firstName: string | null;
  lastName: string | null;
} | null> {
  const [row] = await tx
    .select({
      assignedUserId: leads.assignedUserId,
      version: leads.version,
      source: leads.source,
      shownRef: leads.shownRef,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(leads)
    .innerJoin(contacts, and(eq(contacts.agencyId, leads.agencyId), eq(contacts.id, leads.contactId)))
    .where(and(eq(leads.agencyId, agencyId), eq(leads.id, id)));
  return row ?? null;
}
