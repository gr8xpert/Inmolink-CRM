/**
 * Legacy member load queries (S14-02). Identity tables only; run as `app_system` (the load script's `withSystem()`):
 * a whole batch in a fixed number of statements, one bind parameter per column.
 */
import type { MemberRole } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { agencyMembers, users } from '@inmolink/db/schema/identity';
import { sql } from 'drizzle-orm';

const array = (values: readonly unknown[], type: string) => sql`${sql.param(values)}::${sql.raw(type)}[]`;

/** The users with these e-mails and the agency each is a member of (null: none). One statement (`users_email_uq`). */
export async function usersByEmail(
  tx: Tx,
  emails: readonly string[],
): Promise<{ id: string; email: string; agencyId: string | null; status: string }[]> {
  if (emails.length === 0) return [];
  const res = await tx.execute(sql`
    select u.id, u.email, m.agency_id as "agencyId", u.status
      from ${users} u left join ${agencyMembers} m on m.user_id = u.id
     where u.email = any(${array(emails, 'text')})`);
  return res.rows as { id: string; email: string; agencyId: string | null; status: string }[];
}

export interface LegacyUserInsert {
  id: string;
  email: string;
  name: string;
  locale: string;
  role: MemberRole;
}

/**
 * New users and their memberships, two statements. The password hash is one unusable placeholder (the hash of a
 * random secret nobody kept): the member signs in only after a password reset. The e-mail counts as verified — the
 * operator vouches for the legacy account — so a sign-up with that address can never take the account over.
 */
export async function insertLegacyMembers(
  tx: Tx,
  agencyId: string,
  rows: readonly LegacyUserInsert[],
  passwordHash: string,
): Promise<void> {
  if (rows.length === 0) return;
  const col = <K extends keyof LegacyUserInsert>(k: K, type: string) =>
    array(
      rows.map((r) => r[k]),
      type,
    );
  await tx.execute(sql`
    insert into ${users} (id, email, password_hash, name, locale, email_verified_at)
    select v.id, v.email, ${passwordHash}, v.name, v.locale, now()
      from unnest(${col('id', 'uuid')}, ${col('email', 'text')}, ${col('name', 'text')}, ${col('locale', 'text')})
        as v(id, email, name, locale)`);
  await tx.execute(sql`
    insert into ${agencyMembers} (agency_id, user_id, role, name, email)
    select ${agencyId}::uuid, v.id, v.role, v.name, v.email
      from unnest(${col('id', 'uuid')}, ${col('role', 'member_role')}, ${col('name', 'text')}, ${col('email', 'text')})
        as v(id, role, name, email)`);
}

/** Which of these users are active members of the agency (not deactivated), one statement. */
export async function activeMembersAmong(tx: Tx, agencyId: string, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const res = await tx.execute(sql`
    select m.user_id as id from ${agencyMembers} m join ${users} u on u.id = m.user_id
     where m.agency_id = ${agencyId} and m.user_id = any(${array(userIds, 'uuid')})
       and m.deactivated_at is null and u.status = 'ACTIVE'`);
  return (res.rows as { id: string }[]).map((r) => r.id);
}

/** S14 review: the agency's active members and their e-mails (at most `limit`), one statement. */
export async function activeMemberEmails(
  tx: Tx,
  agencyId: string,
  limit: number,
): Promise<{ userId: string; email: string }[]> {
  const res = await tx.execute(sql`
    select m.user_id as "userId", u.email from ${agencyMembers} m join ${users} u on u.id = m.user_id
     where m.agency_id = ${agencyId} and m.deactivated_at is null
     order by m.user_id limit ${limit}`);
  return res.rows as { userId: string; email: string }[];
}

/** Active members of the agency (the seats they take), one statement. */
export async function countActiveMembers(tx: Tx, agencyId: string): Promise<number> {
  const res = await tx.execute(sql`
    select count(*)::int as n from ${agencyMembers} where agency_id = ${agencyId} and deactivated_at is null`);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}
