/**
 * imports use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network.
 *
 * S6-01: feed connections (credentials encrypted with `platform/crypto`, never returned), "run now" (one queued or
 * running run per connection — the database refuses a second), and the run history with per-item errors. The
 * runs themselves execute in the worker (`runner.ts`).
 */
import {
  AppError,
  type CreateFeedConnectionBody,
  type FeedConnectionDto,
  type FeedConnectionPage,
  type FeedItemErrorPage,
  FeedPauseDetails,
  type FeedPauseDto,
  type FeedPauseReason,
  type FeedRunDto,
  type FeedRunPage,
  type FeedSettings,
  type ListFeedConnectionsQuery,
  type ListFeedItemErrorsQuery,
  type ListFeedRunsQuery,
  type ResumeFeedConnectionBody,
  type UpdateFeedConnectionBody,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { checkUrl, isSafeFetchError, isTestOrigin } from '@inmolink/platform/safe-fetch';
import type { Ctx } from '../../context';
import { decodeCursor, encodeCursor } from '../../pagination';
import * as compliance from '../compliance';
import { feedCredentialsCipher } from './config';
import { getConnector } from './connectors';
import { importsEvents } from './events';
import { assertCan, can } from './policy';
import * as repo from './repo';
import { connectionSheet } from './sheet/lifecycle';

/** Scheduled connections run daily unless the agency picks another interval. */
const DEFAULT_SCHEDULE_MINUTES = 1_440;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Feed providers often put an API key in the query string: only admins (who may change the connection) see it;
 * other members get the URL with query values masked.
 */
function visibleUrl(ctx: Ctx, url: string): string {
  if (can(ctx, 'imports.manage')) return url;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '***');
    return u.href;
  } catch {
    return '';
  }
}

/** The connection's pause (S6-08), or null. Details are counts the worker wrote; anything else is dropped. */
export function toPauseDto(row: {
  pausedAt: Date | null;
  pauseReason: string | null;
  pauseDetails: unknown;
  pausedRunId: string | null;
}): FeedPauseDto | null {
  if (!row.pausedAt || !row.pauseReason) return null;
  const details = FeedPauseDetails.safeParse(row.pauseDetails ?? {});
  return {
    at: row.pausedAt.toISOString(),
    reason: row.pauseReason as FeedPauseReason,
    details: details.success ? details.data : {},
    runId: row.pausedRunId,
  };
}

function toConnectionDto(ctx: Ctx, row: repo.ConnectionView): FeedConnectionDto {
  return {
    id: row.id,
    name: row.name,
    connector: row.connector,
    url: visibleUrl(ctx, row.url),
    hasCredentials: row.hasCredentials,
    settings: row.settings as FeedSettings,
    mappingProfileId: row.mappingProfileId,
    enabled: row.enabled,
    scheduleMinutes: row.scheduleMinutes,
    nextRunAt: iso(row.nextRunAt),
    lastRunAt: iso(row.lastRunAt),
    lastRunState: row.lastRunState,
    pause: toPauseDto(row),
    acceptAnomalyOnce: row.acceptAnomalyOnce,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRunDto(row: repo.RunView): FeedRunDto {
  return {
    id: row.id,
    connectionId: row.connectionId,
    trigger: row.trigger,
    state: row.state,
    attempt: row.attempt,
    counts: {
      total: row.itemsTotal,
      valid: row.itemsValid,
      failed: row.itemsFailed,
      created: row.itemsCreated,
      updated: row.itemsUpdated,
      unchanged: row.itemsUnchanged,
      held: row.itemsHeld,
      withdrawn: row.itemsWithdrawn,
    },
    errorsLogged: row.errorsLogged,
    bytesRead: row.bytesRead,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Early answer when a URL is saved (no DNS here; the fetch checks again, with DNS, on every hop). */
function checkedUrl(url: string, fixedHost?: string): string {
  try {
    const checked = checkUrl(url);
    // S7-F14: a connector with one API host (Resales Online) takes no other, however the URL was typed.
    if (
      fixedHost &&
      (checked.hostname.toLowerCase() !== fixedHost ||
        checked.protocol !== 'https:' ||
        (checked.port !== '' && checked.port !== '443'))
    )
      throw new AppError('FEED_URL_NOT_ALLOWED', { reason: 'HOST_NOT_ALLOWED' });
    return checked.href;
  } catch (err) {
    if (isSafeFetchError(err)) throw new AppError('FEED_URL_NOT_ALLOWED', { reason: err.details.reason ?? err.code });
    throw err;
  }
}

/** A profile belongs to one connector; connectors that need one (generic XML) are refused without (S6-04). */
async function assertMappingProfile(ctx: Ctx, connector: string, id: string | null | undefined): Promise<void> {
  if (id) {
    const profileConnector = await repo.profileConnector(ctx.tx, id);
    if (profileConnector === null) throw new AppError('FEED_MAPPING_PROFILE_NOT_FOUND');
    if (profileConnector !== connector) throw new AppError('FEED_MAPPING_INVALID', { reason: 'WRONG_CONNECTOR' });
  } else if (getConnector(connector)?.requiresMapping && id !== undefined) {
    throw new AppError('FEED_MAPPING_REQUIRED');
  }
}

const nextRun = (enabled: boolean, scheduleMinutes: number | null) =>
  enabled && scheduleMinutes !== null ? clock.now() : null;

/**
 * Credentials (header, basic or query key) are only ever sent over https: a plain-http feed may not keep any
 * (local fixture servers allowed by a test excepted).
 */
export function assertSecretsOverTls(url: string, hasCredentials: boolean): void {
  if (hasCredentials && new URL(url).protocol !== 'https:' && !isTestOrigin(url)) {
    throw new AppError('FEED_URL_NOT_ALLOWED', { reason: 'CREDENTIALS_NEED_HTTPS' });
  }
}

/** S6-F4: the connector's own check of its settings (e.g. the Resales filter alias). */
function assertSettings(connector: string, settings: Record<string, unknown>): void {
  const field = getConnector(connector)?.settingsProblem?.(settings);
  if (field) throw new AppError('FEED_SETTINGS_INVALID', { field });
}

/** `POST /v1/imports/connections` (admins). The first scheduled run starts on the scheduler's next tick. */
export async function createFeedConnection(ctx: Ctx, input: CreateFeedConnectionBody): Promise<FeedConnectionDto> {
  assertCan(ctx, 'imports.manage');
  if (!getConnector(input.connector)) throw new AppError('FEED_CONNECTOR_UNKNOWN');
  assertSettings(input.connector, input.settings ?? {});
  const url = checkedUrl(input.url, getConnector(input.connector)?.fixedHost);
  assertSecretsOverTls(url, Boolean(input.credentials));
  if (getConnector(input.connector)?.requiresMapping && !input.mappingProfileId) {
    throw new AppError('FEED_MAPPING_REQUIRED');
  }
  await assertMappingProfile(ctx, input.connector, input.mappingProfileId);
  const id = newId();
  const agencyId = ctx.tenant.agencyId;
  const enabled = input.enabled ?? true;
  const scheduleMinutes = input.scheduleMinutes === undefined ? DEFAULT_SCHEDULE_MINUTES : input.scheduleMinutes;
  const row = await repo.insertConnection(ctx.tx, {
    id,
    agencyId,
    name: input.name,
    connector: input.connector,
    url,
    credentialsEnc: input.credentials ? feedCredentialsCipher.encrypt(agencyId, id, input.credentials) : null,
    settings: input.settings ?? {},
    mappingProfileId: input.mappingProfileId ?? null,
    enabled,
    scheduleMinutes,
    nextRunAt: nextRun(enabled, scheduleMinutes),
  });
  await compliance.audit(
    ctx,
    'imports.connection.created',
    { type: 'feedConnection', id },
    {
      connector: input.connector,
      credentials: input.credentials ? input.credentials.type : null,
    },
  );
  return toConnectionDto(ctx, row);
}

export async function getFeedConnection(ctx: Ctx, id: string): Promise<FeedConnectionDto> {
  assertCan(ctx, 'imports.read');
  const row = await repo.getConnection(ctx.tx, id);
  if (!row) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  return toConnectionDto(ctx, row);
}

export async function listFeedConnections(ctx: Ctx, q: ListFeedConnectionsQuery): Promise<FeedConnectionPage> {
  assertCan(ctx, 'imports.read');
  const page = await repo.listConnections(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  const last = page.items.at(-1);
  return {
    items: page.items.map((row) => toConnectionDto(ctx, row)),
    nextCursor: page.hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

/**
 * `PATCH /v1/imports/connections/:id` (admins, optimistic concurrency). `credentials: null` removes them; a
 * schedule change or re-enabling re-plans the next run.
 */
export async function updateFeedConnection(
  ctx: Ctx,
  id: string,
  input: UpdateFeedConnectionBody,
): Promise<FeedConnectionDto> {
  assertCan(ctx, 'imports.manage');
  const current = await repo.getConnectionForUpdate(ctx.tx, id);
  if (!current) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  assertCan(ctx, 'imports.manage', current);
  if (current.version !== input.version) throw new AppError('VERSION_CONFLICT');
  if (input.settings !== undefined) assertSettings(current.connector, input.settings);
  await assertMappingProfile(ctx, current.connector, input.mappingProfileId);
  const enabled = input.enabled ?? current.enabled;
  const scheduleMinutes = input.scheduleMinutes === undefined ? current.scheduleMinutes : input.scheduleMinutes;
  const replan = enabled !== current.enabled || scheduleMinutes !== current.scheduleMinutes;
  const url = input.url !== undefined ? checkedUrl(input.url, getConnector(current.connector)?.fixedHost) : undefined;
  // Credentials belong to the feed's origin: pointing the connection elsewhere drops them unless new ones come
  // with the change (an admin cannot send credentials another admin entered to a host of their choosing).
  const originMoved = url !== undefined && new URL(url).origin !== new URL(current.url).origin;
  const credentials = input.credentials !== undefined ? input.credentials : originMoved ? null : undefined;
  assertSecretsOverTls(url ?? current.url, credentials !== undefined ? Boolean(credentials) : current.hasCredentials);
  const patch: Partial<repo.ConnectionInsert> = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    ...(input.mappingProfileId !== undefined ? { mappingProfileId: input.mappingProfileId } : {}),
    ...(credentials !== undefined
      ? { credentialsEnc: credentials ? feedCredentialsCipher.encrypt(current.agencyId, id, credentials) : null }
      : {}),
    enabled,
    scheduleMinutes,
    ...(replan ? { nextRunAt: nextRun(enabled, scheduleMinutes) } : {}),
  };
  const updated = await repo.updateConnectionWithVersion(ctx.tx, id, input.version, patch);
  if (!updated) throw new AppError('VERSION_CONFLICT');
  const changed = Object.keys(input).filter((k) => k !== 'version');
  if (originMoved && input.credentials === undefined && current.hasCredentials) changed.push('credentialsDropped');
  await compliance.audit(ctx, 'imports.connection.changed', { type: 'feedConnection', id }, { changed });
  return toConnectionDto(ctx, updated);
}

/**
 * `DELETE /v1/imports/connections/:id` (admins): the run history goes with it; a running run stops at its next batch.
 * A sheet connection's uploaded file is released (S7-F1): deleted from storage after the commit.
 */
export async function deleteFeedConnection(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'imports.manage');
  const current = await repo.getConnectionForUpdate(ctx.tx, id);
  if (!current) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  assertCan(ctx, 'imports.manage', current);
  await repo.deleteConnection(ctx.tx, id);
  const fileId = connectionSheet(current.connector, current.url);
  if (fileId) {
    await emit(ctx.tx, importsEvents.sheetReleased({ agencyId: current.agencyId, fileId, connectionId: id }));
  }
  await compliance.audit(
    ctx,
    'imports.connection.deleted',
    { type: 'feedConnection', id },
    { connector: current.connector },
  );
}

/**
 * `POST /v1/imports/connections/:id/runs`: queues a run now. Refused while one is queued or running
 * (`FEED_RUN_ACTIVE`, the per-connection mutex) or when the connection is off. The worker picks it up through
 * `imports.run.requested`.
 */
export async function requestFeedRun(ctx: Ctx, connectionId: string): Promise<FeedRunDto> {
  assertCan(ctx, 'imports.run');
  const connection = await repo.getConnection(ctx.tx, connectionId);
  if (!connection) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  assertCan(ctx, 'imports.run', connection);
  if (!connection.enabled) throw new AppError('FEED_CONNECTION_DISABLED');
  if (connection.pausedAt) throw new AppError('FEED_CONNECTION_PAUSED');
  const run = await repo.insertRun(ctx.tx, {
    id: newId(),
    agencyId: connection.agencyId,
    connectionId,
    trigger: 'MANUAL',
    ...(ctx.actor.kind === 'user' ? { requestedByUserId: ctx.actor.userId } : {}),
  });
  if (!run) throw new AppError('FEED_RUN_ACTIVE');
  // Staff may start runs while impersonating: the audit row names them.
  await compliance.audit(ctx, 'imports.run.requested', { type: 'feedConnection', id: connectionId }, { runId: run.id });
  await emit(ctx.tx, importsEvents.runRequested({ runId: run.id, connectionId, agencyId: connection.agencyId }));
  return toRunDto(run);
}

/**
 * `POST /v1/imports/connections/:id/resume` (admins, S6-08): lifts the anomaly guard's pause. `acceptChange`: the
 * spike or drop is real, the next run skips the guard once (and may then withdraw the missing listings after the
 * usual missed runs); otherwise the next run is checked again and pauses again if nothing changed. A scheduled
 * connection runs on the scheduler's next tick. Resuming a connection that is not paused changes nothing.
 */
export async function resumeFeedConnection(
  ctx: Ctx,
  id: string,
  input: ResumeFeedConnectionBody,
): Promise<FeedConnectionDto> {
  assertCan(ctx, 'imports.manage');
  const current = await repo.getConnectionForUpdate(ctx.tx, id);
  if (!current) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  assertCan(ctx, 'imports.manage', current);
  if (!current.pausedAt) return toConnectionDto(ctx, current);
  const resumed = await repo.resumeConnection(ctx.tx, id, input.acceptChange);
  if (!resumed) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  await compliance.audit(
    ctx,
    'imports.connection.resumed',
    { type: 'feedConnection', id },
    { reason: current.pauseReason, acceptChange: input.acceptChange },
  );
  return toConnectionDto(ctx, resumed);
}

export async function listFeedRuns(ctx: Ctx, connectionId: string, q: ListFeedRunsQuery): Promise<FeedRunPage> {
  assertCan(ctx, 'imports.read');
  const connection = await repo.getConnection(ctx.tx, connectionId);
  if (!connection) throw new AppError('FEED_CONNECTION_NOT_FOUND');
  assertCan(ctx, 'imports.read', connection);
  const page = await repo.listRuns(ctx.tx, connectionId, { limit: q.limit, cursor: decodeCursor(q.cursor) });
  const last = page.items.at(-1);
  return {
    items: page.items.map(toRunDto),
    nextCursor: page.hasMore && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null,
  };
}

export async function getFeedRun(ctx: Ctx, runId: string): Promise<FeedRunDto> {
  assertCan(ctx, 'imports.read');
  const run = await repo.getRun(ctx.tx, runId);
  if (!run) throw new AppError('FEED_RUN_NOT_FOUND');
  assertCan(ctx, 'imports.read', run);
  return toRunDto(run);
}

/** Error-list cursor: the last row's (position, id), opaque. */
function encodeErrorCursor(position: number, id: string): string {
  return Buffer.from(JSON.stringify([position, id])).toString('base64url');
}

function decodeErrorCursor(cursor: string | undefined): { position: number; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const [position, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (Number.isInteger(position) && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) {
      return { position: position as number, id };
    }
  } catch {
    // falls through
  }
  throw new AppError('VALIDATION_FAILED', { field: 'cursor' });
}

export async function listFeedItemErrors(
  ctx: Ctx,
  runId: string,
  q: ListFeedItemErrorsQuery,
): Promise<FeedItemErrorPage> {
  assertCan(ctx, 'imports.read');
  const run = await repo.getRun(ctx.tx, runId);
  if (!run) throw new AppError('FEED_RUN_NOT_FOUND');
  assertCan(ctx, 'imports.read', run);
  const page = await repo.listItemErrors(ctx.tx, runId, { limit: q.limit, after: decodeErrorCursor(q.cursor) });
  const last = page.items.at(-1);
  return { items: page.items, nextCursor: page.hasMore && last ? encodeErrorCursor(last.position, last.id) : null };
}
