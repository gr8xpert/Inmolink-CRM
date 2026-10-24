import type { Tx } from '@inmolink/db';
import { contacts, leadStageHistory, leads, pipelineStages } from '@inmolink/db/schema/crm';
import { newId } from '@inmolink/platform/ids';
import { and, asc, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import type { KeysetCursor } from '../../pagination';
import { rowAfter, rowOrder } from './keyset';
import type { LeadListRow } from './leads-repo';
import { DEFAULT_STAGES } from './pipeline-defaults';
import { humanResponseSet } from './response-repo';

/**
 * Pipeline queries (S10-03): the agency's stages, the board (one query for every column), a drag's neighbours and
 * write, a lead's stage history (the report reads rollups: `report-rollups-repo.ts`). Queries only `@inmolink/db/schema/crm`. The stage history
 * is appended by the database (`leads_stage_history` → `lead_stage_history_append()`) from the stage and entry time
 * the service writes, never here.
 */

export { DEFAULT_STAGES } from './pipeline-defaults';

const stageColumns = {
  id: pipelineStages.id,
  agencyId: pipelineStages.agencyId,
  seedKey: pipelineStages.seedKey,
  name: pipelineStages.name,
  status: pipelineStages.status,
  kind: pipelineStages.kind,
  position: pipelineStages.position,
  archivedAt: pipelineStages.archivedAt,
  version: pipelineStages.version,
};
export interface StageRow {
  id: string;
  agencyId: string;
  seedKey: string | null;
  name: string | null;
  status: string;
  kind: string;
  position: number;
  archivedAt: Date | null;
  version: number;
}

/** The agency's stages: the active ones in board order, then (with `archived`) the archived ones. One query. */
export async function listStages(tx: Tx, agencyId: string, opts: { archived?: boolean } = {}): Promise<StageRow[]> {
  return tx
    .select(stageColumns)
    .from(pipelineStages)
    .where(and(eq(pipelineStages.agencyId, agencyId), opts.archived ? undefined : isNull(pipelineStages.archivedAt)))
    .orderBy(sql`${pipelineStages.archivedAt} is not null`, asc(pipelineStages.position), asc(pipelineStages.id));
}

/** Seeds the default stages (an agency that has none yet); a no-op when they exist. One statement. */
export async function seedStages(tx: Tx, agencyId: string): Promise<void> {
  await tx
    .insert(pipelineStages)
    .values(DEFAULT_STAGES.map((key, position) => ({ id: newId(), agencyId, seedKey: key, status: key, position })))
    .onConflictDoNothing();
}

/**
 * A stage by id; `lock` `share` keeps it from being archived until the transaction ends (a move into it), `update`
 * serializes its own changes (an archive waits for the moves into it).
 */
export async function getStage(tx: Tx, id: string, opts: { lock?: 'share' | 'update' } = {}): Promise<StageRow | null> {
  const q = tx.select(stageColumns).from(pipelineStages).where(eq(pipelineStages.id, id));
  const [row] = opts.lock ? await q.for(opts.lock) : await q;
  return row ?? null;
}

/**
 * The agency's first active stage standing for `status` (a status set through `PATCH /v1/crm/leads/:id`), locked
 * `FOR SHARE` (a concurrent archive waits, then finds the lead in it).
 */
export async function stageForStatus(tx: Tx, agencyId: string, status: string): Promise<StageRow | null> {
  const [row] = await tx
    .select(stageColumns)
    .from(pipelineStages)
    .where(
      and(eq(pipelineStages.agencyId, agencyId), eq(pipelineStages.status, status), isNull(pipelineStages.archivedAt)),
    )
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.id))
    .limit(1)
    .for('share');
  return row ?? null;
}

/** The stage an admin's earlier `POST` with the same `Idempotency-Key` created within `since`, with its body hash. */
export async function stageByIdempotency(
  tx: Tx,
  agencyId: string,
  hash: string,
  since: Date,
): Promise<{ id: string; requestHash: string | null } | null> {
  const [row] = await tx
    .select({ id: pipelineStages.id, requestHash: pipelineStages.requestHash })
    .from(pipelineStages)
    .where(
      and(
        eq(pipelineStages.agencyId, agencyId),
        eq(pipelineStages.idempotencyHash, hash),
        gt(pipelineStages.createdAt, since),
      ),
    );
  return row ?? null;
}

export async function insertStage(tx: Tx, row: typeof pipelineStages.$inferInsert): Promise<StageRow> {
  const [out] = await tx.insert(pipelineStages).values(row).returning(stageColumns);
  if (!out) throw new Error('stage insert returned no row');
  return out;
}

export async function updateStageWithVersion(
  tx: Tx,
  id: string,
  version: number,
  patch: Partial<typeof pipelineStages.$inferInsert>,
): Promise<StageRow | null> {
  const [row] = await tx
    .update(pipelineStages)
    .set({ ...patch, version: sql`${pipelineStages.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(pipelineStages.id, id), eq(pipelineStages.version, version)))
    .returning(stageColumns);
  return row ?? null;
}

/** Writes the active stages' positions in one statement (`ids` in order; the caller checked they are all of them). */
export async function setPositions(tx: Tx, agencyId: string, ids: readonly string[]): Promise<void> {
  const values = sql.join(
    ids.map((id, i) => sql`(${id}::uuid, ${i}::int)`),
    sql`, `,
  );
  await tx.execute(sql`
    update ${pipelineStages} s
       set position = v.pos, version = s.version + 1, updated_at = now()
      from (values ${values}) as v(id, pos)
     where s.agency_id = ${agencyId} and s.id = v.id and s.position is distinct from v.pos`);
}

/** Whether any lead is in the stage (index-only on `leads_agency_stage_rank_idx`). */
export async function stageHasLeads(tx: Tx, agencyId: string, stageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.stageId, stageId)))
    .limit(1);
  return row !== undefined;
}

// ---- the board ------------------------------------------------------------------------------------------------------

/** A card: the inbox row and where it stands. */
export interface CardRow extends LeadListRow {
  stageId: string;
  stageRank: string;
  stageEnteredAt: Date;
  version: number;
}

const cardColumns = {
  id: leads.id,
  agencyId: leads.agencyId,
  source: leads.source,
  kind: leads.kind,
  status: leads.status,
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
  stageId: leads.stageId,
  stageRank: leads.stageRank,
  stageEnteredAt: leads.stageEnteredAt,
  version: leads.version,
  contactId: contacts.id,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactEmail: contacts.primaryEmail,
  contactPhone: contacts.primaryPhone,
};

/** `assigned` as a condition on `leads` (`undefined`: everyone's). Leakproof `=` / `is null`: index conditions. */
function assignedCondition(assigned: string | null | undefined, alias?: string): SQL | undefined {
  if (assigned === undefined) return undefined;
  const col = alias
    ? sql`${sql.identifier(alias)}.${sql.identifier('assigned_user_id')}`
    : sql`${leads.assignedUserId}`;
  return assigned === null ? sql`${col} is null` : sql`${col} = ${assigned}::uuid`;
}

/**
 * Every active column's first `limit + 1` cards, board order — one query: a lateral page per stage on
 * `leads_agency_stage_rank_idx` (or `…_assigned_rank_idx` with `assigned`), the contact joined after the page.
 */
export async function boardCards(
  tx: Tx,
  agencyId: string,
  assigned: string | null | undefined,
  limit: number,
): Promise<CardRow[]> {
  const filter = assignedCondition(assigned, 'l');
  const res = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.agency_id, p.source, p.kind, p.status, p.presenting_agency_id, p.owner_agency_id, p.target_kind,
           p.target_id, p.shown_ref, p.locale, p.assigned_user_id, p.assigned_at, p.first_responded_at, p.created_at,
           p.created_ms, p.stage_id, p.stage_rank, p.stage_entered_at, p.version,
           c.id as contact_id, c.first_name, c.last_name, c.primary_email, c.primary_phone
      from ${pipelineStages} s
     cross join lateral (
       select l.id, l.agency_id, l.contact_id, l.source, l.kind, l.status, l.presenting_agency_id, l.owner_agency_id,
              l.target_kind, l.target_id, l.shown_ref, l.locale, l.assigned_user_id, l.assigned_at,
              l.first_responded_at, l.created_at, l.created_ms, l.stage_id, l.stage_rank, l.stage_entered_at, l.version
         from ${leads} l
        where l.agency_id = ${agencyId} and l.stage_id = s.id ${filter ? sql`and ${filter}` : sql``}
        order by l.stage_rank, l.id
        limit ${limit + 1}
     ) p
      join ${contacts} c on c.agency_id = p.agency_id and c.id = p.contact_id
     where s.agency_id = ${agencyId} and s.archived_at is null`);
  return res.rows.map(cardFromRaw);
}

const dateOf = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : dateOf(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function cardFromRaw(r: Record<string, unknown>): CardRow {
  return {
    id: String(r.id),
    agencyId: String(r.agency_id),
    source: String(r.source),
    kind: String(r.kind),
    status: String(r.status),
    presentingAgencyId: str(r.presenting_agency_id),
    ownerAgencyId: str(r.owner_agency_id),
    targetKind: str(r.target_kind),
    targetId: str(r.target_id),
    shownRef: str(r.shown_ref),
    locale: str(r.locale),
    assignedUserId: str(r.assigned_user_id),
    assignedAt: dateOrNull(r.assigned_at),
    firstRespondedAt: dateOrNull(r.first_responded_at),
    createdAt: dateOf(r.created_at),
    createdMs: dateOf(r.created_ms),
    stageId: String(r.stage_id),
    stageRank: String(r.stage_rank),
    stageEnteredAt: dateOf(r.stage_entered_at),
    version: Number(r.version),
    contactId: String(r.contact_id),
    contactFirstName: str(r.first_name),
    contactLastName: str(r.last_name),
    contactEmail: str(r.primary_email),
    contactPhone: str(r.primary_phone),
  };
}

/**
 * Leads per active stage (with `assigned`), each counted up to `cap` (a bounded index-only probe per stage on the board
 * indexes, whatever the size of the agency's history). One query.
 */
export async function stageCounts(
  tx: Tx,
  agencyId: string,
  assigned: string | null | undefined,
  cap: number,
): Promise<Map<string, number>> {
  const filter = assignedCondition(assigned, 'l');
  const res = await tx.execute<{ stage_id: string; n: number }>(sql`
    select s.id as stage_id, (
      select count(*)::int from (
        select 1 from ${leads} l
         where l.agency_id = ${agencyId} and l.stage_id = s.id ${filter ? sql`and ${filter}` : sql``}
         limit ${cap}
      ) x
    ) as n
      from ${pipelineStages} s
     where s.agency_id = ${agencyId} and s.archived_at is null`);
  return new Map(res.rows.map((r) => [String(r.stage_id), Number(r.n)]));
}

/** A column cursor: the last card's rank and id. */
export interface RankCursor {
  rank: string;
  id: string;
}

/** One column after `cursor`, board order (`(stage_rank, id) > (?, ?)`: an index condition under RLS). */
export async function columnCards(
  tx: Tx,
  agencyId: string,
  stageId: string,
  assigned: string | null | undefined,
  page: { limit: number; cursor?: RankCursor },
): Promise<CardRow[]> {
  const rows = await tx
    .select(cardColumns)
    .from(leads)
    .innerJoin(contacts, and(eq(contacts.agencyId, leads.agencyId), eq(contacts.id, leads.contactId)))
    .where(
      and(
        eq(leads.agencyId, agencyId),
        eq(leads.stageId, stageId),
        assignedCondition(assigned),
        page.cursor
          ? sql`(${leads.stageRank}, ${leads.id}) > (${page.cursor.rank}, ${page.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(leads.stageRank), asc(leads.id))
    .limit(page.limit + 1);
  return rows as CardRow[];
}

/** One card (the answer of a drag). One query. */
export async function card(tx: Tx, id: string): Promise<CardRow | null> {
  const [row] = await tx
    .select(cardColumns)
    .from(leads)
    .innerJoin(contacts, and(eq(contacts.agencyId, leads.agencyId), eq(contacts.id, leads.contactId)))
    .where(eq(leads.id, id));
  return (row as CardRow | undefined) ?? null;
}

// ---- a drag ---------------------------------------------------------------------------------------------------------

/** A lead's version, stage and rank, locked (the drag's row). */
export async function lockLead(
  tx: Tx,
  id: string,
): Promise<{
  id: string;
  agencyId: string;
  version: number;
  status: string;
  stageId: string;
  firstRespondedAt: Date | null;
  createdMs: Date;
} | null> {
  const [row] = await tx
    .select({
      id: leads.id,
      agencyId: leads.agencyId,
      version: leads.version,
      status: leads.status,
      stageId: leads.stageId,
      firstRespondedAt: leads.firstRespondedAt,
      createdMs: leads.createdMs,
    })
    .from(leads)
    .where(eq(leads.id, id))
    .for('update');
  return row ?? null;
}

/**
 * The keys around a drop right after `afterId` in a column — that lead's `(rank, id)` (`found` false when it is not in
 * the column) and the next card's rank in board order `(stage_rank, id)`, the moved lead left out — or, with `afterId`
 * null, the column's first rank. One query (index probes on `leads_agency_stage_rank_idx`). An `upper` equal to `lower`
 * (two cards share a rank) leaves no key between them: the caller rebalances the column.
 */
export async function dropGap(
  tx: Tx,
  agencyId: string,
  stageId: string,
  afterId: string | null,
  movedId: string,
): Promise<{ found: boolean; lower: string; upper: string | null }> {
  if (afterId === null) {
    const [row] = await tx
      .select({ rank: leads.stageRank })
      .from(leads)
      .where(and(eq(leads.agencyId, agencyId), eq(leads.stageId, stageId), sql`${leads.id} <> ${movedId}::uuid`))
      .orderBy(asc(leads.stageRank), asc(leads.id))
      .limit(1);
    return { found: true, lower: '', upper: row?.rank ?? null };
  }
  const res = await tx.execute<{ lower: string | null; upper: string | null }>(sql`
    with a as (
      select stage_rank, id from ${leads}
       where agency_id = ${agencyId} and stage_id = ${stageId}::uuid and id = ${afterId}::uuid
    )
    select (select stage_rank from a) as lower,
           (select l.stage_rank from ${leads} l, a
             where l.agency_id = ${agencyId} and l.stage_id = ${stageId}::uuid and l.id <> ${movedId}::uuid
               and (l.stage_rank, l.id) > (a.stage_rank, a.id)
             order by l.stage_rank, l.id limit 1) as upper`);
  const row = res.rows[0];
  if (!row?.lower) return { found: false, lower: '', upper: null };
  return { found: true, lower: row.lower, upper: row.upper };
}

/** Rows a rebalance re-ranks at most (a column larger than this keeps its keys: the drop is refused). */
export const REBALANCE_MAX = 10_000;

/**
 * Re-ranks a column in its board order (`(stage_rank, id)`) with short evenly spaced keys (`keys[i]`), the moved lead
 * left out — when a drop finds no key between its neighbours (shared ranks, or the length cap). Two statements: the
 * column's ids (≤ `REBALANCE_MAX`), one update. Versions are not bumped: the order is not a lead's content.
 */
export async function rebalanceColumn(
  tx: Tx,
  agencyId: string,
  stageId: string,
  movedId: string,
  keyOf: (index: number, total: number) => string,
): Promise<boolean> {
  const ids = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), eq(leads.stageId, stageId), sql`${leads.id} <> ${movedId}::uuid`))
    .orderBy(asc(leads.stageRank), asc(leads.id))
    .limit(REBALANCE_MAX + 1);
  if (ids.length > REBALANCE_MAX) return false;
  if (ids.length === 0) return true;
  const keys = ids.map((_, i) => keyOf(i, ids.length));
  await tx.execute(sql`
    update ${leads} l set stage_rank = v.rank
      from unnest(${sql`array[${sql.join(
        ids.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      )}]`}, ${sql`array[${sql.join(
        keys.map((k) => sql`${k}::text`),
        sql`, `,
      )}]`}) as v(id, rank)
     where l.agency_id = ${agencyId} and l.id = v.id`);
  return true;
}

/**
 * Moves the lead (at `version`) into `stageId` at `rank` with the stage's `status` (and, entering another stage, its
 * entry time); the history row follows from `leads_stage_history`. Null when the version moved on.
 */
export async function moveLead(
  tx: Tx,
  id: string,
  version: number,
  move: {
    stageId: string;
    status: string;
    rank: string;
    enteredAt?: Date;
    firstRespondedAt?: Date;
    response?: { at: Date; userId: string };
  },
): Promise<{ version: number; status: string; stageEnteredAt: Date } | null> {
  const [row] = await tx
    .update(leads)
    .set({
      stageId: move.stageId,
      status: move.status,
      stageRank: move.rank,
      ...(move.enteredAt ? { stageEnteredAt: move.enteredAt } : {}),
      ...(move.firstRespondedAt ? { firstRespondedAt: move.firstRespondedAt } : {}),
      ...(move.response ? humanResponseSet(move.response.at, move.response.userId) : {}),
      version: sql`${leads.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(leads.id, id), eq(leads.version, version)))
    .returning({ version: leads.version, status: leads.status, stageEnteredAt: leads.stageEnteredAt });
  return row ?? null;
}

// ---- history and reports --------------------------------------------------------------------------------------------

const historyColumns = {
  id: leadStageHistory.id,
  fromStageId: leadStageHistory.fromStageId,
  fromEnteredAt: leadStageHistory.fromEnteredAt,
  toStageId: leadStageHistory.toStageId,
  changedAt: leadStageHistory.changedAt,
  actorUserId: leadStageHistory.actorUserId,
};
export type HistoryRow = {
  id: string;
  fromStageId: string | null;
  fromEnteredAt: Date | null;
  toStageId: string;
  changedAt: Date;
  actorUserId: string | null;
};

/** A lead's stage changes, newest first, keyset on `lead_stage_history_lead_idx`. */
export async function leadHistory(
  tx: Tx,
  agencyId: string,
  leadId: string,
  page: { limit: number; cursor?: KeysetCursor },
): Promise<HistoryRow[]> {
  return tx
    .select(historyColumns)
    .from(leadStageHistory)
    .where(
      and(
        eq(leadStageHistory.agencyId, agencyId),
        eq(leadStageHistory.leadId, leadId),
        rowAfter(leadStageHistory.changedAt, leadStageHistory.id, page.cursor),
      ),
    )
    .orderBy(...rowOrder(leadStageHistory.changedAt, leadStageHistory.id))
    .limit(page.limit + 1);
}
