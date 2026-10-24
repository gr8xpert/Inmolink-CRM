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

// ---- data export (S10-08, PLAN §3 #59) -----------------------------------------------------------------------------

/** What an export holds: one table, or the whole account (a ZIP of the tables plus the media manifest). */
export const DataExportKind = z.enum(['CONTACTS', 'LEADS', 'LISTINGS', 'ACCOUNT']);
export type DataExportKind = z.infer<typeof DataExportKind>;
export const DataExportFormat = z.enum(['csv', 'xlsx']);
export type DataExportFormat = z.infer<typeof DataExportFormat>;
export const DataExportStatus = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED']);
export type DataExportStatus = z.infer<typeof DataExportStatus>;

/** Why an export failed: `TOO_LARGE` (past 4 GiB or Excel's row limit), `TIMEOUT` (its job was lost), `INTERNAL`. */
export const DataExportErrorCode = z.enum(['TOO_LARGE', 'TIMEOUT', 'INTERNAL']);
export type DataExportErrorCode = z.infer<typeof DataExportErrorCode>;

/** How long a finished export can be downloaded (days); the file is deleted afterwards. */
export const DATA_EXPORT_TTL_DAYS = 7;

/** `POST /v1/agency/data-exports`. For `ACCOUNT`, `format` is that of the tables inside the ZIP. */
export const CreateDataExportBody = z.strictObject({
  kind: DataExportKind,
  format: DataExportFormat.default('csv'),
});
export type CreateDataExportBody = z.infer<typeof CreateDataExportBody>;

/** A short-lived signed link to the file (minutes; a new one is issued on every `GET` while the export is live). */
export const DataExportDownloadDto = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type DataExportDownloadDto = z.infer<typeof DataExportDownloadDto>;

export const DataExportDto = z.strictObject({
  id: z.uuid(),
  kind: DataExportKind,
  format: DataExportFormat,
  status: DataExportStatus,
  /** Rows written per table (`contacts`, `leads`, `listings`, `media`). */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  fileBytes: z.number().int().nonnegative().nullable(),
  fileName: z.string(),
  errorCode: DataExportErrorCode.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** When the download stops working (finished + `DATA_EXPORT_TTL_DAYS`). */
  expiresAt: z.iso.datetime().nullable(),
  /** `GET /v1/agency/data-exports/:id?download=1` only, while the export can be downloaded; never in the list. */
  download: DataExportDownloadDto.nullable(),
});
export type DataExportDto = z.infer<typeof DataExportDto>;

export const DataExportPage = pageOf(DataExportDto);
export type DataExportPage = z.infer<typeof DataExportPage>;

export const DataExportParams = z.object({ id: z.uuid() });
export type DataExportParams = z.infer<typeof DataExportParams>;

/** `GET /v1/agency/data-exports/:id`: `download=1` mints a signed link (audited); without it, the status only. */
export const GetDataExportQuery = z.strictObject({ download: z.enum(['0', '1']).optional() });
export type GetDataExportQuery = z.infer<typeof GetDataExportQuery>;

/** `POST /v1/agency/data-exports`: with an `Idempotency-Key`, a retry within 24 h with the same body answers the first export. */
export const CreateDataExportHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
});
export type CreateDataExportHeaders = z.infer<typeof CreateDataExportHeaders>;
