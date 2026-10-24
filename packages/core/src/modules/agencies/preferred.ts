import {
  type AddPreferredAgencyBody,
  DIRECTORY_SEARCH_LIMIT,
  type DirectorySearchQuery,
  type DirectorySearchResult,
  MAX_PREFERRED_AGENCIES,
  type PageQuery,
  type PreferredAgencyDto,
  type PreferredAgencyPage,
  type PreferredAgencyParams,
  type UpdatePreferredAgencyBody,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { agenciesEvents } from './events';
import { assertCan, assertVerified } from './policy';
import * as repo from './preferred-repo';
import { lockStatus } from './repo';

/**
 * Preferred agencies (S1-07, PLAN §3 #57 §7 M1). An agency's admins keep a list of trusted partners;
 * listings shared to PREFERRED reach only them, through the `app_preferring_agencies()` RLS helper in the
 * listing policy (S3-02). Nothing about the relationship is cached: a removal takes effect on the
 * partner's next query. Partners are found in the agency directory (verified agencies, name and kind).
 */

function actorOf(ctx: Ctx): { actorUserId: string; impersonatedBy: string | null } {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return { actorUserId: ctx.actor.userId, impersonatedBy: ctx.actor.impersonatedBy ?? null };
}

// `Omit`: `add` builds the DTO of a row it just inserted, which has no list cursor stamp (`atUs`)
function toDto(row: Omit<repo.PreferredRow, 'atUs'>): PreferredAgencyDto {
  const updatedAt = row.noteUpdatedAt ?? row.createdAt;
  return {
    agencyId: row.preferredAgencyId,
    name: row.directoryName ?? row.nameWhenAdded ?? '',
    kind: row.directoryKind,
    listed: row.directoryName !== null,
    note: row.note,
    addedAt: row.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** `GET /v1/agency/preferred-agencies`: any member, not in Client Mode; oldest first, keyset pages. */
export async function listPreferredAgencies(ctx: Ctx, q: PageQuery): Promise<PreferredAgencyPage> {
  assertCan(ctx, 'agencies.preferred.read');
  const rows = await repo.listPreferred(ctx.tx, ctx.tenant.agencyId, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.preferredAgencyId, atUs: r.atUs }), toDto);
}

/**
 * `POST /v1/agency/preferred-agencies`: admins of a verified agency (not impersonated, not in Client
 * Mode) add a listed (VERIFIED) agency of the directory, never their own. At most
 * `MAX_PREFERRED_AGENCIES`: the agency row is locked (`FOR NO KEY UPDATE`) before the count, so two
 * concurrent adds cannot pass the cap, and the status is read fresh under that lock. Emits
 * `agencies.preferred.added`.
 */
export async function addPreferredAgency(ctx: Ctx, input: AddPreferredAgencyBody): Promise<PreferredAgencyDto> {
  assertCan(ctx, 'agencies.preferred.add');
  const actor = actorOf(ctx);
  assertVerified(ctx, 'preferredAgency.add');
  const agencyId = ctx.tenant.agencyId;
  if (input.agencyId === agencyId) throw new AppError('PREFERRED_AGENCY_INVALID', { reason: 'self' });
  if ((await lockStatus(ctx.tx, agencyId, 'update')) !== 'VERIFIED') {
    throw new AppError('VERIFICATION_REQUIRED', { action: 'preferredAgency.add' });
  }
  const partner = await repo.getListedAgency(ctx.tx, input.agencyId);
  if (!partner) throw new AppError('PREFERRED_AGENCY_INVALID', { reason: 'not_verified' });
  if ((await repo.countPreferred(ctx.tx, agencyId)) >= MAX_PREFERRED_AGENCIES) {
    throw new AppError('PREFERRED_AGENCY_LIMIT_REACHED', { limit: MAX_PREFERRED_AGENCIES });
  }
  const inserted = await repo.insertPreferred(ctx.tx, agencyId, input.agencyId);
  if (!inserted) throw new AppError('PREFERRED_AGENCY_EXISTS');
  const now = clock.now();
  const note = input.note ?? null;
  await repo.insertNote(ctx.tx, {
    agencyId,
    preferredAgencyId: input.agencyId,
    nameWhenAdded: partner.name,
    note,
    createdBy: actor.actorUserId,
    now,
  });
  await emit(ctx.tx, agenciesEvents.preferredAdded({ agencyId, preferredAgencyId: input.agencyId, ...actor }));
  return toDto({
    preferredAgencyId: input.agencyId,
    createdAt: inserted.createdAt,
    nameWhenAdded: partner.name,
    note,
    noteUpdatedAt: now,
    directoryName: partner.name,
    directoryKind: partner.kind,
  });
}

/**
 * `PATCH /v1/agency/preferred-agencies/:agencyId`: admins (also impersonated) replace the internal note.
 * Emits `agencies.preferred.noteUpdated` (who, never the text).
 */
export async function updatePreferredAgency(
  ctx: Ctx,
  params: PreferredAgencyParams,
  input: UpdatePreferredAgencyBody,
): Promise<PreferredAgencyDto> {
  assertCan(ctx, 'agencies.preferred.manage');
  const actor = actorOf(ctx);
  const agencyId = ctx.tenant.agencyId;
  if (!(await repo.updateNote(ctx.tx, agencyId, params.agencyId, input.note, clock.now()))) {
    throw new AppError('NOT_FOUND');
  }
  await emit(ctx.tx, agenciesEvents.preferredNoteUpdated({ agencyId, preferredAgencyId: params.agencyId, ...actor }));
  const row = await repo.getPreferred(ctx.tx, agencyId, params.agencyId);
  if (!row) throw new AppError('NOT_FOUND');
  return toDto(row);
}

/**
 * `DELETE /v1/agency/preferred-agencies/:agencyId`: admins (also impersonated: removing only narrows
 * access; the event records both). The partner loses the PREFERRED listings on its next query. Emits
 * `agencies.preferred.removed`.
 */
export async function removePreferredAgency(ctx: Ctx, params: PreferredAgencyParams): Promise<void> {
  assertCan(ctx, 'agencies.preferred.manage');
  const actor = actorOf(ctx);
  const agencyId = ctx.tenant.agencyId;
  if (!(await repo.deletePreferred(ctx.tx, agencyId, params.agencyId))) throw new AppError('NOT_FOUND');
  await emit(ctx.tx, agenciesEvents.preferredRemoved({ agencyId, preferredAgencyId: params.agencyId, ...actor }));
}

/**
 * `GET /v1/agency-directory?q=`: members of a verified agency (not in Client Mode) find verified agencies
 * by a part of their name — name and kind only, at most `DIRECTORY_SEARCH_LIMIT`, never their own.
 * RLS shows the directory to verified agencies only, whatever the request snapshot says.
 */
export async function searchAgencyDirectory(ctx: Ctx, q: DirectorySearchQuery): Promise<DirectorySearchResult> {
  assertCan(ctx, 'agencies.directory.search');
  assertVerified(ctx, 'directory.search');
  const rows = await repo.searchDirectory(ctx.tx, ctx.tenant.agencyId, q.q, DIRECTORY_SEARCH_LIMIT);
  return { items: rows };
}
