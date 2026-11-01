import { z } from 'zod';
import { pageOf } from './common';
import { TwoFactorCode } from './identity';

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

/**
 * What an export holds: one table, the whole account (a ZIP of the tables plus the media manifest), or `SUBJECT`
 * (S16-04): one data subject's ZIP — everything the agency holds about one contact (GDPR Art. 15 / 20).
 */
export const DataExportKind = z.enum(['CONTACTS', 'LEADS', 'LISTINGS', 'ACCOUNT', 'SUBJECT']);
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

/** `POST /v1/agency/data-exports`. For `ACCOUNT`, `format` is that of the tables inside the ZIP. `twoFactorCode` is a fresh
 * code of the admin's authenticator (or a recovery code): an unattended session alone cannot copy the agency's data out (S11-F14). */
export const CreateDataExportBody = z.strictObject({
  kind: DataExportKind,
  format: DataExportFormat.default('csv'),
  /**
   * `SUBJECT` only (S16-04): the contact whose data is exported. Required for `SUBJECT` and refused for the other kinds
   * (the service answers `VALIDATION_FAILED`; no `.refine` here, so the schema stays `.omit`-able).
   */
  contactId: z.uuid().optional(),
  /**
   * `SUBJECT` only (S17-F2): the confirmation step — the contact id again, sent once the admin was shown whose data it
   * is. A `SUBJECT` export without it, or with another id, is `VALIDATION_FAILED` (field `confirmContactId`) and never
   * built; refused for the other kinds. A guard against a mistyped or swapped id — the confirmation itself is the
   * dashboard step that names the person.
   */
  confirmContactId: z.uuid().optional(),
  twoFactorCode: TwoFactorCode,
});
export type CreateDataExportBody = z.infer<typeof CreateDataExportBody>;

/** A short-lived signed link to the file (minutes; a new one is issued on every `GET` while the export is live). */
export const DataExportDownloadDto = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type DataExportDownloadDto = z.infer<typeof DataExportDownloadDto>;

export const DataExportDto = z.strictObject({
  id: z.uuid(),
  kind: DataExportKind,
  format: DataExportFormat,
  /** `SUBJECT` exports: the contact exported; null for the others. */
  subjectContactId: z.uuid().nullable(),
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

// ---- GDPR: consent records, retention, agency erasure (S16-04, PLAN §13) --------------------------------------------

/** What a consent covers: marketing (newsletters, alerts) or processing (keeping and using the data). */
export const ConsentPurpose = z.enum(['MARKETING', 'PROCESSING']);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;
/** Where the choice was made. */
export const ConsentSource = z.enum(['DASHBOARD', 'WEBSITE', 'PORTAL', 'IMPORT', 'MERGE']);
export type ConsentSource = z.infer<typeof ConsentSource>;

/** One consent given or withdrawn (`GET /v1/crm/contacts/:id/consents`): ids and times only. */
export const ConsentRecordDto = z.strictObject({
  id: z.uuid(),
  purpose: ConsentPurpose,
  granted: z.boolean(),
  source: ConsentSource,
  policyVersion: z.string().nullable(),
  /** The member who recorded it; null for a website form or an import. */
  actorUserId: z.uuid().nullable(),
  /** A staff member recorded it while impersonating `actorUserId`. */
  impersonated: z.boolean(),
  recordedAt: z.iso.datetime(),
});
export type ConsentRecordDto = z.infer<typeof ConsentRecordDto>;

/** A contact's consent history, newest first (at most `CONSENT_HISTORY_LIMIT`). */
export const CONSENT_HISTORY_LIMIT = 100;
export const ConsentRecordList = z.strictObject({ items: z.array(ConsentRecordDto) });
export type ConsentRecordList = z.infer<typeof ConsentRecordList>;

/** Shortest and longest retention period an agency may choose (months). */
export const RETENTION_MIN_MONTHS = 6;
export const RETENTION_MAX_MONTHS = 240;

/** A shortened retention period (or one newly turned on) applies only this many days after the change. */
export const RETENTION_GRACE_DAYS = 14;

const RetentionMonths = z.number().int().min(RETENTION_MIN_MONTHS).max(RETENTION_MAX_MONTHS).nullable();

/**
 * `GET/PUT /v1/agency/retention` (admins): contacts with no change, lead, activity or task for `inactiveContactMonths`
 * are anonymized by the daily retention job (crm's erasure); null = never. A shorter period than the one in force applies
 * from `effectiveAt` (`RETENTION_GRACE_DAYS` later); until then `previousMonths` applies.
 */
export const RetentionSettingsDto = z.strictObject({
  inactiveContactMonths: RetentionMonths,
  /** When `inactiveContactMonths` applies (now, or the end of the grace window). */
  effectiveAt: z.iso.datetime(),
  /** The period in force until `effectiveAt` (null = never); null too once `effectiveAt` is past. */
  previousMonths: RetentionMonths,
});
export type RetentionSettingsDto = z.infer<typeof RetentionSettingsDto>;
/** `twoFactorCode`: a fresh code of the admin's authenticator — the period decides which clients are erased for good. */
export const UpdateRetentionSettingsBody = z.strictObject({
  inactiveContactMonths: RetentionMonths,
  twoFactorCode: TwoFactorCode,
});
export type UpdateRetentionSettingsBody = z.infer<typeof UpdateRetentionSettingsBody>;
