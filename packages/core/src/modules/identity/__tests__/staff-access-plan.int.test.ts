import { closeDb } from '@inmolink/db';
import { agencyMembers, staffImpersonations } from '@inmolink/db/schema/identity';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { and, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type KeysetCursor, keysetAfter, keysetOrder } from '../../../pagination';

/**
 * Query plan of an agency's staff access list at scale (S2-F1). 300 agencies and 30,000 sessions are seeded and
 * analysed on a superuser connection in a transaction that is rolled back, then the query is EXPLAINed as
 * `app_user`, an admin of the agency (the role and RLS `GET /v1/staff-access` runs with). The query is
 * `impersonation-repo.listStaffAccess`' with the same join and keyset helpers.
 */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

const listStaffAccess = (agencyId: string, cursor: KeysetCursor | undefined) =>
  new QueryBuilder()
    .select({
      id: staffImpersonations.id,
      startedAt: staffImpersonations.startedAt,
      memberName: sql<string>`coalesce(${agencyMembers.name}, '')`,
    })
    .from(staffImpersonations)
    .leftJoin(
      agencyMembers,
      and(
        eq(agencyMembers.agencyId, staffImpersonations.agencyId),
        eq(agencyMembers.userId, staffImpersonations.targetUserId),
      ),
    )
    .where(
      and(
        eq(staffImpersonations.agencyId, agencyId),
        keysetAfter(staffImpersonations.startedAt, staffImpersonations.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrder(staffImpersonations.startedAt, staffImpersonations.id, 'desc'))
    .limit(26)
    .toSQL();

it('[S2-F1] EXPLAIN on scale: the staff access list uses an index with no separate sort node', async () => {
  const plans = await withAdminRollback(['staff_impersonations', 'agency_members'], async (q) => {
    const staff = newId();
    const admin = newId();
    const tag = newId().slice(-8);
    await q(
      `insert into users (id, email, password_hash, name, locale)
       select u, 'plan-' || u || '@example.com', 'x', 'Plan', 'es' from unnest($1::uuid[]) u`,
      [[staff, admin]],
    );
    const ids = (
      await q<{ id: string }>(
        `insert into agencies (agency_id, kind, name)
         select gen_random_uuid(), 'AGENCY', 'Plan ' || $1 || ' ' || g from generate_series(0, 299) g
         returning agency_id as id`,
        [tag],
      )
    ).map((r) => r.id);
    const agencyId = ids[0] as string;
    await q(
      `insert into agency_members (agency_id, user_id, role, name, email)
       values ($1, $2, 'AGENCY_ADMIN', 'Plan admin', 'plan-admin@example.com')`,
      [agencyId, admin],
    );
    // Every 10th session is the measured agency's; the rest spread over the other 299.
    await q(
      `insert into staff_impersonations (id, agency_id, staff_user_id, target_user_id, reason, started_at, expires_at, ended_at)
       select gen_random_uuid(), ($1::uuid[])[1 + case when g % 10 = 0 then 0 else 1 + g % 299 end], $2, $3,
              'Plan check: seeded session', now() - (g || ' minutes')::interval,
              now() - (g || ' minutes')::interval + interval '30 minutes', now() - (g || ' minutes')::interval + interval '5 minutes'
         from generate_series(1, 30000) g`,
      [ids, staff, admin],
    );
    await q('analyze staff_impersonations');
    await q(`select set_config('app.agency_id', $1, true), set_config('app.user_id', $2, true)`, [agencyId, admin]);
    await q('set local role app_user');
    const cursor = { at: new Date(Date.now() - 60 * 60_000), id: newId() };
    const out: Record<string, string> = {};
    for (const [name, c] of [
      ['first page', undefined],
      ['next page', cursor],
    ] as const) {
      const query = listStaffAccess(agencyId, c);
      const rows = await q(`explain ${query.sql}`, query.params);
      out[name] = rows.map((r) => String(Object.values(r)[0])).join('\n');
    }
    return out;
  });
  for (const [name, text] of Object.entries(plans)) {
    console.log(`[S2-F1] staff access list, ${name}:\n${text}`);
    expect(text, name).toMatch(/Index Scan Backward using staff_impersonations_agency_idx/);
    expect(text, name).not.toMatch(/\bSort\b/);
  }
});
