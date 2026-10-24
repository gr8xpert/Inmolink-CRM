/**
 * Seller acquisition (S10-07, PLAN §7 M8): property owners the agency is trying to win (seller prospects) on a board of
 * fixed stages — New, Contacted, Valuation, Negotiation, Mandate signed, Listed, Lost — with a list, a by-date view (next
 * follow-up) and confidential notes. One click converts a prospect into a DRAFT listing with the seller linked in the
 * listing's private side (never shown to another agency). Internal to the agency: nothing here is open in Client Mode,
 * and the confidential notes are withheld from impersonating staff too.
 */
import { z } from 'zod';
import { CurrencyCode, Money, PageQuery, pageOf } from './common';
import { TransactionType } from './properties';

export const PROSPECT_STAGES = ['NEW', 'CONTACTED', 'VALUATION', 'NEGOTIATION', 'MANDATE', 'LISTED', 'LOST'] as const;
export const ProspectStage = z.enum(PROSPECT_STAGES);
export type ProspectStage = z.infer<typeof ProspectStage>;

export const CRM_PROSPECT_LIMITS = {
  titleChars: 200,
  addressChars: 300,
  areaChars: 120,
  notesChars: 4_000,
  /** A board column counts its prospects up to this many (`countCapped` beyond: "99+"). */
  countCap: 99,
  /** Prospects per board column on one page. */
  boardColumn: 50,
  /** The by-date view's longest range. */
  followUpDays: 92,
  /** Estimated prices up to 1,000 billion (cents). */
  maxPriceCents: 100_000_000_000_000,
} as const;

/** Control characters and line / paragraph separators: a title is one clean line, notes may break lines. */
const LINE_BAD = /[\p{Cc}\u2028\u2029]/u;
const TEXT_BAD = /(?![\n\r\t])\p{Cc}|[\u2028\u2029]/u;
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !LINE_BAD.test(v), { message: 'no control characters' });
const notes = z
  .string()
  .trim()
  .min(1)
  .max(CRM_PROSPECT_LIMITS.notesChars)
  .refine((v) => !TEXT_BAD.test(v), { message: 'no control characters' });
const followUp = z.iso
  .datetime()
  .refine((v) => new Date(v).getTime() < Date.UTC(9000, 0, 1), { message: 'too far ahead' });
/** An estimated price; without `currency` it is in the agency's currency (its settings). */
const EstimatedPrice = Money.extend({
  amountCents: z.number().int().min(0).max(CRM_PROSPECT_LIMITS.maxPriceCents),
  currency: CurrencyCode.optional(),
}).strict();

export const ProspectDto = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  /** The seller (a contact of the agency); null when not known yet. */
  contactId: z.uuid().nullable(),
  /** The seller's name as the agency has it (null without a contact). */
  contactName: z.string().nullable(),
  address: z.string().nullable(),
  area: z.string().nullable(),
  propertyTypeId: z.uuid().nullable(),
  locationId: z.uuid().nullable(),
  estimatedPrice: Money.nullable(),
  stage: ProspectStage,
  stageEnteredAt: z.iso.datetime(),
  nextFollowUpAt: z.iso.datetime().nullable(),
  assignedUserId: z.uuid().nullable(),
  /** Visible to the agency's own members only; null for impersonating staff (and when empty). */
  confidentialNotes: z.string().nullable(),
  /** The DRAFT listing it was converted into. */
  listingId: z.uuid().nullable(),
  convertedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type ProspectDto = z.infer<typeof ProspectDto>;
export const ProspectPage = pageOf(ProspectDto);
export type ProspectPage = z.infer<typeof ProspectPage>;

export const ProspectParams = z.strictObject({ id: z.uuid() });
export type ProspectParams = z.infer<typeof ProspectParams>;
export const ProspectStageParams = z.strictObject({ stage: ProspectStage });
export type ProspectStageParams = z.infer<typeof ProspectStageParams>;

const assigned = z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]);

/** `GET /v1/crm/prospects`: newest first, keyset (≤ 100 per page); one stage, one member's (or `me`, `unassigned`). */
export const ListProspectsQuery = PageQuery.extend({
  stage: ProspectStage.optional(),
  assigned: assigned.optional(),
});
export type ListProspectsQuery = z.infer<typeof ListProspectsQuery>;
export type ListProspectsInput = z.input<typeof ListProspectsQuery>;

/** `GET /v1/crm/prospects/board`: every stage with its first `limit` prospects in board order and its count. */
export const ProspectBoardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CRM_PROSPECT_LIMITS.boardColumn).default(20),
});
export type ProspectBoardQuery = z.infer<typeof ProspectBoardQuery>;

export const ProspectColumnDto = z.strictObject({
  stage: ProspectStage,
  /** Prospects in the stage, at most `CRM_PROSPECT_LIMITS.countCap`. */
  count: z.number().int().min(0),
  countCapped: z.boolean(),
  items: z.array(ProspectDto),
  /** The column's next page (`GET /v1/crm/prospects/stages/:stage`). */
  nextCursor: z.string().nullable(),
});
export type ProspectColumnDto = z.infer<typeof ProspectColumnDto>;
export const ProspectBoardDto = z.strictObject({ columns: z.array(ProspectColumnDto) });
export type ProspectBoardDto = z.infer<typeof ProspectBoardDto>;

/** `GET /v1/crm/prospects/stages/:stage`: one column, board order, keyset (≤ 100 per page). */
export const ProspectColumnQuery = PageQuery;
export type ProspectColumnQuery = z.infer<typeof ProspectColumnQuery>;

/**
 * `GET /v1/crm/prospects/follow-ups?from=&to=`: prospects whose next follow-up falls in `[from, to)` (≤ 92 days — the
 * client's day boundaries), soonest first, keyset (≤ 100 per page). The dashboard groups them by day.
 */
export const ProspectFollowUpsQuery = PageQuery.extend({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= CRM_PROSPECT_LIMITS.followUpDays * 86_400_000, {
    message: `at most ${CRM_PROSPECT_LIMITS.followUpDays} days`,
    path: ['to'],
  });
export type ProspectFollowUpsQuery = z.infer<typeof ProspectFollowUpsQuery>;
export type ProspectFollowUpsInput = z.input<typeof ProspectFollowUpsQuery>;

/**
 * `POST /v1/crm/prospects` (in `NEW`, at the top of its column). Without `assignedUserId` it is the caller's. Accepts an
 * `Idempotency-Key` (24 h replay of the same body; another body with the key is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreateProspectBody = z.strictObject({
  title: line(CRM_PROSPECT_LIMITS.titleChars),
  contactId: z.uuid().optional(),
  address: line(CRM_PROSPECT_LIMITS.addressChars).optional(),
  area: line(CRM_PROSPECT_LIMITS.areaChars).optional(),
  propertyTypeId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  estimatedPrice: EstimatedPrice.optional(),
  nextFollowUpAt: followUp.optional(),
  assignedUserId: z.uuid().optional(),
  confidentialNotes: notes.optional(),
});
export type CreateProspectBody = z.infer<typeof CreateProspectBody>;
export type CreateProspectInput = z.input<typeof CreateProspectBody>;

/** `PATCH /v1/crm/prospects/:id` (optimistic `version`); `null` clears a field. The stage changes by a move. */
export const UpdateProspectBody = z
  .strictObject({
    version: z.number().int().min(1),
    title: line(CRM_PROSPECT_LIMITS.titleChars).optional(),
    contactId: z.uuid().nullable().optional(),
    address: line(CRM_PROSPECT_LIMITS.addressChars).nullable().optional(),
    area: line(CRM_PROSPECT_LIMITS.areaChars).nullable().optional(),
    propertyTypeId: z.uuid().nullable().optional(),
    locationId: z.uuid().nullable().optional(),
    estimatedPrice: EstimatedPrice.nullable().optional(),
    nextFollowUpAt: followUp.nullable().optional(),
    assignedUserId: z.uuid().nullable().optional(),
    confidentialNotes: notes.nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'nothing to change', path: ['title'] });
export type UpdateProspectBody = z.infer<typeof UpdateProspectBody>;
export type UpdateProspectInput = z.input<typeof UpdateProspectBody>;

/**
 * `POST /v1/crm/prospects/:id/move` (a drag, at the prospect's `version`): into `stage`, right after `afterId` there
 * (null: the top). `LISTED` is reached by converting; a converted prospect stays in `LISTED`. An `afterId` no longer in
 * the column is `VERSION_CONFLICT` (reload the board).
 */
export const MoveProspectBody = z.strictObject({
  version: z.number().int().min(1),
  stage: ProspectStage,
  afterId: z.uuid().nullable().default(null),
});
export type MoveProspectBody = z.infer<typeof MoveProspectBody>;
export type MoveProspectInput = z.input<typeof MoveProspectBody>;

/**
 * `POST /v1/crm/prospects/:id/convert`: one click — a DRAFT listing from the prospect (type, location, estimated price;
 * the body may supply a missing type or location), the seller linked in the listing's private side, the prospect moved
 * to `LISTED`. Converting again answers the same listing (`created: false`).
 */
export const ConvertProspectBody = z.strictObject({
  transactionType: TransactionType.default('SALE'),
  propertyTypeId: z.uuid().optional(),
  locationId: z.uuid().optional(),
});
export type ConvertProspectBody = z.infer<typeof ConvertProspectBody>;
export type ConvertProspectInput = z.input<typeof ConvertProspectBody>;

export const ProspectConversionDto = z.strictObject({
  prospect: ProspectDto,
  listingId: z.uuid(),
  /** False when the prospect had been converted already (the same listing). */
  created: z.boolean(),
});
export type ProspectConversionDto = z.infer<typeof ProspectConversionDto>;

/** `DELETE /v1/crm/prospects/:id`. */
export const ProspectDeletedDto = z.strictObject({ deleted: z.literal(true) });
export type ProspectDeletedDto = z.infer<typeof ProspectDeletedDto>;
