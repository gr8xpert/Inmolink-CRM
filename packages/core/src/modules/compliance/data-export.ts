import {
  type CreateDataExportBody,
  DATA_EXPORT_TTL_DAYS,
  type DataExportDto,
  type DataExportFormat,
  type DataExportKind,
  type DataExportPage,
  type DataExportStatus,
  type PageQuery,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { storage } from '@inmolink/platform/storage';
import type { Ctx } from '../../context';
import { idempotencyOf, replayOf } from '../../idempotency';
import { decodeCursor, toPage } from '../../pagination';
import * as repo from './data-export-repo';
import { complianceEvents } from './events';
import { assertCan } from './policy';
import { audit } from './service';

/**
 * Data export, the request side (S10-08, PLAN §3 #59 "you can always leave"). An agency admin asks for its contacts,
 * leads or listings as CSV / XLSX, or the whole account as a ZIP; the request only records the export (`QUEUED`),
 * audits it and emits `compliance.dataExport.requested` in the same transaction — the file is written by the
 * `compliance.runDataExport` worker job (`data-export-run.ts`), never in the request. One export per agency at a time.
 * A finished export is downloaded through short signed links (`GET …/:id`, each audited) until it expires,
 * `DATA_EXPORT_TTL_DAYS` after it finished. Exports hold client PII and commissions: admins only, never in Client
 * Mode, never by staff impersonating an admin (policy); nothing of the data is logged or stored in the row.
 */

/** Lifetime of one signed download link (seconds); a new one comes with every `GET` while the export is live. */
export const DATA_EXPORT_LINK_SECONDS = 15 * 60;
export const DATA_EXPORT_TTL_MS = DATA_EXPORT_TTL_DAYS * 24 * 3_600_000;

/** The file's storage key (private bucket). */
export const dataExportKey = (agencyId: string, exportId: string) => `data-exports/${agencyId}/${exportId}`;

export const DATA_EXPORT_CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
} as const;

export const dataExportExtension = (kind: DataExportKind, format: DataExportFormat) =>
  kind === 'ACCOUNT' ? 'zip' : format;

/** The download's file name: `inmolink-contacts-2026-10-24.csv`. */
export function dataExportFileName(row: { kind: string; format: string; createdAt: Date }): string {
  const kind = row.kind as DataExportKind;
  return `inmolink-${kind.toLowerCase()}-${row.createdAt.toISOString().slice(0, 10)}.${dataExportExtension(
    kind,
    row.format as DataExportFormat,
  )}`;
}

function toDto(row: repo.ExportRow, download: DataExportDto['download'] = null): DataExportDto {
  return {
    id: row.id,
    kind: row.kind as DataExportKind,
    format: row.format as DataExportFormat,
    status: row.status as DataExportStatus,
    counts: row.counts ?? {},
    fileBytes: row.fileBytes,
    fileName: dataExportFileName(row),
    errorCode: row.errorCode as DataExportDto['errorCode'],
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    download,
  };
}

/**
 * `POST /v1/agency/data-exports` (admins): records and queues an export. With an `Idempotency-Key`, a retry by the same
 * admin within 24 h with the same body answers the first export (`replayed`, no second-factor check: nothing new is
 * created); another body is `IDEMPOTENCY_KEY_REUSED`.
 *
 * Copying the agency's data out needs a fresh second factor (S11-F14), so `verifyStepUp` is not optional. The order
 * matters: policy (a non-admin never spends a code) → replay → a running export (409, the code is kept) → `verifyStepUp`
 * (throws `MFA_CODE_INVALID`; it runs in its own transaction, as identity's `app_auth`) → create. Apps call
 * `requestDataExport` (`../../data-export-request`), which binds identity's check; compliance cannot import identity
 * (identity imports compliance for its audit trail).
 */
export async function createDataExport(
  ctx: Ctx,
  input: Pick<CreateDataExportBody, 'kind' | 'format'>,
  opts: { idempotencyKey?: string; verifyStepUp: () => Promise<void> },
): Promise<{ export: DataExportDto; replayed: boolean }> {
  assertCan(ctx, 'compliance.dataExport.create');
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  const agencyId = ctx.tenant.agencyId;
  const idempotency = idempotencyOf('compliance.dataExport', ctx.actor.userId, opts.idempotencyKey, {
    kind: input.kind,
    format: input.format,
  });
  const replay = async (): Promise<{ export: DataExportDto; replayed: boolean } | null> => {
    const prior = await replayOf(
      ctx.tx,
      idempotency,
      (since, key) => repo.exportByIdempotency(ctx.tx, agencyId, key.hash, since),
      { now: clock.now() },
    );
    if (!prior) return null;
    const row = await repo.getExport(ctx.tx, agencyId, prior.id);
    if (!row) throw new AppError('DATA_EXPORT_NOT_FOUND');
    return { export: toDto(row), replayed: true };
  };
  const replayed = await replay();
  if (replayed) return replayed;
  if (await repo.hasActiveExport(ctx.tx, agencyId)) throw new AppError('DATA_EXPORT_IN_PROGRESS');
  await opts.verifyStepUp();
  const row = await repo.insertExport(ctx.tx, {
    id: newId(),
    agencyId,
    createdBy: ctx.actor.userId,
    kind: input.kind,
    format: input.format,
    idempotencyHash: idempotency?.hash ?? null,
    requestHash: idempotency?.requestHash ?? null,
  });
  if (!row) {
    // a concurrent retry with the same key won the insert: answer its export
    const raced = await replay();
    if (raced) return raced;
    // the key's unique index is permanent: a key older than the replay window conflicts on insert
    if (idempotency && (await repo.exportByIdempotency(ctx.tx, agencyId, idempotency.hash, new Date(0)))) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED');
    }
    throw new AppError('DATA_EXPORT_IN_PROGRESS');
  }
  await audit(
    ctx,
    'compliance.dataExport.requested',
    { type: 'dataExport', id: row.id },
    {
      kind: row.kind,
      format: row.format,
    },
  );
  await emit(ctx.tx, complianceEvents.dataExportRequested({ agencyId: row.agencyId, exportId: row.id }));
  return { export: toDto(row), replayed: false };
}

/** `GET /v1/agency/data-exports` (admins): newest first, keyset pages; never a download link. */
export async function listDataExports(ctx: Ctx, q: PageQuery): Promise<DataExportPage> {
  assertCan(ctx, 'compliance.dataExport.read');
  const cursor = decodeCursor(q.cursor);
  const rows = await repo.listExports(ctx.tx, ctx.tenant.agencyId, { limit: q.limit, cursor });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.createdAt, id: r.id }),
    (r) => toDto(r),
  );
}

/**
 * `GET /v1/agency/data-exports/:id` (admins): the export's status. With `download` (`?download=1`), and while the
 * export can be downloaded, also a signed link (`DATA_EXPORT_LINK_SECONDS`, never past the expiry) — each link issued
 * is audited (`compliance.dataExport.downloaded`) in this transaction; a caller who may not download (staff
 * impersonating an admin) is refused. Signing is local: no network call in the transaction.
 */
export async function getDataExport(ctx: Ctx, id: string, opts: { download?: boolean } = {}): Promise<DataExportDto> {
  assertCan(ctx, 'compliance.dataExport.read');
  if (opts.download) assertCan(ctx, 'compliance.dataExport.download');
  const row = await repo.getExport(ctx.tx, ctx.tenant.agencyId, id);
  if (!row) throw new AppError('DATA_EXPORT_NOT_FOUND');
  const now = clock.now().getTime();
  const live = row.status === 'SUCCEEDED' && row.expiresAt !== null && row.expiresAt.getTime() > now;
  if (!opts.download || !live) return toDto(row);
  const seconds = Math.max(
    1,
    Math.min(DATA_EXPORT_LINK_SECONDS, Math.floor(((row.expiresAt as Date).getTime() - now) / 1000)),
  );
  const ext = dataExportExtension(row.kind as DataExportKind, row.format as DataExportFormat);
  const url = await storage().signedGetUrl('private', dataExportKey(row.agencyId, row.id), {
    expiresInSeconds: seconds,
    downloadName: dataExportFileName(row),
    responseContentType: DATA_EXPORT_CONTENT_TYPES[ext],
  });
  await audit(ctx, 'compliance.dataExport.downloaded', { type: 'dataExport', id: row.id }, { kind: row.kind });
  return toDto(row, { url, expiresAt: new Date(now + seconds * 1000).toISOString() });
}
