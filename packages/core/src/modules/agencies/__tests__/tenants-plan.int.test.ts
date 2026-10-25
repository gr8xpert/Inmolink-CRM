import { closeDb } from '@inmolink/db';
import { agencies } from '@inmolink/db/schema/agencies';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { and, eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type KeysetCursor, keysetAfterRaw, keysetOrderRaw } from '../../../pagination';

/**
 * Query plan of the staff tenants list at scale (S2-F1). 5,000 agencies (PLAN §15) are seeded and analysed on
 * a superuser connection in a transaction that is rolled back, then the query is EXPLAINed as `app_staff` (the
 * role and RLS the staff console runs with). The query is `tenants-repo.listTenants`' with the same keyset
 * helpers, so a changed sort key fails here.
 */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

const listTenants = (status: 'VERIFIED' | 'SUSPENDED' | undefined, cursor: KeysetCursor | undefined) =>
  new QueryBuilder()
    .select({ id: agencies.id, name: agencies.name, status: agencies.status, createdAt: agencies.createdAt })
    .from(agencies)
    .where(
      and(
        status ? eq(agencies.status, status) : undefined,
        keysetAfterRaw(agencies.createdAt, agencies.id, cursor, 'desc'),
      ),
    )
    .orderBy(...keysetOrderRaw(agencies.createdAt, agencies.id, 'desc'))
    .limit(26)
    .toSQL();

it('[S2-F1] EXPLAIN on scale: the status-filtered tenants list uses an index with no separate sort node', async () => {
  const plans = await withAdminRollback(['agencies'], async (q) => {
    const staff = newId();
    await q(`insert into users (id, email, password_hash, name, locale) values ($1, $2, 'x', 'Plan', 'es')`, [
      staff,
      `plan-${staff}@example.com`,
    ]);
    await q(`insert into staff_users (user_id, role) values ($1, 'SUPER_ADMIN')`, [staff]);
    await q(`
      insert into agencies (agency_id, kind, name, status, created_at)
      select gen_random_uuid(), 'AGENCY', 'Plan agency ' || g,
             (case when g % 100 = 0 then 'SUSPENDED' when g % 2 = 0 then 'VERIFIED' else 'PENDING' end)::agency_status,
             now() - (g || ' minutes')::interval
        from generate_series(1, 5000) g`);
    await q('analyze agencies');
    await q(`select set_config('app.user_id', $1, true)`, [staff]);
    await q('set local role app_staff');
    const at = new Date(Date.now() - 60 * 60_000);
    // S12-F20: the raw keyset's cursor carries the sort time's microseconds (`keysetStamp`)
    const cursor = { at, id: newId(), atUs: `${at.toISOString().slice(0, 23)}000Z` };
    const out: Record<string, string> = {};
    for (const [name, status, c] of [
      ['all, first page', undefined, undefined],
      ['VERIFIED, first page', 'VERIFIED', undefined],
      ['VERIFIED, next page', 'VERIFIED', cursor],
      ['SUSPENDED, first page', 'SUSPENDED', undefined],
      ['SUSPENDED, next page', 'SUSPENDED', cursor],
    ] as const) {
      const query = listTenants(status, c);
      const rows = await q(`explain ${query.sql}`, query.params);
      out[name] = rows.map((r) => String(Object.values(r)[0])).join('\n');
    }
    return out;
  });
  for (const [name, text] of Object.entries(plans)) {
    console.log(`[S2-F1] tenants list, ${name}:\n${text}`);
    // Under app_staff RLS a status (enum `=`, not leakproof) only filters: the keyset index gives the order.
    expect(text, name).toMatch(/Index Scan Backward using agencies_created_raw_idx/);
    expect(text, name).not.toMatch(/\bSort\b/);
    // S12-F20: a next page's cursor is an index condition under RLS, not a filter over the walk
    if (name.includes('next page')) {
      expect(text, name).toMatch(/Index Cond: \(ROW\(created_at, agency_id\) < ROW\(/);
      expect(text, name).not.toMatch(/Filter: .*created_at/);
    }
  }
});
