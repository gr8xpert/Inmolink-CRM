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
});
export type RegistrationDto = z.infer<typeof RegistrationDto>;
export const RegistrationPage = pageOf(RegistrationDto);
export type RegistrationPage = z.infer<typeof RegistrationPage>;

/** `GET /v1/mls/registrations`: the agency's registrations (expired ones too: `expiresAt`), newest first, keyset. */
export const ListRegistrationsQuery = PageQuery;
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
});
export type ReceivedRegistrationDto = z.infer<typeof ReceivedRegistrationDto>;
export const ReceivedRegistrationPage = pageOf(ReceivedRegistrationDto);
export type ReceivedRegistrationPage = z.infer<typeof ReceivedRegistrationPage>;
