import { defineEvent } from '@inmolink/platform/outbox';
import { z } from 'zod';

/**
 * agencies events (PATTERNS §8), emitted in the same transaction as the change. IDs only. Sign-up
 * creates the agency inside the `app_auth` transaction, which may only append `identity.*` events:
 * `identity.user.registered` covers it.
 */
export const agenciesEvents = {
  /** Company details saved (onboarding or a later edit). Staff verification (S1-03) reacts to the first. */
  detailsUpdated: defineEvent(
    'agencies.details.updated',
    1,
    z.object({ agencyId: z.uuid(), version: z.number().int(), firstOnboarding: z.boolean() }),
  ),
  /** The agency submitted its details and documents for staff verification (S1-03). */
  verificationSubmitted: defineEvent(
    'agencies.verification.submitted',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid() }),
  ),
  /** Staff approved or rejected a request (S1-03). The agency's admins get an email. */
  verificationDecided: defineEvent(
    'agencies.verification.decided',
    1,
    z.object({ agencyId: z.uuid(), requestId: z.uuid(), decision: z.enum(['APPROVED', 'REJECTED']) }),
  ),
  /**
   * The agency's settings changed (S1-06). The agencies module's settings cache invalidates on it; other
   * caches of settings-derived data (site configs, S7) subscribe too. `changed` names the top-level
   * settings fields that differ. Who acted, and the staff member impersonating them if any, for the
   * audit log (S1-08).
   */
  settingsChanged: defineEvent(
    'agencies.settings.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      version: z.number().int(),
      changed: z.array(z.string()),
      actorUserId: z.uuid(),
      impersonatedBy: z.uuid().nullable(),
    }),
  ),
  /**
   * The agency's profile (logo, colours, contact, texts) changed (S1-06): white-labelled outputs (site
   * configs S7, selections S12) refresh their branding. `logoChanged` when the logo was replaced or removed.
   */
  profileUpdated: defineEvent(
    'agencies.profile.updated',
    1,
    z.object({
      agencyId: z.uuid(),
      version: z.number().int(),
      logoChanged: z.boolean(),
      actorUserId: z.uuid(),
      impersonatedBy: z.uuid().nullable(),
    }),
  ),
  /**
   * The agency's status changed (S1-03: PENDING → VERIFIED; suspension later). Caches of anything the
   * status gates (API keys S1-05, site configs) invalidate on it; `withMemberCtx` reads it per request.
   */
  statusChanged: defineEvent(
    'agencies.status.changed',
    1,
    z.object({
      agencyId: z.uuid(),
      from: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']),
      to: z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']),
      version: z.number().int(),
    }),
  ),
  /**
   * The agency added a preferred agency (S1-07): its listings shared to PREFERRED now reach it; search
   * (S3) re-filters the partner's network view on it. Who acted — adding is refused while staff
   * impersonate an admin, so `impersonatedBy` is null today; the field keeps the payload uniform.
   */
  preferredAdded: defineEvent(
    'agencies.preferred.added',
    1,
    z.object({
      agencyId: z.uuid(),
      preferredAgencyId: z.uuid(),
      actorUserId: z.uuid(),
      impersonatedBy: z.uuid().nullable(),
    }),
  ),
  /**
   * The agency replaced its internal note on a preferred agency (S1-07), for the audit log (S1-08). Never
   * the note text: notes are internal and events are read by workers of other modules. Staff impersonating
   * an admin may edit notes; the event names both of them.
   */
  preferredNoteUpdated: defineEvent(
    'agencies.preferred.noteUpdated',
    1,
    z.object({
      agencyId: z.uuid(),
      preferredAgencyId: z.uuid(),
      actorUserId: z.uuid(),
      impersonatedBy: z.uuid().nullable(),
    }),
  ),
  /**
   * The agency removed a preferred agency (S1-07): its PREFERRED listings stop reaching it from the next
   * query on (RLS, no cache); search (S3) drops them from the partner's view. Staff impersonating an
   * admin may remove (it only narrows access); the event names both of them.
   */
  preferredRemoved: defineEvent(
    'agencies.preferred.removed',
    1,
    z.object({
      agencyId: z.uuid(),
      preferredAgencyId: z.uuid(),
      actorUserId: z.uuid(),
      impersonatedBy: z.uuid().nullable(),
    }),
  ),
};
