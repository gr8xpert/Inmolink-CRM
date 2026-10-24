/**
 * CRM leads, routing and inbox (S10-02, PLAN §3 #12, §7 M8): a lead is a client's enquiry in the inbox of the agency
 * it is routed to (by source: marketplace → the listing owner; agency website, iFrame, selection, portfolio, portal,
 * chatbot, WhatsApp, manual → the presenting agency; developer portal → the presenting agency and the developer). When
 * the target is another agency's (a network listing, a developer's unit), that agency sees an introduction — the
 * introducer agency and the target — never the client. Assignment: an agency rule (round robin or the listing's
 * agent) or by hand.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

export const LEAD_SOURCES = [
  'WEBSITE',
  'IFRAME',
  'SELECTION',
  'PORTFOLIO',
  'PORTAL',
  'MARKETPLACE',
  'DEVELOPER_PORTAL',
  'CHATBOT',
  'WHATSAPP',
  'MANUAL',
] as const;
export const LeadSource = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSource>;

/** Sources a member may enter by hand (the others arrive through their channel's intake). */
export const MANUAL_LEAD_SOURCES = ['MANUAL', 'PORTAL', 'WHATSAPP'] as const satisfies readonly LeadSource[];

export const LEAD_STATUSES = ['NEW', 'IN_PROGRESS', 'WON', 'LOST', 'SPAM'] as const;
export const LeadStatus = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatus>;

export const LeadKind = z.enum(['ENQUIRY', 'VIEWING_REQUEST']);
export type LeadKind = z.infer<typeof LeadKind>;

export const LeadTargetKind = z.enum(['LISTING', 'DEVELOPMENT', 'UNIT']);
export type LeadTargetKind = z.infer<typeof LeadTargetKind>;

export const LEAD_ASSIGNMENT_MODES = ['UNASSIGNED', 'ROUND_ROBIN', 'OWNER_AGENT'] as const;
export const LeadAssignmentMode = z.enum(LEAD_ASSIGNMENT_MODES);
export type LeadAssignmentMode = z.infer<typeof LeadAssignmentMode>;

/** Bounds of a lead and of the routing rule. */
export const CRM_LEAD_LIMITS = { messageChars: 4_000, shownRefChars: 64, roundRobinAgents: 200 } as const;

export const LeadTargetDto = z.strictObject({
  kind: LeadTargetKind,
  id: z.uuid(),
  /** The reference as the client saw it (a partner site's prefixed one); null when entered by hand without one. */
  shownRef: z.string().nullable(),
});
export type LeadTargetDto = z.infer<typeof LeadTargetDto>;

/** The lead's client, as the inbox shows it (the holder's own contact). */
export const LeadContactDto = z.strictObject({
  id: z.uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  primaryPhone: z.string().nullable(),
});

const leadFields = {
  id: z.uuid(),
  source: LeadSource,
  kind: LeadKind,
  status: LeadStatus,
  /** The pipeline stage it is in (S10-03); `status` is that stage's. */
  stageId: z.uuid(),
  contact: LeadContactDto,
  /** The agency that presented the target to the client; null: the owner's own channel (marketplace). */
  presentingAgencyId: z.uuid().nullable(),
  /** The target's owner when it is another agency (it sees an introduction, never the client). */
  ownerAgencyId: z.uuid().nullable(),
  target: LeadTargetDto.nullable(),
  locale: z.string().nullable(),
  assignedUserId: z.uuid().nullable(),
  assignedAt: z.iso.datetime().nullable(),
  firstRespondedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
};

export const LeadListItemDto = z.strictObject(leadFields);
export type LeadListItemDto = z.infer<typeof LeadListItemDto>;
export const LeadPage = pageOf(LeadListItemDto);
export type LeadPage = z.infer<typeof LeadPage>;

/**
 * The details the client gave through a channel (a website form), as given. A form never rewrites an existing contact
 * (anyone can type anyone's address): the agent compares these with the contact and updates it by hand.
 */
export const LeadVisitorDto = z.strictObject({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  marketingConsent: z.boolean(),
});

export const LeadDto = z.strictObject({
  ...leadFields,
  message: z.string().nullable(),
  visitor: LeadVisitorDto.nullable(),
  /** The website lead it was promoted from (S7-05), if any. */
  inboundLeadId: z.uuid().nullable(),
  createdBy: z.uuid().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type LeadDto = z.infer<typeof LeadDto>;

/**
 * `GET /v1/crm/leads`: the unified inbox, newest first, keyset. `assigned`: `me`, `unassigned` or a member's id;
 * `status` and `source` filter too.
 */
export const ListLeadsQuery = PageQuery.extend({
  status: LeadStatus.optional(),
  /** One pipeline stage (S10-03: the list view of the board). */
  stageId: z.uuid().optional(),
  source: LeadSource.optional(),
  assigned: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
});
export type ListLeadsQuery = z.infer<typeof ListLeadsQuery>;

export const LeadParams = z.strictObject({ id: z.uuid() });
export type LeadParams = z.infer<typeof LeadParams>;

/**
 * `POST /v1/crm/leads`: a lead entered by hand for one of the agency's contacts. The target may be the agency's own
 * listing or one it can see on the network (its owner then gets an introduction). Without `assignedUserId` the
 * agency's assignment rule applies; `null` leaves it unassigned. Accepts an `Idempotency-Key` (24 h replay of the same
 * body; another body with the key is `IDEMPOTENCY_KEY_REUSED`).
 */
export const CreateLeadBody = z.strictObject({
  contactId: z.uuid(),
  source: z.enum(MANUAL_LEAD_SOURCES).default('MANUAL'),
  kind: LeadKind.default('ENQUIRY'),
  target: z
    .strictObject({
      kind: LeadTargetKind,
      id: z.uuid(),
      shownRef: z.string().trim().min(1).max(CRM_LEAD_LIMITS.shownRefChars).optional(),
    })
    .optional(),
  message: z.string().trim().min(1).max(CRM_LEAD_LIMITS.messageChars).optional(),
  assignedUserId: z.uuid().nullable().optional(),
});
export type CreateLeadBody = z.infer<typeof CreateLeadBody>;
export type CreateLeadInput = z.input<typeof CreateLeadBody>;

/**
 * `PATCH /v1/crm/leads/:id`: status and assignment (`null`: unassign), at `version`. A status moves the lead to the
 * agency's first active stage standing for it (S10-03), like a move on the board.
 */
export const UpdateLeadBody = z
  .strictObject({
    version: z.number().int().min(1),
    status: LeadStatus.optional(),
    assignedUserId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedUserId !== undefined, {
    message: 'status or assignedUserId is required',
    path: ['status'],
  });
export type UpdateLeadBody = z.infer<typeof UpdateLeadBody>;

/** The owner's view of a lead on its listing / development / unit: who introduced a client, never the client. */
export const LeadIntroductionDto = z.strictObject({
  leadId: z.uuid(),
  introducerAgencyId: z.uuid(),
  /** The introducer's directory name; null when it is not listed (any more). */
  introducerName: z.string().nullable(),
  source: LeadSource,
  kind: LeadKind,
  /** Entered by a member of the introducer (a call, a portal e-mail), not sent by the client through a channel. */
  handEntered: z.boolean(),
  target: z.strictObject({ kind: LeadTargetKind, id: z.uuid() }),
  createdAt: z.iso.datetime(),
});
export type LeadIntroductionDto = z.infer<typeof LeadIntroductionDto>;
export const LeadIntroductionPage = pageOf(LeadIntroductionDto);
export type LeadIntroductionPage = z.infer<typeof LeadIntroductionPage>;

/** `GET /v1/crm/lead-routing`: the agency's assignment rule (`version` 0: never set, the default applies). */
export const LeadRoutingDto = z.strictObject({
  mode: LeadAssignmentMode,
  /** The round-robin pool; empty: every active member who works clients. */
  agentUserIds: z.array(z.uuid()),
  version: z.number().int().min(0),
});
export type LeadRoutingDto = z.infer<typeof LeadRoutingDto>;

/** `PUT /v1/crm/lead-routing` (admins): the whole rule, at `version`. Every pool member must be an active member. */
export const UpdateLeadRoutingBody = z.strictObject({
  version: z.number().int().min(0),
  mode: LeadAssignmentMode,
  agentUserIds: z.array(z.uuid()).max(CRM_LEAD_LIMITS.roundRobinAgents).default([]),
});
export type UpdateLeadRoutingBody = z.infer<typeof UpdateLeadRoutingBody>;
