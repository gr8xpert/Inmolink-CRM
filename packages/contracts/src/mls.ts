/**
 * MLS collaboration (PLAN §3 #8, §7 M10). S11-01, client registration: an introducer agency registers one of its
 * contacts (a buyer) for another agency's listing or development. The client is matched across agencies by a keyed
 * fingerprint of each normalized e-mail and phone — never by the identifiers themselves — and the first registration
 * still valid wins: a second agency registering the same client for the same target is refused
 * (`REGISTRATION_CONFLICT`). The owner of the target sees who registered a client and when, never the client.
 */
import { z } from 'zod';
import { PageQuery, pageOf } from './common';

export const REGISTRATION_TARGET_KINDS = ['LISTING', 'DEVELOPMENT'] as const;
export const RegistrationTargetKind = z.enum(REGISTRATION_TARGET_KINDS);
export type RegistrationTargetKind = z.infer<typeof RegistrationTargetKind>;

export const REGISTRATION_STATES = ['ACTIVE', 'EXPIRED'] as const;
export const RegistrationState = z.enum(REGISTRATION_STATES);
export type RegistrationState = z.infer<typeof RegistrationState>;

export const RegistrationTarget = z.strictObject({ kind: RegistrationTargetKind, id: z.uuid() });
export type RegistrationTarget = z.infer<typeof RegistrationTarget>;

/**
 * `POST /v1/mls/registrations`: register the agency's contact for another agency's listing or development. Valid from
 * now for the shorter of both agencies' `registrationValidityDays` (settings, default 180). Registering the same client
 * for the same target again while its registration is valid answers that registration (200, nothing new is written).
 * Refused: `REGISTRATION_CONFLICT` (another agency was first), `RATE_LIMITED` (over the agency's daily conflict
 * budget: 20, then a day's pause), `REGISTRATION_TARGET_NOT_FOUND`.
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
  /** The target's owner agency. */
  ownerAgencyId: z.uuid(),
  registeredByUserId: z.uuid().nullable(),
  registeredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** By the database's clock when listed: `ACTIVE` until `expiresAt`. */
  state: RegistrationState,
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
 * (the target publishes no commission or split), `VIEWING_REQUEST_OPEN` (already one open), `VALIDATION_FAILED`.
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
