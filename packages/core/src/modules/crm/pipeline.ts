import {
  AppError,
  CRM_PIPELINE_LIMITS,
  type CreatePipelineStageBody,
  type LeadKind,
  type LeadSource,
  type LeadStageHistoryPage,
  type LeadStatus,
  type LeadTargetKind,
  type ListPipelineStagesQuery,
  type MoveLeadBody,
  type PageQuery,
  type PipelineBoardDto,
  type PipelineBoardQuery,
  type PipelineColumnQuery,
  type PipelineLeadDto,
  type PipelineLeadPage,
  type PipelineReportDto,
  type PipelineReportQuery,
  type PipelineStageDto,
  type PipelineStageKey,
  type PipelineStageKind,
  type PipelineStageList,
  type ReorderPipelineStagesBody,
  STATUS_OF_KIND,
  type UpdatePipelineStageBody,
} from '@inmolink/contracts';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { type Ctx, userIdOf } from '../../context';
import { idempotencyOf, keyReusedOn, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as billing from '../billing';
import { auditImpersonatedRead } from './audit';
import { crmEvents } from './events';
import * as leadsRepo from './leads-repo';
import * as pipelineRepo from './pipeline-repo';
import { assertCan } from './policy';
import { isRank, rankBetween, spreadRank, timeRank } from './rank';
import { mergeReportParts } from './report-rollups';
import * as rollupsRepo from './report-rollups-repo';
import { humanResponseOf } from './response';

/**
 * The pipeline (S10-03, PLAN §7 M8): the agency's own lead stages, the board, a drag, a lead's stage history and the
 * report. A lead is always in one stage (`leads.stage_id`); the database keeps `status` the stage's, gives a new lead the
 * entry stage (seeding the defaults on an agency's first lead) and appends every move to `lead_stage_history`. A move
 * to another stage emits `crm.lead.stageChanged` in its transaction; the timeline records `STAGE_CHANGED` from it.
 */

export function toStageDto(row: pipelineRepo.StageRow): PipelineStageDto {
  return {
    id: row.id,
    key: row.seedKey as PipelineStageKey | null,
    name: row.name,
    status: row.status as LeadStatus,
    kind: row.kind as PipelineStageKind,
    position: row.position,
    entry: row.status === 'NEW',
    archived: row.archivedAt !== null,
    version: row.version,
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toCardDto(row: pipelineRepo.CardRow): PipelineLeadDto {
  return {
    id: row.id,
    source: row.source as LeadSource,
    kind: row.kind as LeadKind,
    status: row.status as LeadStatus,
    stageId: row.stageId,
    contact: {
      id: row.contactId,
      firstName: row.contactFirstName,
      lastName: row.contactLastName,
      primaryEmail: row.contactEmail,
      primaryPhone: row.contactPhone,
    },
    presentingAgencyId: row.presentingAgencyId,
    ownerAgencyId: row.ownerAgencyId,
    target:
      row.targetKind && row.targetId
        ? { kind: row.targetKind as LeadTargetKind, id: row.targetId, shownRef: row.shownRef }
        : null,
    locale: row.locale,
    assignedUserId: row.assignedUserId,
    assignedAt: iso(row.assignedAt),
    firstRespondedAt: iso(row.firstRespondedAt),
    createdAt: row.createdAt.toISOString(),
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    version: row.version,
  };
}

/** `assigned` of a board query as a repo filter: a member's id, null (unassigned) or undefined (everyone's). */
function assignedOf(ctx: Ctx, assigned: string | undefined): string | null | undefined {
  if (assigned === undefined) return undefined;
  if (assigned === 'unassigned') return null;
  if (assigned === 'me') return userIdOf(ctx);
  return assigned;
}

/**
 * The agency's stages, read-only: an agency that has had no lead or stage change yet has none (its write paths seed
 * the defaults: `leadsRepo.entryStageAndRule` on a lead received, `createPipelineStage`).
 */
function stagesOf(ctx: Ctx, opts: { archived?: boolean } = {}): Promise<pipelineRepo.StageRow[]> {
  return pipelineRepo.listStages(ctx.tx, ctx.tenant.agencyId, opts);
}

/** Where a new lead stands: the entry stage, entered now, newest first in its column (no extra statement). */
export function placement(leadId: string, at: Date): { stageRank: string; stageEnteredAt: Date } {
  return { stageRank: timeRank(at, leadId), stageEnteredAt: at };
}

/** A stage of the caller's agency, or `PIPELINE_STAGE_NOT_FOUND`. */
async function ownStage(
  ctx: Ctx,
  id: string,
  opts: { lock?: 'share' | 'update' } = {},
): Promise<pipelineRepo.StageRow> {
  const stage = await pipelineRepo.getStage(ctx.tx, id, opts);
  if (!stage || stage.agencyId !== ctx.tenant.agencyId) throw new AppError('PIPELINE_STAGE_NOT_FOUND');
  return stage;
}

/** A unique-index violation of a stage write as its error code. */
function stageWriteError(err: unknown): never {
  const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
  if (cause?.code === '23505' && cause.constraint === 'pipeline_stages_name_uq') {
    throw new AppError('PIPELINE_STAGE_DUPLICATE');
  }
  return keyReusedOn('pipeline_stages_idempotency_uq')(err);
}

// ---- stages ---------------------------------------------------------------------------------------------------------

/** `GET /v1/crm/pipeline/stages`: the active stages in order (then the archived ones). One query. */
export async function listPipelineStages(ctx: Ctx, query: ListPipelineStagesQuery = {}): Promise<PipelineStageList> {
  assertCan(ctx, 'crm.leads.read');
  const rows = await stagesOf(ctx, { archived: query.includeArchived ?? false });
  return { items: rows.map(toStageDto) };
}

/**
 * `POST /v1/crm/pipeline/stages` (admins): a stage of `kind` at `position` (default: last) — the other active stages
 * renumbered in the same transaction. With an `Idempotency-Key`, a retry within 24 h with the same body answers the
 * first stage; another body is `IDEMPOTENCY_KEY_REUSED`. ≤ 5 statements.
 */
export async function createPipelineStage(
  ctx: Ctx,
  input: CreatePipelineStageBody,
  opts: { idempotencyKey?: string } = {},
): Promise<{ stage: PipelineStageDto; replayed: boolean }> {
  assertCan(ctx, 'crm.pipeline.manage');
  // S13-F21: a custom pipeline is CRM Full (PLAN §11).
  await billing.requirePlan(ctx, 'crm_full');
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('crm.stage', userIdOf(ctx), opts.idempotencyKey, input);
  const prior = await replayOf(ctx.tx, idempotency, (since, key) =>
    pipelineRepo.stageByIdempotency(ctx.tx, agencyId, key.hash, since),
  );
  if (prior) return { stage: toStageDto(await ownStage(ctx, prior.id)), replayed: true };
  await pipelineRepo.seedStages(ctx.tx, agencyId); // a no-op once the agency has its stages
  const active = await stagesOf(ctx);
  if (active.length >= CRM_PIPELINE_LIMITS.stages) throw new AppError('PIPELINE_STAGE_LIMIT');
  const at = Math.min(input.position ?? active.length, active.length);
  const id = newId();
  let stage: pipelineRepo.StageRow;
  try {
    stage = await pipelineRepo.insertStage(ctx.tx, {
      id,
      agencyId,
      name: input.name,
      status: STATUS_OF_KIND[input.kind],
      position: at,
      idempotencyHash: idempotency?.hash ?? null,
      requestHash: idempotency?.requestHash ?? null,
    });
  } catch (err) {
    stageWriteError(err);
  }
  if (at < active.length) {
    const order = active.map((s) => s.id);
    order.splice(at, 0, id);
    await pipelineRepo.setPositions(ctx.tx, agencyId, order);
  }
  return { stage: toStageDto(stage), replayed: false };
}

/**
 * `PATCH /v1/crm/pipeline/stages/:id` (admins, at `version`): rename, archive or restore. Archiving refuses the entry
 * stage, a stage with leads in it and the last open stage (`PIPELINE_STAGE_LOCKED`); a restored stage goes last.
 */
export async function updatePipelineStage(
  ctx: Ctx,
  id: string,
  input: UpdatePipelineStageBody,
): Promise<PipelineStageDto> {
  assertCan(ctx, 'crm.pipeline.manage');
  // S13-F21: a custom pipeline is CRM Full (PLAN §11).
  await billing.requirePlan(ctx, 'crm_full');
  const agencyId = ctx.tenant.agencyId;
  const current = await ownStage(ctx, id, { lock: 'update' });
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const patch: Parameters<typeof pipelineRepo.updateStageWithVersion>[3] = {};
  if (input.name !== undefined && input.name !== current.name) {
    if (input.name === null && current.seedKey === null) {
      throw new AppError('VALIDATION_FAILED', { field: 'name', reason: 'required' });
    }
    patch.name = input.name;
  }
  const archived = current.archivedAt !== null;
  if (input.archived === true && !archived) {
    if (current.status === 'NEW') throw new AppError('PIPELINE_STAGE_LOCKED', { reason: 'entry' });
    if (await pipelineRepo.stageHasLeads(ctx.tx, agencyId, id)) {
      throw new AppError('PIPELINE_STAGE_LOCKED', { reason: 'not_empty' });
    }
    const active = await pipelineRepo.listStages(ctx.tx, agencyId);
    if (current.kind === 'OPEN' && !active.some((s) => s.id !== id && s.kind === 'OPEN')) {
      throw new AppError('PIPELINE_STAGE_LOCKED', { reason: 'last_open' });
    }
    patch.archivedAt = new Date();
  } else if (input.archived === false && archived) {
    const active = await pipelineRepo.listStages(ctx.tx, agencyId);
    if (active.length >= CRM_PIPELINE_LIMITS.stages) throw new AppError('PIPELINE_STAGE_LIMIT');
    patch.archivedAt = null;
    patch.position = active.reduce((max, s) => Math.max(max, s.position + 1), 0);
  }
  if (Object.keys(patch).length === 0) return toStageDto(current);
  let updated: pipelineRepo.StageRow | null;
  try {
    updated = await pipelineRepo.updateStageWithVersion(ctx.tx, id, input.version, patch);
  } catch (err) {
    stageWriteError(err);
  }
  if (!updated) throw new AppError('VERSION_CONFLICT');
  return toStageDto(updated);
}

/**
 * `PUT /v1/crm/pipeline/stages/order` (admins): the active stages in the order given — every one exactly once, or
 * `PIPELINE_ORDER_INVALID` (a stage was added or archived meanwhile). Three statements.
 */
export async function reorderPipelineStages(ctx: Ctx, input: ReorderPipelineStagesBody): Promise<PipelineStageList> {
  assertCan(ctx, 'crm.pipeline.manage');
  // S13-F21: a custom pipeline is CRM Full (PLAN §11).
  await billing.requirePlan(ctx, 'crm_full');
  const agencyId = ctx.tenant.agencyId;
  const active = await pipelineRepo.listStages(ctx.tx, agencyId);
  const wanted = new Set(input.stageIds);
  if (wanted.size !== input.stageIds.length || wanted.size !== active.length || active.some((s) => !wanted.has(s.id))) {
    throw new AppError('PIPELINE_ORDER_INVALID');
  }
  await pipelineRepo.setPositions(ctx.tx, agencyId, input.stageIds);
  return { items: (await pipelineRepo.listStages(ctx.tx, agencyId)).map(toStageDto) };
}

// ---- the board ------------------------------------------------------------------------------------------------------

const encodeRank = (c: pipelineRepo.RankCursor): string =>
  Buffer.from(JSON.stringify([c.rank, c.id])).toString('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeRank(cursor: string | undefined): pipelineRepo.RankCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [rank, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof rank === 'string' && isRank(rank) && typeof id === 'string' && UUID.test(id)) return { rank, id };
  } catch {
    // falls through to the error below
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

function columnPage(
  rows: pipelineRepo.CardRow[],
  limit: number,
): { items: PipelineLeadDto[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toCardDto),
    nextCursor: rows.length > limit && last ? encodeRank({ rank: last.stageRank, id: last.id }) : null,
  };
}

/**
 * `GET /v1/crm/pipeline/board`: every active stage with its lead count (up to `countCap`) and first `limit` cards in
 * board order. Three queries whatever the number of stages: the stages, every column's page (one lateral query), the
 * counts (bounded per stage).
 */
export async function getPipelineBoard(ctx: Ctx, query: PipelineBoardQuery): Promise<PipelineBoardDto> {
  assertCan(ctx, 'crm.leads.read');
  const agencyId = ctx.tenant.agencyId;
  const assigned = assignedOf(ctx, query.assigned);
  const stages = await stagesOf(ctx);
  const cards = await pipelineRepo.boardCards(ctx.tx, agencyId, assigned, query.limit);
  const counts = await pipelineRepo.stageCounts(ctx.tx, agencyId, assigned, CRM_PIPELINE_LIMITS.countCap + 1);
  const byStage = new Map<string, pipelineRepo.CardRow[]>();
  for (const c of cards) {
    const list = byStage.get(c.stageId) ?? [];
    list.push(c);
    byStage.set(c.stageId, list);
  }
  const order = (a: pipelineRepo.CardRow, b: pipelineRepo.CardRow) =>
    a.stageRank < b.stageRank ? -1 : a.stageRank > b.stageRank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  await auditImpersonatedRead(ctx, 'pipeline', { count: cards.length, filter: { assigned: query.assigned } });
  return {
    columns: stages.map((stage) => ({
      stage: toStageDto(stage),
      count: Math.min(counts.get(stage.id) ?? 0, CRM_PIPELINE_LIMITS.countCap),
      countCapped: (counts.get(stage.id) ?? 0) > CRM_PIPELINE_LIMITS.countCap,
      ...columnPage((byStage.get(stage.id) ?? []).sort(order), query.limit),
    })),
  };
}

/** `GET /v1/crm/pipeline/stages/:id/leads`: one column's next page, board order, keyset. Two queries. */
export async function listStageLeads(ctx: Ctx, stageId: string, query: PipelineColumnQuery): Promise<PipelineLeadPage> {
  assertCan(ctx, 'crm.leads.read');
  await ownStage(ctx, stageId);
  const cursor = decodeRank(query.cursor);
  const rows = await pipelineRepo.columnCards(
    ctx.tx,
    ctx.tenant.agencyId,
    stageId,
    assignedOf(ctx, query.assigned),
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  await auditImpersonatedRead(ctx, 'pipeline', {
    count: Math.min(rows.length, query.limit),
    parentId: stageId,
    filter: { assigned: query.assigned },
  });
  return columnPage(rows, query.limit);
}

/**
 * `POST /v1/crm/leads/:id/move` (a drag, at the lead's `version`): into an active stage of the agency, right after
 * `afterLeadId` there (null: at the top) — a rank between that lead's and the next card's, so no other card is
 * rewritten (unless the two share a rank or the key would be too long: the column is re-ranked first, 2 statements).
 * The target stage is locked `FOR SHARE` (an archive waits for the move, then finds the lead in it). A drop next to a
 * card that has left the column meanwhile is `VERSION_CONFLICT` (reload the board). A move to another stage writes the
 * stage's status and the entry time, leaves `NEW` for good (`firstRespondedAt`), emits `crm.lead.stageChanged` and gets
 * its history row from the database. ≤ 6 statements (≤ 9 with a re-rank).
 */
export async function moveLead(ctx: Ctx, leadId: string, input: MoveLeadBody): Promise<PipelineLeadDto> {
  assertCan(ctx, 'crm.leads.write');
  const agencyId = ctx.tenant.agencyId;
  if (input.afterLeadId === leadId) throw new AppError('VALIDATION_FAILED', { field: 'afterLeadId' });
  const lead = await pipelineRepo.lockLead(ctx.tx, leadId);
  if (!lead) throw new AppError('LEAD_NOT_FOUND');
  assertCan(ctx, 'crm.leads.write', lead);
  if (lead.version !== input.version) throw new AppError('VERSION_CONFLICT');
  const stage = await ownStage(ctx, input.stageId, { lock: 'share' });
  if (stage.archivedAt) throw new AppError('PIPELINE_STAGE_NOT_FOUND');
  const rank = await dropRank(ctx, stage.id, input.afterLeadId, leadId);
  const changed = stage.id !== lead.stageId;
  const now = new Date();
  const leavesNew = changed && lead.status === 'NEW' && stage.status !== 'NEW' && !lead.firstRespondedAt;
  const moved = await pipelineRepo.moveLead(ctx.tx, leadId, input.version, {
    stageId: stage.id,
    status: stage.status,
    rank,
    ...(changed ? { enteredAt: now } : {}),
    ...(leavesNew ? { firstRespondedAt: now } : {}),
    ...(changed ? { response: humanResponseOf(ctx, now) } : {}),
  });
  if (!moved) throw new AppError('VERSION_CONFLICT');
  if (changed) {
    await emit(
      ctx.tx,
      crmEvents.leadStageChanged({
        agencyId,
        leadId,
        fromStageId: lead.stageId,
        toStageId: stage.id,
        status: moved.status,
        version: moved.version,
        receivedMs: lead.createdMs.getTime(),
        movedMs: now.getTime(),
      }),
    );
  }
  const card = await pipelineRepo.card(ctx.tx, leadId);
  if (!card) throw new AppError('LEAD_NOT_FOUND');
  return toCardDto(card);
}

/**
 * The rank of a drop right after `afterLeadId` (null: the top) in a column: a key between the neighbours, or — when
 * they share a rank or the key would pass the length cap — after re-ranking the column (`REBALANCE_MAX` cards at most;
 * a larger column refuses the drop with `VALIDATION_FAILED`, reason `column_too_large`).
 */
async function dropRank(ctx: Ctx, stageId: string, afterLeadId: string | null, leadId: string): Promise<string> {
  const agencyId = ctx.tenant.agencyId;
  const between = async (): Promise<string | null> => {
    const gap = await pipelineRepo.dropGap(ctx.tx, agencyId, stageId, afterLeadId, leadId);
    if (!gap.found) throw new AppError('VERSION_CONFLICT');
    if (gap.upper !== null && gap.upper <= gap.lower) return null;
    const rank = rankBetween(gap.lower, gap.upper);
    return isRank(rank) ? rank : null;
  };
  const rank = await between();
  if (rank) return rank;
  if (!(await pipelineRepo.rebalanceColumn(ctx.tx, agencyId, stageId, leadId, spreadRank))) {
    throw new AppError('VALIDATION_FAILED', { field: 'afterLeadId', reason: 'column_too_large' });
  }
  const after = await between();
  if (!after) throw new AppError('INTERNAL', { reason: 'rank_after_rebalance' });
  return after;
}

/**
 * The stage a status set through `PATCH /v1/crm/leads/:id` moves a lead to: the agency's first active stage standing
 * for it (locked `FOR SHARE`), or `VALIDATION_FAILED` (`no_stage`: every such stage is archived).
 */
export async function stageForStatus(ctx: Ctx, status: LeadStatus): Promise<pipelineRepo.StageRow> {
  const stage = await pipelineRepo.stageForStatus(ctx.tx, ctx.tenant.agencyId, status);
  if (!stage) throw new AppError('VALIDATION_FAILED', { field: 'status', reason: 'no_stage' });
  return stage;
}

// ---- history and report ---------------------------------------------------------------------------------------------

/** `GET /v1/crm/leads/:id/stage-history`: the lead's stage changes, newest first, keyset. Two queries. */
export async function listLeadStageHistory(ctx: Ctx, leadId: string, query: PageQuery): Promise<LeadStageHistoryPage> {
  assertCan(ctx, 'crm.leads.read');
  const lead = await leadsRepo.getLead(ctx.tx, leadId);
  if (!lead || lead.agencyId !== ctx.tenant.agencyId) throw new AppError('LEAD_NOT_FOUND');
  const cursor = decodeCursor(query.cursor);
  const rows = await pipelineRepo.leadHistory(
    ctx.tx,
    ctx.tenant.agencyId,
    leadId,
    cursor ? { limit: query.limit, cursor } : { limit: query.limit },
  );
  await auditImpersonatedRead(ctx, 'stageHistory', { count: Math.min(rows.length, query.limit), parentId: leadId });
  return toPage(
    rows,
    query.limit,
    (r) => ({ at: r.changedAt, id: r.id }),
    (r) => ({
      id: r.id,
      fromStageId: r.fromStageId,
      toStageId: r.toStageId,
      changedAt: r.changedAt.toISOString(),
      secondsInFromStage: r.fromEnteredAt
        ? Math.round((r.changedAt.getTime() - r.fromEnteredAt.getTime()) / 1000)
        : null,
      actorUserId: r.actorUserId,
    }),
  );
}

/**
 * `GET /v1/crm/pipeline/report`: per stage (active ones in order, then archived), the leads in it now and how long they
 * have been there, the leads that entered and left it in `[from, to)` and how long the stays that ended lasted; the
 * leads won and lost in the range. Two queries. S11-F10: from rollups — the leads per stage now (`crm_stage_counts`)
 * and the moves of the range's whole UTC days (`crm_stage_move_rollups`, every stay kept: exact medians); the partial
 * days at the ends from `lead_stage_history`.
 */
export async function getPipelineReport(ctx: Ctx, query: PipelineReportQuery): Promise<PipelineReportDto> {
  assertCan(ctx, 'crm.leads.read');
  // S13-F21: reports are Standard and up (PLAN §11).
  await billing.requirePlan(ctx, 'reports_standard');
  const from = new Date(query.from);
  const to = new Date(query.to);
  const stages = await stagesOf(ctx, { archived: true });
  const parts = await rollupsRepo.pipelineReportParts(ctx.tx, ctx.tenant.agencyId, from, to);
  const rows = new Map(mergeReportParts(parts).map((r) => [r.stageId, r]));
  let won = 0;
  let lost = 0;
  const out = stages.map((stage) => {
    const r = rows.get(stage.id);
    if (stage.kind === 'WON') won += r?.entered ?? 0;
    if (stage.kind === 'LOST') lost += r?.entered ?? 0;
    return {
      stage: toStageDto(stage),
      current: r?.current ?? 0,
      currentAvgSeconds: r?.currentAvgSeconds ?? null,
      entered: r?.entered ?? 0,
      exited: r?.exited ?? 0,
      avgSecondsInStage: r?.avgSeconds ?? null,
      medianSecondsInStage: r?.medianSeconds ?? null,
    };
  });
  return { from: from.toISOString(), to: to.toISOString(), stages: out, won, lost };
}
