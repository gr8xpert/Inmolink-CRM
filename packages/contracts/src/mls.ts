/**
 * MLS collaboration (PLAN §3 #8, §7 M10). S11-01, client registration: an introducer agency registers one of its
 * contacts (a buyer) for another agency's listing or development. The client is matched across agencies by a keyed
 * fingerprint of each normalized e-mail and phone — never by the identifiers themselves — and the first registration
 * still valid wins: a second agency registering the same client for the same target is refused
 * (`REGISTRATION_CONFLICT`). The owner of the target sees who registered a client and when, never the client.
 */
import { z } from 'zod';
import { CurrencyCode, PageQuery, pageOf } from './common';
import { fileNameHeaders } from './file-name-header';

export const REGISTRATION_TARGET_KINDS = ['LISTING', 'DEVELOPMENT'] as const;
export const RegistrationTargetKind = z.enum(REGISTRATION_TARGET_KINDS);
export type RegistrationTargetKind = z.infer<typeof RegistrationTargetKind>;

export const REGISTRATION_STATES = ['ACTIVE', 'EXPIRED'] as const;
export const RegistrationState = z.enum(REGISTRATION_STATES);
export type RegistrationState = z.infer<typeof RegistrationState>;

export const RegistrationTarget = z.strictObject({ kind: RegistrationTargetKind, id: z.uuid() });
export type RegistrationTarget = z.infer<typeof RegistrationTarget>;

/**
 * What a person recognises the target by (S12-F21): the listing's or development's reference and its title (a
 * listing's text in the caller's locale, a development's brand name). From the listing read models in one batched
 * query per page, never a join per row. Null when the caller can no longer read the target (left the network, deleted).
 */
export const TargetLabel = z.strictObject({ reference: z.string(), title: z.string().nullable() });
export type TargetLabel = z.infer<typeof TargetLabel>;

/**
 * `POST /v1/mls/registrations`: register the agency's contact for another agency's listing or development. Valid from
 * now for the shorter of both agencies' `registrationValidityDays` (settings, default 180). Registering the same client
 * for the same target again while its registration is valid answers that registration (200, nothing new is written).
 * Refused: `REGISTRATION_CONFLICT` (another agency was first), `RATE_LIMITED` (over the agency's daily conflict
 * budget: 20, then a day's pause), `REGISTRATION_TARGET_NOT_FOUND`, `NETWORK_GIVE_TO_GET_LOCKED` (S17-F56: too few
 * listings shared).
 */
export const CreateRegistrationBody = z.strictObject({ contactId: z.uuid(), target: RegistrationTarget });
export type CreateRegistrationBody = z.infer<typeof CreateRegistrationBody>;

/** The client as the introducer registered them (a snapshot: later contact edits do not change it). */
export const RegisteredClientDto = z.strictObject({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
});
export type RegisteredClientDto = z.infer<typeof RegisteredClientDto>;

/** The introducer's own registration: with the client (internal to the introducer — never shown in Client Mode). */
export const RegistrationDto = z.strictObject({
  id: z.uuid(),
  /** The agency's contact (follows a contact merge). */
  contactId: z.uuid(),
  client: RegisteredClientDto,
  target: RegistrationTarget,
  targetLabel: TargetLabel.nullable(),
  /** The target's owner agency. */
  ownerAgencyId: z.uuid(),
  registeredByUserId: z.uuid().nullable(),
  registeredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** By the database's clock when listed: `ACTIVE` until `expiresAt`. */
  state: RegistrationState,
  /** S17-F56: a viewing request of this registration is open (requested or scheduled), so another is refused. */
  hasOpenViewing: z.boolean(),
});
export type RegistrationDto = z.infer<typeof RegistrationDto>;
export const RegistrationPage = pageOf(RegistrationDto);
export type RegistrationPage = z.infer<typeof RegistrationPage>;

/** `GET /v1/mls/registrations`: the agency's registrations (expired ones too: `expiresAt`), newest first, keyset. */
/** `from` must not be after `to` (ISO dates compare as strings). */
const fromBeforeTo = (q: { from?: string | undefined; to?: string | undefined }) => !q.from || !q.to || q.from <= q.to;
const FROM_TO_MESSAGE = { message: 'from must not be after to', path: ['from'] };

export const ListRegistrationsQuery = PageQuery.extend({
  /** S11-06: `ACTIVE` (still valid) or `EXPIRED`, by the database's clock. */
  state: RegistrationState.optional(),
  kind: RegistrationTargetKind.optional(),
  /** Registered on or after / on or before this date (UTC days). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(fromBeforeTo, FROM_TO_MESSAGE);
export type ListRegistrationsQuery = z.infer<typeof ListRegistrationsQuery>;

/**
 * `GET /v1/mls/received-registrations`: what the owner of a target sees — "registered by Agency X" and the validity,
 * never the client (no name, e-mail, phone, contact or fingerprint).
 */
export const ReceivedRegistrationDto = z.strictObject({
  id: z.uuid(),
  introducerAgencyId: z.uuid(),
  /** The introducer's directory name; null when it is not listed (any more). */
  introducerName: z.string().nullable(),
  target: RegistrationTarget,
  targetLabel: TargetLabel.nullable(),
  registeredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  state: RegistrationState,
});
export type ReceivedRegistrationDto = z.infer<typeof ReceivedRegistrationDto>;
export const ReceivedRegistrationPage = pageOf(ReceivedRegistrationDto);
export type ReceivedRegistrationPage = z.infer<typeof ReceivedRegistrationPage>;

// ---- S11-02, viewing requests and the terms snapshot (PLAN §3 #9) ----------------------------------------------------

export const VIEWING_STATUSES = ['REQUESTED', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED'] as const;
export const ViewingStatus = z.enum(VIEWING_STATUSES);
export type ViewingStatus = z.infer<typeof ViewingStatus>;

/** The two parties: the introducer (who registered the client) and the owner of the listing or development. */
export const VIEWING_SIDES = ['INTRODUCER', 'OWNER'] as const;
export const ViewingSide = z.enum(VIEWING_SIDES);
export type ViewingSide = z.infer<typeof ViewingSide>;

/** S17-F56: what the caller may do with a viewing request now. */
export const VIEWING_ACTIONS = ['ACCEPT', 'DECLINE', 'RESCHEDULE', 'CANCEL', 'OUTCOME'] as const;
export const ViewingAction = z.enum(VIEWING_ACTIONS);
export type ViewingAction = z.infer<typeof ViewingAction>;

export const VIEWING_OUTCOMES = ['ATTENDED', 'NO_SHOW'] as const;
export const ViewingOutcome = z.enum(VIEWING_OUTCOMES);
export type ViewingOutcome = z.infer<typeof ViewingOutcome>;

/** A proposed start: an ISO date-time with offset, in the future (checked by the service against the clock). */
const ProposedStartAt = z.iso.datetime({ offset: true });

/**
 * `POST /v1/mls/viewing-requests` (`Idempotency-Key` optional): ask the owner for a viewing of the client of one of the
 * agency's valid registrations, at `proposedStartAt` (before the registration ends). The terms are the target's own
 * when requested (commission or fixed amount, split, VAT) — the introducer accepts them by requesting. One open request
 * per registration. Refused: `REGISTRATION_NOT_FOUND` (no valid registration of the agency), `VIEWING_TERMS_INCOMPLETE`
 * (the target publishes no commission or split), `VIEWING_REQUEST_OPEN` (already one open), `VALIDATION_FAILED`,
 * `NETWORK_GIVE_TO_GET_LOCKED` (S17-F56: too few listings shared; answers to what is already open stay allowed).
 */
export const ViewingRequestParams = z.strictObject({ id: z.uuid() });
export type ViewingRequestParams = z.infer<typeof ViewingRequestParams>;

export const CreateViewingRequestBody = z.strictObject({
  registrationId: z.uuid(),
  proposedStartAt: ProposedStartAt,
});
export type CreateViewingRequestBody = z.infer<typeof CreateViewingRequestBody>;

/** `POST /v1/mls/viewing-requests/:id/reschedule`: propose another time; the other side must answer it. */
export const RescheduleViewingBody = z.strictObject({ proposedStartAt: ProposedStartAt });
export type RescheduleViewingBody = z.infer<typeof RescheduleViewingBody>;

/** `POST /v1/mls/viewing-requests/:id/outcome`: after the scheduled time, either side records how it went. */
export const ViewingOutcomeBody = z.strictObject({ outcome: ViewingOutcome });
export type ViewingOutcomeBody = z.infer<typeof ViewingOutcomeBody>;

/**
 * The terms snapshot (PLAN §3 #9): the target's commission as a percentage (`commissionBp`) or a fixed amount, the
 * introducer's share (`splitBp`), whether VAT is included, and until when it binds (the registration's end). Accepted by
 * the introducer when requesting and by the owner when accepting; immutable from then on.
 */
export const ViewingTermsDto = z.strictObject({
  commissionBp: z.number().int().nullable(),
  commissionFixed: z.strictObject({ amountCents: z.number().int(), currency: z.string().length(3) }).nullable(),
  splitBp: z.number().int(),
  includesVat: z.boolean(),
  validUntil: z.iso.datetime(),
  snapshotAt: z.iso.datetime(),
  introducerAcceptedAt: z.iso.datetime(),
  introducerAcceptedByUserId: z.uuid().nullable(),
  ownerAcceptedAt: z.iso.datetime().nullable(),
  ownerAcceptedByUserId: z.uuid().nullable(),
  /** Both sides accepted: nothing of the terms changes any more. */
  accepted: z.boolean(),
});
export type ViewingTermsDto = z.infer<typeof ViewingTermsDto>;

/**
 * A viewing request as one side sees it. `side` is the caller's. The introducer also sees its registration and contact;
 * the owner sees the introducer agency and never the client (no registration, contact, name, e-mail or phone).
 */
export const ViewingRequestDto = z.strictObject({
  id: z.uuid(),
  side: ViewingSide,
  /** The other party's agency, and its directory name (null when not listed). */
  counterpartAgencyId: z.uuid(),
  counterpartName: z.string().nullable(),
  /** Introducer only (null for the owner). */
  registrationId: z.uuid().nullable(),
  contactId: z.uuid().nullable(),
  target: RegistrationTarget,
  targetLabel: TargetLabel.nullable(),
  status: ViewingStatus,
  /** `REQUESTED` only: the side that must answer `proposedStartAt`. */
  awaiting: ViewingSide.nullable(),
  proposedStartAt: z.iso.datetime(),
  scheduledAt: z.iso.datetime().nullable(),
  /** An unanswered proposal expires here. */
  expiresAt: z.iso.datetime().nullable(),
  outcome: ViewingOutcome.nullable(),
  outcomeAt: z.iso.datetime().nullable(),
  closedBy: z.enum(['INTRODUCER', 'OWNER', 'SYSTEM']).nullable(),
  terms: ViewingTermsDto,
  /**
   * S17-F56: whether this member may bind the agency to the terms (accept, or propose a time): on the owner's side its
   * admins or the listing's agent; the introducer accepted by requesting. False for a member who may not answer at all.
   */
  mayBind: z.boolean(),
  /** S17-F56: the answers the API takes from this member in this state, by the database's clock. */
  allowedActions: z.array(ViewingAction),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ViewingRequestDto = z.infer<typeof ViewingRequestDto>;
export const ViewingRequestPage = pageOf(ViewingRequestDto);
export type ViewingRequestPage = z.infer<typeof ViewingRequestPage>;

/** S11-06, `GET /v1/mls/viewing-requests` and `/received-viewing-requests`: filter by state, target kind and created date. */
export const ListViewingRequestsQuery = PageQuery.extend({
  status: ViewingStatus.optional(),
  kind: RegistrationTargetKind.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(fromBeforeTo, FROM_TO_MESSAGE);
export type ListViewingRequestsQuery = z.infer<typeof ListViewingRequestsQuery>;

/**
 * `GET /v1/mls/viewing-requests/:id/terms`: the accepted terms with their audit trail. `pdfUrl` stays null until the PDF
 * service exists (S12-05 renders the accepted-terms PDF; stub).
 */
export const ViewingTermsDocumentDto = z.strictObject({
  requestId: z.uuid(),
  introducerAgencyId: z.uuid(),
  ownerAgencyId: z.uuid(),
  target: RegistrationTarget,
  terms: ViewingTermsDto,
  pdfUrl: z.string().nullable(),
});
export type ViewingTermsDocumentDto = z.infer<typeof ViewingTermsDocumentDto>;

// ---- R2-04a, the deal room (PLAN §3 #10, §7 M10) ------------------------------------------------------------------------

/**
 * A deal between the two agencies of an accepted viewing request: `OFFER` → `RESERVATION` → `ARRAS` → `COMPLETION`, or
 * `FELL_THROUGH` from any open stage. `COMPLETION` is reached only by the handshake — both sides confirm the completion
 * at the current price. A completed or fallen-through deal is immutable except by staff mediation (audited).
 */
export const DEAL_STAGES = ['OFFER', 'RESERVATION', 'ARRAS', 'COMPLETION', 'FELL_THROUGH'] as const;
export const DealStage = z.enum(DEAL_STAGES);
export type DealStage = z.infer<typeof DealStage>;

/** The stages a party moves a deal forward to by hand (completion is the handshake's, a fall-through its own move). */
export const DEAL_ADVANCE_STAGES = ['RESERVATION', 'ARRAS'] as const;

/** The moves the API takes from this member on this deal now. */
export const DEAL_ACTIONS = ['ADVANCE', 'SET_PRICE', 'CONFIRM', 'WITHDRAW', 'FALL_THROUGH'] as const;
export const DealAction = z.enum(DEAL_ACTIONS);
export type DealAction = z.infer<typeof DealAction>;

/** A sale price: integer cents, 1 cent to 100 bn (`deals_price_ck`). */
export const DEAL_PRICE_MAX_CENTS = 10_000_000_000_000;
export const DealPrice = z.strictObject({
  amountCents: z.number().int().min(1).max(DEAL_PRICE_MAX_CENTS),
  currency: CurrencyCode,
});
export type DealPrice = z.infer<typeof DealPrice>;

const DealText = z.string().trim().min(1).max(2_000);

export const DealParams = z.strictObject({ id: z.uuid() });
export type DealParams = z.infer<typeof DealParams>;

/**
 * `POST /v1/mls/deals`: either party opens the deal of an accepted viewing request (the owner accepted the terms; the
 * viewing scheduled, or completed with the client attended) at the offered price. A fixed commission is in its own
 * currency: the price must be too. One live deal per viewing request: a repeat answers the live one (200).
 * Refused: `VIEWING_REQUEST_NOT_FOUND`, `DEAL_VIEWING_NOT_ELIGIBLE`, `VALIDATION_FAILED` (`currency`).
 */
export const CreateDealBody = z.strictObject({ viewingRequestId: z.uuid(), price: DealPrice });
export type CreateDealBody = z.infer<typeof CreateDealBody>;

/** `POST /v1/mls/deals/:id/advance`: move the deal forward (never back; skipping a stage is allowed). */
export const AdvanceDealBody = z.strictObject({ stage: z.enum(DEAL_ADVANCE_STAGES) });
export type AdvanceDealBody = z.infer<typeof AdvanceDealBody>;

/** `POST /v1/mls/deals/:id/price`: the agreed price changed — both sides' confirmations are cleared. */
export const SetDealPriceBody = z.strictObject({ price: DealPrice });
export type SetDealPriceBody = z.infer<typeof SetDealPriceBody>;

/**
 * `POST /v1/mls/deals/:id/confirm`: the caller's side confirms the completion at `price` — the price it saw (a price
 * changed meanwhile answers `DEAL_STATE` `price_changed`). The second confirmation completes the deal.
 */
export const ConfirmDealBody = z.strictObject({ price: DealPrice });
export type ConfirmDealBody = z.infer<typeof ConfirmDealBody>;

/** `POST /v1/mls/deals/:id/fall-through`: either party closes an open deal as fallen through, with a reason. */
export const FallThroughDealBody = z.strictObject({ reason: DealText });
export type FallThroughDealBody = z.infer<typeof FallThroughDealBody>;

/** The terms snapshot the deal carries (copied from the viewing request when opened; never changed). */
export const DealTermsDto = z.strictObject({
  commissionBp: z.number().int().nullable(),
  commissionFixed: z.strictObject({ amountCents: z.number().int(), currency: z.string().length(3) }).nullable(),
  splitBp: z.number().int(),
  includesVat: z.boolean(),
  snapshotAt: z.iso.datetime(),
});
export type DealTermsDto = z.infer<typeof DealTermsDto>;

/**
 * The commission of the current price, computed by the database from the snapshot (integer cents, half-up to the cent):
 * total = price × `commissionBp` / 10,000 (or the fixed amount); the introducer's share = total × `splitBp` / 10,000;
 * the owner's = total − the introducer's. VAT as the terms say (`includesVat`).
 */
export const DealCommissionDto = z.strictObject({
  totalCents: z.number().int(),
  introducerShareCents: z.number().int(),
  ownerShareCents: z.number().int(),
  currency: z.string().length(3),
  includesVat: z.boolean(),
});
export type DealCommissionDto = z.infer<typeof DealCommissionDto>;

const DealCore = {
  id: z.uuid(),
  viewingRequestId: z.uuid(),
  target: RegistrationTarget,
  stage: DealStage,
  stageAt: z.iso.datetime(),
  price: DealPrice,
  terms: DealTermsDto,
  commission: DealCommissionDto,
  ownerConfirmedAt: z.iso.datetime().nullable(),
  introducerConfirmedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  fellThroughAt: z.iso.datetime().nullable(),
  fellThroughReason: z.string().nullable(),
  closedBy: z.enum(['OWNER', 'INTRODUCER', 'STAFF']).nullable(),
  /** The last staff mediation (when and why), if any. */
  mediatedAt: z.iso.datetime().nullable(),
  mediationReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/** A deal as one party sees it. `party` is the caller's side; the counterpart's member ids are never shown. */
export const DealDto = z.strictObject({
  ...DealCore,
  party: ViewingSide,
  counterpartAgencyId: z.uuid(),
  counterpartName: z.string().nullable(),
  targetLabel: TargetLabel.nullable(),
  allowedActions: z.array(DealAction),
});
export type DealDto = z.infer<typeof DealDto>;
export const DealPage = pageOf(DealDto);
export type DealPage = z.infer<typeof DealPage>;

/** `GET /v1/mls/deals`: the agency's deals (both sides), newest first; optionally one stage. */
export const ListDealsQuery = PageQuery.extend({ stage: DealStage.optional() });
export type ListDealsQuery = z.infer<typeof ListDealsQuery>;

/** Staff (mediation): a deal with both parties. */
export const StaffDealDto = z.strictObject({
  ...DealCore,
  ownerAgency: z.strictObject({ id: z.uuid(), name: z.string() }),
  introducerAgency: z.strictObject({ id: z.uuid(), name: z.string() }),
});
export type StaffDealDto = z.infer<typeof StaffDealDto>;

/**
 * `POST /v1/staff/deals/:id/mediate` (data ops, super admins): staff settle a dispute — set the stage (also back, or out
 * of `COMPLETION` / `FELL_THROUGH`) and / or the price, with a reason both parties see. Audited for both agencies.
 */
export const MediateDealBody = z
  .strictObject({ reason: DealText, stage: DealStage.optional(), price: DealPrice.optional() })
  .refine((b) => b.stage !== undefined || b.price !== undefined, { message: 'a stage or a price to set' });
export type MediateDealBody = z.infer<typeof MediateDealBody>;

// ---- R2-04b: the deal room's documents ------------------------------------------------------------------------------

/**
 * What a deal document is: the offer, the reservation contract, the arras contract, the deed (escritura), a commission
 * invoice, or anything else. Both parties read every document of the deal; only the uploading agency removes one.
 */
export const DEAL_DOCUMENT_KINDS = ['OFFER', 'RESERVATION', 'ARRAS', 'DEED', 'INVOICE', 'OTHER'] as const;
export const DealDocumentKind = z.enum(DEAL_DOCUMENT_KINDS);
export type DealDocumentKind = z.infer<typeof DealDocumentKind>;
/** One document: a PDF (checked by its magic bytes), at most 20 MB. */
export const DEAL_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Documents per deal (removed ones included: they stay listed as removed). */
export const DEAL_DOCUMENTS_MAX = 50;
/** How long an opened document's signed URL works. */
export const DEAL_DOCUMENT_URL_TTL_SECONDS = 300;

export const DealDocumentParams = z.strictObject({ id: z.uuid(), documentId: z.uuid() });
export type DealDocumentParams = z.infer<typeof DealDocumentParams>;

/** `POST /v1/mls/deals/:id/documents?kind=` — the raw PDF body, its name in `X-File-Name` (percent-encoded). */
export const UploadDealDocumentHeaders = fileNameHeaders(z.string().trim().min(1).max(200));
export const UploadDealDocumentQuery = z.strictObject({ kind: DealDocumentKind.optional() });
export type UploadDealDocumentQuery = z.infer<typeof UploadDealDocumentQuery>;

/**
 * A deal document as either party sees it. `ownAgency`: the caller's agency uploaded it (only it removes it, while the
 * deal is open). A removed document stays listed (who removed it and when) but no longer opens.
 */
export const DealDocumentDto = z.strictObject({
  id: z.uuid(),
  dealId: z.uuid(),
  kind: DealDocumentKind,
  fileName: z.string(),
  sizeBytes: z.number().int(),
  uploadedBy: z.strictObject({ name: z.string(), ownAgency: z.boolean() }),
  createdAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(),
});
export type DealDocumentDto = z.infer<typeof DealDocumentDto>;
export const DealDocumentList = z.strictObject({ items: z.array(DealDocumentDto) });
export type DealDocumentList = z.infer<typeof DealDocumentList>;

/** A short signed GET; the file downloads under its name. */
export const DealDocumentUrlDto = z.strictObject({ url: z.string(), expiresAt: z.iso.datetime() });
export type DealDocumentUrlDto = z.infer<typeof DealDocumentUrlDto>;
