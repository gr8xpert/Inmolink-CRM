/**
 * CRM pipeline (S10-03, PLAN §7 M8): the agency's own lead stages — named, ordered, each standing for one lead status
 * (`NEW`, `IN_PROGRESS`, `WON`, `LOST`, `SPAM`), so its kind (`OPEN`, `WON`, `LOST`) is known to reports whatever the
 * agency calls it. Every agency starts with five stages (New, In progress, Won, Lost, Spam: `key` set, `name` null — the
 * dashboard shows them in the member's language); admins rename, reorder, add and archive. A lead is always in one
 * stage; moving it records a stage history row (time in stage) and a `STAGE_CHANGED` activity.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';
import { LeadListItemDto, LeadStatus } from './crm-leads';

export const PIPELINE_STAGE_KINDS = ['OPEN', 'WON', 'LOST'] as const;
export const PipelineStageKind = z.enum(PIPELINE_STAGE_KINDS);
export type PipelineStageKind = z.infer<typeof PipelineStageKind>;

/** The default stages every agency starts with (their names are UI strings: `name` stays null until renamed). */
export const PIPELINE_STAGE_KEYS = ['NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM'] as const;
export const PipelineStageKey = z.enum(PIPELINE_STAGE_KEYS);
export type PipelineStageKey = z.infer<typeof PipelineStageKey>;

/** The lead status a stage of each kind stands for when an admin adds it. */
export const STATUS_OF_KIND = { OPEN: 'IN_PROGRESS', WON: 'WON', LOST: 'LOST' } as const satisfies Record<
  PipelineStageKind,
  LeadStatus
>;

/** The kind of a lead status: open until won or lost (spam is lost). */
export function kindOfStatus(status: LeadStatus): PipelineStageKind {
  if (status === 'WON') return 'WON';
  if (status === 'LOST' || status === 'SPAM') return 'LOST';
  return 'OPEN';
}

export const CRM_PIPELINE_LIMITS = {
  /** Active stages per agency. */
  stages: 30,
  nameChars: 60,
  /** A board column counts its leads up to this many (`countCapped` beyond: "99+"). */
  countCap: 99,
  /** Leads per board column on one page. */
  boardColumn: 50,
  /** A report's longest range (a quarter: the moves of the range are read whole). */
  reportDays: 92,
} as const;

export const PipelineStageDto = z.strictObject({
  id: z.uuid(),
  /** A default stage's key (its name in the member's language when `name` is null); null for an admin's own stage. */
  key: PipelineStageKey.nullable(),
  /** The agency's name for it; null: the default stage's translated name. */
  name: z.string().nullable(),
  /** The lead status a lead in this stage has (`GET /v1/crm/leads?status=` keeps working). */
  status: LeadStatus,
  kind: PipelineStageKind,
  /** 0-based order among the active stages. */
  position: z.number().int().min(0),
  /** The stage new leads enter (the `NEW` stage): it cannot be archived. */
  entry: z.boolean(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type PipelineStageDto = z.infer<typeof PipelineStageDto>;

export const PipelineStageList = z.strictObject({ items: z.array(PipelineStageDto) });
export type PipelineStageList = z.infer<typeof PipelineStageList>;

/** `GET /v1/crm/pipeline/stages`: the active stages in order (and the archived ones with `includeArchived`). */
export const ListPipelineStagesQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListPipelineStagesQuery = z.infer<typeof ListPipelineStagesQuery>;

const stageName = z.string().trim().min(1).max(CRM_PIPELINE_LIMITS.nameChars);

/**
 * `POST /v1/crm/pipeline/stages` (admins): a stage of the given kind, added after the last active stage (or at
 * `position`). Accepts an `Idempotency-Key` (24 h replay of the same body; another body is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreatePipelineStageBody = z.strictObject({
  name: stageName,
  kind: PipelineStageKind,
  position: z.number().int().min(0).max(CRM_PIPELINE_LIMITS.stages).optional(),
});
export type CreatePipelineStageBody = z.infer<typeof CreatePipelineStageBody>;

export const PipelineStageParams = z.strictObject({ id: z.uuid() });
export type PipelineStageParams = z.infer<typeof PipelineStageParams>;

/**
 * `PATCH /v1/crm/pipeline/stages/:id` (admins, at `version`): rename (`name: null` goes back to a default stage's
 * translated name), archive (only an empty stage that is not the entry stage nor the last open one) or restore.
 */
export const UpdatePipelineStageBody = z
  .strictObject({
    version: z.number().int().min(1),
    name: stageName.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.archived !== undefined, {
    message: 'name or archived is required',
    path: ['name'],
  });
export type UpdatePipelineStageBody = z.infer<typeof UpdatePipelineStageBody>;

/** `PUT /v1/crm/pipeline/stages/order` (admins): every active stage's id, once, in the new order. */
export const ReorderPipelineStagesBody = z.strictObject({
  stageIds: z.array(z.uuid()).min(1).max(CRM_PIPELINE_LIMITS.stages),
});
export type ReorderPipelineStagesBody = z.infer<typeof ReorderPipelineStagesBody>;

/** A lead card on the board: the inbox item and where it stands. */
export const PipelineLeadDto = LeadListItemDto.extend({
  /** When it entered its stage (time in stage). */
  stageEnteredAt: z.iso.datetime(),
  version: z.number().int(),
});
export type PipelineLeadDto = z.infer<typeof PipelineLeadDto>;

export const PipelineColumnDto = z.strictObject({
  stage: PipelineStageDto,
  /** Leads in the stage (with the board's `assigned` filter), at most `CRM_PIPELINE_LIMITS.countCap`. */
  count: z.number().int().min(0),
  /** More leads than `count` (show "99+"). */
  countCapped: z.boolean(),
  items: z.array(PipelineLeadDto),
  /** The column's next page (`GET /v1/crm/pipeline/stages/:id/leads?cursor=`); null: all shown. */
  nextCursor: z.string().nullable(),
});
export type PipelineColumnDto = z.infer<typeof PipelineColumnDto>;

export const PipelineBoardDto = z.strictObject({ columns: z.array(PipelineColumnDto) });
export type PipelineBoardDto = z.infer<typeof PipelineBoardDto>;

const assigned = z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]);

/**
 * `GET /v1/crm/pipeline/board`: every active stage with its first `limit` leads in board order (a member's drag order;
 * otherwise newest first) and its lead count. `assigned`: `me`, `unassigned` or a member's id.
 */
export const PipelineBoardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CRM_PIPELINE_LIMITS.boardColumn).default(20),
  assigned: assigned.optional(),
});
export type PipelineBoardQuery = z.infer<typeof PipelineBoardQuery>;

/** `GET /v1/crm/pipeline/stages/:id/leads`: one column, board order, keyset (≤ 100 per page). */
export const PipelineColumnQuery = PageQuery.extend({ assigned: assigned.optional() });
export type PipelineColumnQuery = z.infer<typeof PipelineColumnQuery>;
export const PipelineLeadPage = pageOf(PipelineLeadDto);
export type PipelineLeadPage = z.infer<typeof PipelineLeadPage>;

/**
 * `POST /v1/crm/leads/:id/move` (drag on the board, at the lead's `version`): into `stageId` (the same one reorders),
 * right after `afterLeadId` in that column — `null`: at the top. An `afterLeadId` that is not in the column any more
 * (another member moved it) is `VERSION_CONFLICT`: reload the board.
 */
export const MoveLeadBody = z.strictObject({
  version: z.number().int().min(1),
  stageId: z.uuid(),
  afterLeadId: z.uuid().nullable().default(null),
});
export type MoveLeadBody = z.infer<typeof MoveLeadBody>;
export type MoveLeadInput = z.input<typeof MoveLeadBody>;

/** A lead's passage from one stage to the next (`from` null: the stage it was received in). */
export const LeadStageChangeDto = z.strictObject({
  id: z.uuid(),
  fromStageId: z.uuid().nullable(),
  toStageId: z.uuid(),
  changedAt: z.iso.datetime(),
  /** How long it stayed in `fromStageId`, in seconds (null for the first). */
  secondsInFromStage: z.number().int().nullable(),
  /** The member who moved it; null when the system did (a lead received). */
  actorUserId: z.uuid().nullable(),
});
export type LeadStageChangeDto = z.infer<typeof LeadStageChangeDto>;
export const LeadStageHistoryPage = pageOf(LeadStageChangeDto);
export type LeadStageHistoryPage = z.infer<typeof LeadStageHistoryPage>;

/**
 * `GET /v1/crm/pipeline/report?from=&to=`: per stage, the leads in it now (and how long they have been there), the
 * leads that entered and left it in `[from, to)` and how long the completed stays lasted. ≤ 92 days.
 */
export const PipelineReportQuery = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= CRM_PIPELINE_LIMITS.reportDays * 86_400_000, {
    message: `at most ${CRM_PIPELINE_LIMITS.reportDays} days`,
    path: ['to'],
  });
export type PipelineReportQuery = z.infer<typeof PipelineReportQuery>;

export const PipelineReportRowDto = z.strictObject({
  stage: PipelineStageDto,
  /** Leads in the stage now. */
  current: z.number().int().min(0),
  /** Mean age of the current stays, in seconds (null when the stage is empty). */
  currentAvgSeconds: z.number().int().nullable(),
  /** Leads that entered the stage in the range (a lead received into it included). */
  entered: z.number().int().min(0),
  /** Leads that left the stage in the range. */
  exited: z.number().int().min(0),
  /** Mean and median length of the stays that ended in the range, in seconds (null when none). */
  avgSecondsInStage: z.number().int().nullable(),
  medianSecondsInStage: z.number().int().nullable(),
});
export type PipelineReportRowDto = z.infer<typeof PipelineReportRowDto>;

export const PipelineReportDto = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  /** Every stage (archived ones too, after the active ones: past stays stay counted). */
  stages: z.array(PipelineReportRowDto),
  /** Leads won and lost in the range (moved into a stage of that kind). */
  won: z.number().int().min(0),
  lost: z.number().int().min(0),
});
export type PipelineReportDto = z.infer<typeof PipelineReportDto>;
