import type { Tx } from '@inmolink/db';
import { agencyMembers, memberPublicProfiles, users } from '@inmolink/db/schema/identity';
import { and, eq, type SQL, sql } from 'drizzle-orm';

/**
 * Members' published portal profiles (S15-F10). Tenant reads and writes run as `app_user` (RLS `userSelect` + `write`: a
 * member reads and writes only their own row); the portal-images job reads and writes as `app_system`; the portal reads through the
 * SECURITY DEFINER lookups `member_public_profile` / `agency_public_members` as `app_public`.
 */

const columns = {
  id: memberPublicProfiles.id,
  published: memberPublicProfiles.published,
  displayName: memberPublicProfiles.displayName,
  languages: memberPublicProfiles.languages,
  phone: memberPublicProfiles.phone,
  email: memberPublicProfiles.email,
  photoStorageKey: memberPublicProfiles.photoStorageKey,
  photoContentType: memberPublicProfiles.photoContentType,
  version: memberPublicProfiles.version,
};

export interface PublicProfileRow {
  id: string;
  published: boolean;
  displayName: string;
  languages: string[];
  phone: string | null;
  email: string | null;
  photoStorageKey: string | null;
  photoContentType: string | null;
  version: number;
}

export interface PublicProfilePatch {
  published: boolean;
  displayName: string;
  languages: string[];
  phone: string | null;
  email: string | null;
}

export interface PhotoPatch {
  photoStorageKey: string | null;
  photoContentType: string | null;
}

const own = (agencyId: string, userId: string) =>
  and(eq(memberPublicProfiles.agencyId, agencyId), eq(memberPublicProfiles.userId, userId));

/** The member's own profile; null until the first save. Primary key. */
export async function getOwn(tx: Tx, agencyId: string, userId: string, lock = false): Promise<PublicProfileRow | null> {
  const q = tx.select(columns).from(memberPublicProfiles).where(own(agencyId, userId));
  const [row] = lock ? await q.for('no key update') : await q;
  return row ?? null;
}

export async function insertOwn(
  tx: Tx,
  agencyId: string,
  userId: string,
  id: string,
  patch: PublicProfilePatch,
  now: Date,
): Promise<PublicProfileRow | null> {
  const [row] = await tx
    .insert(memberPublicProfiles)
    .values({ agencyId, userId, id, ...patch, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning(columns);
  return row ?? null;
}

/** Optimistic on `version`; null when it moved on. */
export async function updateOwn(
  tx: Tx,
  agencyId: string,
  userId: string,
  version: number,
  patch: Partial<PublicProfilePatch & PhotoPatch>,
  now: Date,
): Promise<PublicProfileRow | null> {
  const [row] = await tx
    .update(memberPublicProfiles)
    .set({ ...patch, version: sql`${memberPublicProfiles.version} + 1`, updatedAt: now })
    .where(and(own(agencyId, userId), eq(memberPublicProfiles.version, version)))
    .returning(columns);
  return row ?? null;
}

/**
 * S15-F10 review: unpublishes a (deactivated) member's profile — `app_system` (the worker), since an admin's RLS cannot
 * write another member's row. Null when there is none, or it is already unpublished. One statement.
 */
export async function unpublishMember(
  tx: Tx,
  agencyId: string,
  userId: string,
  now: Date,
): Promise<{ version: number } | null> {
  const [row] = await tx
    .update(memberPublicProfiles)
    .set({ published: false, version: sql`${memberPublicProfiles.version} + 1`, updatedAt: now })
    .where(and(own(agencyId, userId), eq(memberPublicProfiles.published, true)))
    .returning({ version: memberPublicProfiles.version });
  return row ?? null;
}

/** The member's team-directory name (the default published name). */
export async function memberName(tx: Tx, agencyId: string, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: agencyMembers.name })
    .from(agencyMembers)
    .where(and(eq(agencyMembers.agencyId, agencyId), eq(agencyMembers.userId, userId)));
  return row?.name ?? null;
}

// ── Portal-images job (app_system, raw tx) ──────────────────────────────────────────────────────────────────────────

export interface PhotoState {
  userId: string;
  id: string;
  /** Published by an active member (the agency's listing is the caller's to check). */
  live: boolean;
  photoStorageKey: string | null;
  photoContentType: string | null;
  photoPublicKey: string | null;
}

/**
 * An agency's profiles that have or had a photo, `limit` at a time after user id `after` (keyset on the primary key).
 * `live` is the portal lookups' test (`member_public_profile` in `packages/db/src/tenancy/rls.ts`): published, an
 * active (not deactivated) membership and an ACTIVE user — the outer joins keep the other rows, whose copies go.
 * One statement.
 */
export async function photoStates(
  tx: Tx,
  agencyId: string,
  page: { after: string | null; limit: number },
): Promise<PhotoState[]> {
  const res = await tx.execute<{
    user_id: string;
    id: string;
    live: boolean;
    photo_storage_key: string | null;
    photo_content_type: string | null;
    photo_public_key: string | null;
  }>(sql`select p.user_id, p.id, (p.published and m.user_id is not null and u.id is not null) as live,
                p.photo_storage_key, p.photo_content_type, p.photo_public_key
           from ${memberPublicProfiles} p
           left join ${agencyMembers} m on m.agency_id = p.agency_id and m.user_id = p.user_id
                and m.deactivated_at is null
           left join ${users} u on u.id = p.user_id and u.status = 'ACTIVE'
          where p.agency_id = ${agencyId} and (p.photo_storage_key is not null or p.photo_public_key is not null)
                ${page.after ? sql`and p.user_id > ${page.after}::uuid` : sql``}
          order by p.user_id
          limit ${page.limit}`);
  return res.rows.map((r) => ({
    userId: r.user_id,
    id: r.id,
    live: r.live === true,
    photoStorageKey: r.photo_storage_key,
    photoContentType: r.photo_content_type,
    photoPublicKey: r.photo_public_key,
  }));
}

/**
 * Records the photo's public variant (or none) — only while the profile still holds `expectedStorageKey`, so a photo
 * replaced meanwhile is never shown under the old one's variant. No version bump (the member's edit stays valid).
 * S15-F10 review: a non-null key is recorded only while the profile is still live (`photoStates`' test: published, an
 * active membership, an ACTIVE user) — a member who unpublished or was deactivated during the render gets false, and
 * the job deletes the copy it just made. The agency's listing is the caller's (agencies' table; delisting re-runs it).
 */
export async function setPhotoPublicKey(
  tx: Tx,
  agencyId: string,
  userId: string,
  expectedStorageKey: string | null,
  publicKey: string | null,
): Promise<boolean> {
  const res = await tx
    .update(memberPublicProfiles)
    .set({ photoPublicKey: publicKey })
    .where(
      and(
        own(agencyId, userId),
        expectedStorageKey === null
          ? sql`${memberPublicProfiles.photoStorageKey} is null`
          : eq(memberPublicProfiles.photoStorageKey, expectedStorageKey),
        publicKey === null
          ? undefined
          : and(
              eq(memberPublicProfiles.published, true),
              sql`exists (select 1 from ${agencyMembers} m
                           where m.agency_id = ${memberPublicProfiles.agencyId}
                             and m.user_id = ${memberPublicProfiles.userId} and m.deactivated_at is null)`,
              sql`exists (select 1 from ${users} u where u.id = ${memberPublicProfiles.userId} and u.status = 'ACTIVE')`,
            ),
      ),
    )
    .returning({ id: memberPublicProfiles.id });
  return res.length > 0;
}

/** Agency erasure (S15-F10 review): up to `limit` of the agency's profiles deleted. One statement (primary key). */
export async function deleteAgencyProfiles(tx: Tx, agencyId: string, limit: number): Promise<number> {
  const res = await tx.execute(sql`delete from ${memberPublicProfiles}
                                    where agency_id = ${agencyId} and user_id in (
                                      select user_id from ${memberPublicProfiles}
                                       where agency_id = ${agencyId} order by user_id limit ${limit})`);
  return res.rowCount ?? 0;
}

// ── Portal reads (app_public, SECURITY DEFINER lookups) ─────────────────────────────────────────────────────────────

export interface PublicMemberRow {
  id: string;
  agencyId: string;
  displayName: string;
  languages: string[];
  phone: string | null;
  email: string | null;
  photoKey: string | null;
}

/** A published member's portal profile (`member_public_profile`); null for any other id. One statement. */
export async function publicMember(tx: Tx, id: string): Promise<PublicMemberRow | null> {
  const res = await tx.execute<{
    id: string;
    agency_id: string;
    display_name: string;
    languages: string[] | null;
    phone: string | null;
    email: string | null;
    photo_key: string | null;
  }>(sql`select id, agency_id, display_name, languages, phone, email, photo_key
           from public.member_public_profile(${id}::uuid)`);
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    agencyId: r.agency_id,
    displayName: r.display_name,
    languages: r.languages ?? [],
    phone: r.phone,
    email: r.email,
    photoKey: r.photo_key,
  };
}

/** `agency_public_members` as a scalar subquery: a JSON array `[{id, name, photoKey}]` in name order. */
export function publicMembersJson(agencyId: SQL | string): SQL {
  return sql`(select coalesce(json_agg(json_build_object('id', m.id, 'name', m.display_name, 'photoKey', m.photo_key)
                                       order by m.display_name, m.id), '[]'::json)
                from public.agency_public_members(${agencyId}::uuid) m)`;
}
