import {
  AppError,
  type MapperSampleDto,
  SHEET_MAPPED_CONNECTOR,
  SHEET_UPLOAD_MAX_BYTES,
  SHEET_URL_PREFIX,
  type StartSheetImportBody,
  type StartSheetImportDto,
  XmlMapping,
} from '@inmolink/contracts';
import { newId } from '@inmolink/platform/ids';
import { storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../../context';
import * as compliance from '../../compliance';
import { assertCan } from '../policy';
import * as repo from '../repo';
import { requestFeedRun } from '../service';
import { sheetKey } from './connector';
import { analyzeSheet } from './sample';

/**
 * CSV / Excel imports (S6-05): the upload (checked, previewed, stored) and "start the import" (a connection for the
 * file, its profile, a queued run). The run itself is the worker's `imports.runFeed` with the `sheet-mapped` connector.
 */

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/**
 * `POST /v1/imports/sheets` (raw body, admins): the file is identified by its first bytes (never its name or declared
 * type), the header and the first rows are read for the mapper, and the file is stored for the run. Nothing else is
 * parsed here: rows, columns and cell sizes are checked when the run reads the file.
 */
export async function uploadSheet(run: CtxRunner, bytes: Uint8Array): Promise<MapperSampleDto> {
  // Its own short transaction: the parse and the storage call run outside any.
  const agencyId = await run(async (ctx) => {
    assertCan(ctx, 'imports.manage');
    return ctx.tenant.agencyId;
  });
  if (bytes.length > SHEET_UPLOAD_MAX_BYTES) throw new AppError('FEED_SAMPLE_INVALID', { reason: 'TOO_LARGE' });
  const { kind, sample } = await analyzeSheet(bytes);
  const fileId = newId();
  await storage().put('private', sheetKey(agencyId, fileId), bytes, { contentType: CONTENT_TYPES[kind] });
  return { ...sample, sheet: { fileId, kind } };
}

/**
 * `POST /v1/imports/sheets/import` (admins): saves the mapping as a profile, gives the file a connection of its own
 * (never scheduled: a file is imported when someone uploads it) and queues the run. With `connectionId` the
 * connection and its profile are reused, so listings an earlier file created are updated, not duplicated.
 */
export async function startSheetImport(ctx: Ctx, input: StartSheetImportBody): Promise<StartSheetImportDto> {
  assertCan(ctx, 'imports.manage');
  const agencyId = ctx.tenant.agencyId;
  const parsed = XmlMapping.safeParse(input.mapping);
  if (!parsed.success) throw new AppError('FEED_MAPPING_INVALID');
  const mapping = parsed.data;
  const url = `${SHEET_URL_PREFIX}${input.fileId}`;
  let connectionId: string;
  if (input.connectionId) {
    const current = await repo.getConnectionForUpdate(ctx.tx, input.connectionId);
    if (!current) throw new AppError('FEED_CONNECTION_NOT_FOUND');
    if (current.connector !== SHEET_MAPPED_CONNECTOR) {
      throw new AppError('FEED_MAPPING_INVALID', { reason: 'WRONG_CONNECTOR' });
    }
    let profileId = current.mappingProfileId;
    const profile = profileId ? await repo.getProfileForUpdate(ctx.tx, profileId) : null;
    if (profile) await repo.updateProfileWithVersion(ctx.tx, profile.id, profile.version, { mapping });
    else {
      profileId = newId();
      await repo.insertProfile(ctx.tx, {
        id: profileId,
        agencyId,
        name: input.name,
        connector: SHEET_MAPPED_CONNECTOR,
        mapping,
      });
    }
    const updated = await repo.updateConnectionWithVersion(ctx.tx, current.id, current.version, {
      url,
      mappingProfileId: profileId,
    });
    if (!updated) throw new AppError('VERSION_CONFLICT');
    connectionId = current.id;
  } else {
    const profileId = newId();
    await repo.insertProfile(ctx.tx, {
      id: profileId,
      agencyId,
      name: input.name,
      connector: SHEET_MAPPED_CONNECTOR,
      mapping,
    });
    connectionId = newId();
    await repo.insertConnection(ctx.tx, {
      id: connectionId,
      agencyId,
      name: input.name,
      connector: SHEET_MAPPED_CONNECTOR,
      url,
      credentialsEnc: null,
      settings: {},
      mappingProfileId: profileId,
      enabled: true,
      scheduleMinutes: null,
      nextRunAt: null,
    });
  }
  await compliance.audit(
    ctx,
    'imports.sheet.started',
    { type: 'feedConnection', id: connectionId },
    { reused: input.connectionId !== undefined },
  );
  // The run: one queued or running run per connection (`FEED_RUN_ACTIVE` rolls the whole start back).
  return { connectionId, run: await requestFeedRun(ctx, connectionId) };
}
