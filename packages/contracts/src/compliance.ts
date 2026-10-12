import { z } from 'zod';
import { pageOf } from './common';

/** compliance DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */

/** Who acted (S1-08). `anonymous`: a failed login names only the account it targeted. */
export const AuditActorKind = z.enum(['user', 'staff', 'system', 'apiKey', 'anonymous']);
export type AuditActorKind = z.infer<typeof AuditActorKind>;

/**
 * One audit-log entry, as the agency's admins see it (`GET /v1/agency/audit-log`). Staff identities are
 * not shown to tenants: `impersonated` says a staff member acted as `userId` (S1-09), and staff actions
 * show `kind: 'staff'` without the staff user's id.
 */
export const AuditLogEntryDto = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  /** `<module>.<entity>.<change>`, e.g. `identity.login.failed`. New types may appear; treat unknown ones generically. */
  type: z.string(),
  actor: z.object({
    kind: AuditActorKind,
    userId: z.uuid().nullable(),
    impersonated: z.boolean(),
  }),
  target: z.object({ type: z.string(), id: z.uuid() }).nullable(),
  requestId: z.string().nullable(),
  /** Small, non-secret details: ids, field names, outcomes. */
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditLogEntryDto = z.infer<typeof AuditLogEntryDto>;

export const AuditLogPage = pageOf(AuditLogEntryDto);
export type AuditLogPage = z.infer<typeof AuditLogPage>;
