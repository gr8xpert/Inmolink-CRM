import { z } from 'zod';
import { AgencyKind, AgencyStatus } from './agencies';
import { PageQuery, pageOf } from './common';
import { AuditActorKind } from './compliance';
import { STAFF_ROLES } from './values';
import { VerificationRequestStatus } from './verification';

/**
 * Staff console DTOs (S1-09, PLAN §7 M20): tenants, impersonation and the cross-agency audit log. Every
 * route is under `/v1/staff/…` and answers 403 to anyone who is not active staff (ADR 0015).
 */

export const StaffRole = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRole>;

/** Longest impersonation session; the table's CHECK and the 0026 guard enforce it too. */
export const IMPERSONATION_MAX_MINUTES = 60;
export const IMPERSONATION_DEFAULT_MINUTES = 30;

/**
 * Why staff act (support ticket, what they will check): 10–500 characters. Stored on the row the action changes (the
 * impersonation session, the agency's give-to-get exemption), never in the audit log (free text). Line breaks
 * normalized; other control characters and < > refused.
 */
export const StaffReason = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(10)
      .max(500)
      .regex(/^(?:[^\p{Cc}<>]|\n)*$/u, 'no control characters (except line breaks) or < >'),
  );

/** Why staff impersonate (S1-09): a `StaffReason`. */
export const ImpersonationReason = StaffReason;

/** `POST /v1/staff/impersonations`: act as one active member of an agency, for at most 60 minutes. */
export const StartImpersonationBody = z
  .object({
    agencyId: z.uuid(),
    userId: z.uuid(),
    reason: ImpersonationReason,
    minutes: z.number().int().min(5).max(IMPERSONATION_MAX_MINUTES).default(IMPERSONATION_DEFAULT_MINUTES),
  })
  .strict();
export type StartImpersonationInput = z.infer<typeof StartImpersonationBody>;

export const ImpersonationParams = z.object({ id: z.uuid() }).strict();
export type ImpersonationParams = z.infer<typeof ImpersonationParams>;

/** An open impersonation session, as the staff member who started it sees it. */
export const ImpersonationDto = z.object({
  id: z.uuid(),
  agencyId: z.uuid(),
  agencyName: z.string(),
  userId: z.uuid(),
  userName: z.string(),
  startedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type ImpersonationDto = z.infer<typeof ImpersonationDto>;

/** `GET /v1/staff/me`: the caller's staff role and open impersonation session, if any. */
export const StaffMeDto = z.object({
  userId: z.uuid(),
  role: StaffRole,
  impersonation: ImpersonationDto.nullable(),
});
export type StaffMeDto = z.infer<typeof StaffMeDto>;

/** `GET /v1/staff/agencies`: newest first; `q` matches the name (substring) or the tax id (exact). */
export const TenantListQuery = PageQuery.extend({
  q: z.string().trim().min(2).max(100).optional(),
  status: AgencyStatus.optional(),
});
export type TenantListQuery = z.infer<typeof TenantListQuery>;

export const TenantSummaryDto = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: AgencyKind,
  status: AgencyStatus,
  taxId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TenantSummaryDto = z.infer<typeof TenantSummaryDto>;
export const TenantPage = pageOf(TenantSummaryDto);
export type TenantPage = z.infer<typeof TenantPage>;

export const TenantParams = z.object({ agencyId: z.uuid() }).strict();
export type TenantParams = z.infer<typeof TenantParams>;

/** `GET /v1/staff/agencies/:agencyId`: the company and its latest verification request. */
export const TenantDetailDto = TenantSummaryDto.extend({
  registerNumber: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  onboarded: z.boolean(),
  /** Searches the network without sharing listings (give-to-get exemption, PLAN §3 #5; S5-05). */
  giveToGetExempt: z.boolean(),
  /** Why staff last set or ended the exemption (S6-F1); null when they never changed it. */
  giveToGetReason: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  verification: z
    .object({
      requestId: z.uuid(),
      status: VerificationRequestStatus,
      submittedAt: z.iso.datetime(),
      decidedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type TenantDetailDto = z.infer<typeof TenantDetailDto>;

/**
 * `PUT /v1/staff/agencies/:agencyId/give-to-get`: exempt a buyer-only agency from give-to-get, or end it (S5-05). S6-F1:
 * with the staff member's reason, kept on the agency; the audit entry records the exemption before and after.
 */
export const SetGiveToGetExemptionBody = z.strictObject({ exempt: z.boolean(), reason: StaffReason });
export type SetGiveToGetExemptionBody = z.infer<typeof SetGiveToGetExemptionBody>;

/** Audit types are `<module>.<entity>.<change>`. */
export const AuditTypeFilter = z
  .string()
  .max(100)
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,4}$/);

/**
 * `GET /v1/staff/audit-logs`: every agency's log (or one agency's), newest first, keyset ≤ 100. `from`
 * is inclusive, `to` exclusive. Reading is itself audited (`staff.auditLog.read`).
 */
export const StaffAuditQuery = PageQuery.extend({
  agencyId: z.uuid().optional(),
  type: AuditTypeFilter.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type StaffAuditQuery = z.infer<typeof StaffAuditQuery>;

/** One audit-log entry as staff see it: both actors (the user and the staff member impersonating them). */
export const StaffAuditEntryDto = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  agencyId: z.uuid(),
  /** The agency's name; null for platform rows (no agency) and ids that no longer resolve. */
  agencyName: z.string().nullable(),
  type: z.string(),
  actor: z.object({
    kind: AuditActorKind,
    userId: z.uuid().nullable(),
    userName: z.string().nullable(),
    impersonatedBy: z.uuid().nullable(),
    impersonatedByName: z.string().nullable(),
  }),
  target: z.object({ type: z.string(), id: z.uuid(), name: z.string().nullable() }).nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type StaffAuditEntryDto = z.infer<typeof StaffAuditEntryDto>;
export const StaffAuditPage = pageOf(StaffAuditEntryDto);
export type StaffAuditPage = z.infer<typeof StaffAuditPage>;

/** A live session of any staff member, for super admins (S1-F9): who is acting as whom, until when. */
export const LiveImpersonationDto = ImpersonationDto.extend({
  staffUserId: z.uuid(),
  staffName: z.string(),
});
export type LiveImpersonationDto = z.infer<typeof LiveImpersonationDto>;
/** At most one open session per staff member: the list is as long as the staff team, so it is not paged. */
export const LiveImpersonationList = z.object({ items: z.array(LiveImpersonationDto) });
export type LiveImpersonationList = z.infer<typeof LiveImpersonationList>;
