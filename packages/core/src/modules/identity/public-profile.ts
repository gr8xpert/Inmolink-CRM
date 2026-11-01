import {
  MEMBER_PHOTO_MAX_BYTES,
  MEMBER_PHOTO_TYPES,
  MemberDisplayName,
  type MemberPublicProfileDto,
  type UpdateMemberPublicProfileBody,
} from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { CONTENT_LOCALES, isContentLocale } from '@inmolink/i18n';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import { detectFileType, storage } from '@inmolink/platform/storage';
import type { Ctx, CtxRunner } from '../../context';
import type * as agencies from '../agencies';
import * as compliance from '../compliance';
import { identityEvents } from './events';
import { assertCan } from './policy';
import * as repo from './public-profile-repo';

/**
 * A member's published portal profile (S15-F10, PLAN §7 M14). Opt-in: nothing is published until the member saves
 * with `published: true`, and only what they typed here (name, languages, phone, e-mail) and the photo they upload is
 * shown — never their login e-mail, role or anything else of the agency's. Each member reads and changes only their
 * own (policy + RLS `userSelect` / `write`); staff impersonating a member may look but not change it. The portal shows it while
 * the member is active and the agency is verified and listed (the SECURITY DEFINER lookups check both on every read).
 * Every change emits `identity.publicProfile.updated` in its transaction: the portal-images job (media) publishes or
 * removes the photo's public variant.
 */

function userOf(ctx: Ctx): { userId: string; impersonatedBy: string | null } {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return { userId: ctx.actor.userId, impersonatedBy: ctx.actor.impersonatedBy ?? null };
}

function toDto(row: repo.PublicProfileRow | null, fallbackName: string): MemberPublicProfileDto {
  return {
    id: row?.id ?? null,
    published: row?.published ?? false,
    displayName: row?.displayName ?? fallbackName,
    languages: row?.languages ?? [],
    phone: row?.phone ?? null,
    email: row?.email ?? null,
    photo: row?.photoStorageKey ? { contentType: row.photoContentType as (typeof MEMBER_PHOTO_TYPES)[number] } : null,
    version: row?.version ?? 0,
  };
}

/**
 * The name a profile starts with before its first save: the member's team name when it is a valid published name
 * (`MemberDisplayName`), else empty — the form never offers a value its own save would refuse.
 */
async function defaultName(ctx: Ctx, userId: string): Promise<string> {
  const parsed = MemberDisplayName.safeParse((await repo.memberName(ctx.tx, ctx.tenant.agencyId, userId)) ?? '');
  return parsed.success ? parsed.data : '';
}

/** `GET /v1/me/public-profile`: the member's own (before the first save: their team name, unpublished). */
export async function getMyPublicProfile(ctx: Ctx): Promise<MemberPublicProfileDto> {
  const { userId } = userOf(ctx);
  assertCan(ctx, 'identity.publicProfile.read', { userId });
  const row = await repo.getOwn(ctx.tx, ctx.tenant.agencyId, userId);
  return toDto(row, row ? '' : await defaultName(ctx, userId));
}

const FIELDS = ['published', 'displayName', 'phone', 'email'] as const;

/**
 * `PUT /v1/me/public-profile`: replaces the member's own profile (optimistic on `version`, 0 creates it). A save that
 * changes nothing writes and emits nothing.
 */
export async function updateMyPublicProfile(
  ctx: Ctx,
  input: UpdateMemberPublicProfileBody,
): Promise<MemberPublicProfileDto> {
  const { userId } = userOf(ctx);
  assertCan(ctx, 'identity.publicProfile.update', { userId });
  const unsupported = input.languages.filter((l) => !isContentLocale(l));
  if (unsupported.length > 0) {
    throw new AppError('VALIDATION_FAILED', { field: 'languages', unsupported, supported: [...CONTENT_LOCALES] });
  }
  const { agencyId } = ctx.tenant;
  const { version, ...patch } = input;
  const current = await repo.getOwn(ctx.tx, agencyId, userId);
  if ((current?.version ?? 0) !== version) throw new AppError('VERSION_CONFLICT');
  if (
    current &&
    FIELDS.every((f) => current[f] === patch[f]) &&
    JSON.stringify(current.languages) === JSON.stringify(patch.languages)
  ) {
    return toDto(current, '');
  }
  const now = clock.now();
  const row =
    version === 0
      ? await repo.insertOwn(ctx.tx, agencyId, userId, newId(), patch, now)
      : await repo.updateOwn(ctx.tx, agencyId, userId, version, patch, now);
  if (!row) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    identityEvents.publicProfileUpdated({ agencyId, userId, version: row.version, photoChanged: false }),
  );
  await compliance.audit(
    ctx,
    'identity.publicProfile.updated',
    { type: 'user', id: userId },
    { published: row.published, photoChanged: false },
  );
  return toDto(row, '');
}

/** Photo object keys: per agency, from a fresh UUIDv7, never from the file name (the row CHECK requires the prefix). */
const photoKey = (agencyId: string) => `member-photos/${agencyId}/${newId()}`;

async function setPhoto(
  ctx: Ctx,
  userId: string,
  photo: repo.PhotoPatch,
): Promise<{ profile: MemberPublicProfileDto; previousKey: string | null }> {
  const { agencyId } = ctx.tenant;
  const current = await repo.getOwn(ctx.tx, agencyId, userId, true);
  // The photo belongs to a saved profile: the member names themselves (and decides to publish) first.
  if (!current) throw new AppError('VALIDATION_FAILED', { field: 'profile', reason: 'save the profile first' });
  if (current.photoStorageKey === photo.photoStorageKey) return { profile: toDto(current, ''), previousKey: null };
  const row = await repo.updateOwn(ctx.tx, agencyId, userId, current.version, photo, clock.now());
  if (!row) throw new AppError('VERSION_CONFLICT');
  await emit(
    ctx.tx,
    identityEvents.publicProfileUpdated({ agencyId, userId, version: row.version, photoChanged: true }),
  );
  await compliance.audit(
    ctx,
    'identity.publicProfile.updated',
    { type: 'user', id: userId },
    { published: row.published, photoChanged: true },
  );
  return { profile: toDto(row, ''), previousKey: current.photoStorageKey };
}

/**
 * `PUT /v1/me/public-profile/photo`: replaces the member's photo. Checked by magic bytes (PNG, JPEG, WebP) and size,
 * stored as uploaded in the private bucket (`member-photos/<agency>/<id>`) outside any transaction; the portal-images
 * job re-encodes it (metadata stripped) into the public variant the portal shows. The replaced object is deleted after
 * the commit.
 */
export async function uploadMyPublicProfilePhoto(
  run: CtxRunner,
  input: { body: Uint8Array },
): Promise<MemberPublicProfileDto> {
  if (input.body.byteLength === 0) throw new AppError('VALIDATION_FAILED', { field: 'body', reason: 'empty' });
  if (input.body.byteLength > MEMBER_PHOTO_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { maxBytes: MEMBER_PHOTO_MAX_BYTES });
  }
  const type = detectFileType(input.body);
  if (!type || !(MEMBER_PHOTO_TYPES as readonly string[]).includes(type.contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', { allowed: [...MEMBER_PHOTO_TYPES] });
  }
  const who = await run(async (ctx) => {
    const { userId } = userOf(ctx);
    assertCan(ctx, 'identity.publicProfile.update', { userId });
    if (!(await repo.getOwn(ctx.tx, ctx.tenant.agencyId, userId))) {
      throw new AppError('VALIDATION_FAILED', { field: 'profile', reason: 'save the profile first' });
    }
    return { agencyId: ctx.tenant.agencyId, userId };
  });
  const key = photoKey(who.agencyId);
  await storage().put('private', key, input.body, { contentType: type.contentType });
  let result: { profile: MemberPublicProfileDto; previousKey: string | null };
  try {
    result = await run(async (ctx) => {
      const { userId } = userOf(ctx);
      if (ctx.tenant.agencyId !== who.agencyId || userId !== who.userId) throw new AppError('FORBIDDEN');
      assertCan(ctx, 'identity.publicProfile.update', { userId });
      return setPhoto(ctx, userId, { photoStorageKey: key, photoContentType: type.contentType });
    });
  } catch (err) {
    await storage()
      .delete('private', key)
      .catch(() => {});
    throw err;
  }
  if (result.previousKey) {
    await storage()
      .delete('private', result.previousKey)
      .catch(() => {});
  }
  return result.profile;
}

/** `DELETE /v1/me/public-profile/photo`: removes the photo (row first, then the object, outside the transaction). */
export async function removeMyPublicProfilePhoto(run: CtxRunner): Promise<MemberPublicProfileDto> {
  const result = await run(async (ctx) => {
    const { userId } = userOf(ctx);
    assertCan(ctx, 'identity.publicProfile.update', { userId });
    const current = await repo.getOwn(ctx.tx, ctx.tenant.agencyId, userId);
    if (!current?.photoStorageKey) {
      return {
        profile: toDto(current, current ? '' : await defaultName(ctx, userId)),
        previousKey: null,
      };
    }
    return setPhoto(ctx, userId, { photoStorageKey: null, photoContentType: null });
  });
  if (result.previousKey) {
    await storage()
      .delete('private', result.previousKey)
      .catch(() => {});
  }
  return result.profile;
}

// ── Portal-images job (worker, raw tx under `withSystem`) ───────────────────────────────────────────────────────────

export type MemberPhotoState = repo.PhotoState;

/**
 * S15-F10: an agency's members' photos and whether each profile is live (published, active member, active user), a
 * page at a time after user id `after`.
 */
export function memberPhotoStates(
  tx: Tx,
  agencyId: string,
  page: { after: string | null; limit: number },
): Promise<MemberPhotoState[]> {
  return repo.photoStates(tx, agencyId, { after: page.after, limit: Math.min(Math.max(page.limit, 1), 500) });
}

/** S15-F10: records a photo's public variant, only while the profile still holds that photo. */
export function setMemberPhotoPublicKey(
  tx: Tx,
  agencyId: string,
  userId: string,
  expectedStorageKey: string | null,
  publicKey: string | null,
): Promise<boolean> {
  return repo.setPhotoPublicKey(tx, agencyId, userId, expectedStorageKey, publicKey);
}

/** Profiles deleted, and objects of each prefix listed, per agency-erasure call. */
export const MEMBER_PROFILE_ERASE_BATCH = 500;

/**
 * Agency erasure (S16-04 phase `memberProfiles`, S15-F10 review): one bounded batch — up to
 * `MEMBER_PROFILE_ERASE_BATCH` of the agency's profiles deleted (the names, phones and e-mails the members published),
 * then a page of each photo prefix: the uploads (`member-photos/<agency>/`, private bucket) and their public copies
 * (`portal/member-photos/<agency>/`, media bucket). Rows first: once they are gone nothing points at an object, and a
 * resumed call lists what is left. Worker only (`withSystem`); network I/O outside the transaction.
 */
export async function eraseAgencyPublicProfiles(p: {
  agencyId: string;
  signal?: AbortSignal;
}): Promise<{ profiles: number; objects: number; more: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(p.agencyId)) throw new Error('eraseAgencyPublicProfiles: not an agency id');
  const agencyId = p.agencyId.toLowerCase();
  const profiles = await withSystem('identity.eraseAgencyPublicProfiles', (tx) =>
    repo.deleteAgencyProfiles(tx, agencyId, MEMBER_PROFILE_ERASE_BATCH),
  );
  if (profiles >= MEMBER_PROFILE_ERASE_BATCH) return { profiles, objects: 0, more: true };
  let objects = 0;
  let more = false;
  for (const [bucket, prefix] of [
    ['private', `member-photos/${agencyId}/`],
    ['media', `portal/member-photos/${agencyId}/`],
  ] as const) {
    const listed = await storage().list(bucket, prefix, { limit: MEMBER_PROFILE_ERASE_BATCH });
    let aborted = false;
    // S15-F10 review: a few deletes in flight, not one round trip at a time.
    await eachLimit(listed.objects, MEMBER_PROFILE_ERASE_CONCURRENCY, async (o) => {
      if (p.signal?.aborted) {
        aborted = true;
        return;
      }
      await storage().delete(bucket, o.key);
      objects++;
    });
    if (aborted) return { profiles, objects, more: true };
    if (listed.next) more = true;
  }
  return { profiles, objects, more };
}

/** Object deletes in flight per erasure call. */
const MEMBER_PROFILE_ERASE_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight (a module-local copy, as in developments' jobs). */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * S15-F10 review: a deactivated member's profile is unpublished, so a reactivated member is shown again only after a
 * fresh opt-in. The admin's deactivation runs as `app_user`, whose RLS lets only the member write their own profile,
 * so the worker does it on `identity.member.deactivated` (`withSystem`, the reason is the audit line). Emits
 * `identity.publicProfile.updated` in the same transaction; idempotent (a profile already unpublished is untouched).
 */
export async function unpublishDeactivatedMember(p: { agencyId: string; userId: string }): Promise<boolean> {
  return withSystem('identity.unpublishDeactivatedMember (member deactivated)', async (tx) => {
    const row = await repo.unpublishMember(tx, p.agencyId, p.userId, clock.now());
    if (!row) return false;
    await emit(
      tx,
      identityEvents.publicProfileUpdated({
        agencyId: p.agencyId,
        userId: p.userId,
        version: row.version,
        photoChanged: false,
      }),
    );
    return true;
  });
}

// ── Portal reads (app_public) ───────────────────────────────────────────────────────────────────────────────────────

export type PublicMember = repo.PublicMemberRow;

/** S15-F10: a published member's portal profile by its page id; null for any other id. One statement (`app_public`). */
export function publicMember(tx: Tx, id: string): Promise<PublicMember | null> {
  return repo.publicMember(tx, id);
}

export interface PublicMemberLinkRow {
  id: string;
  name: string;
  photoKey: string | null;
}

/**
 * S15-F10: a listed agency's published team as part of another statement (as `publicAgencyProfile`'s `extra`): `sql`
 * is a scalar subquery the caller selects, `read` turns its JSON into rows (name order, at most 100).
 */
export function publicMembersQuery(agencyId: string): {
  sql: agencies.AgencyTeamColumn;
  read: (value: unknown) => PublicMemberLinkRow[];
} {
  return {
    // The producer of the agencies module's one foreign column (see `AgencyTeamColumn`).
    sql: repo.publicMembersJson(agencyId) as agencies.AgencyTeamColumn,
    read: (value) =>
      ((value ?? []) as { id: string; name: string; photoKey: string | null }[]).map((m) => ({
        id: m.id,
        name: m.name,
        photoKey: m.photoKey ?? null,
      })),
  };
}
