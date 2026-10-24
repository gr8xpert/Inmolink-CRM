import type { Tx } from '@inmolink/db';
import { closeDb } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { apiKeysPageQuery } from '../api-keys-repo';

/**
 * Query plan of the API keys list's second page (S11-F9): the cursor is a row comparison on the RAW `created_at`
 * and the id (leakproof `timestamptz` / `uuid` operators), so under RLS it is an Index Cond of
 * `api_keys_agency_created_idx`, not a Filter. 5,000 keys of the agency among 5,000 of other agencies', analysed,
 * EXPLAINed as `app_user` (RLS on, the agency's tenant setting) in a transaction that is rolled back.
 */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

it('[S11-F9] EXPLAIN as app_user: the second page of the API keys list carries the cursor in the Index Cond', async () => {
  const agencyId = newId();
  const plan = await withAdminRollback(['api_keys'], async (q) => {
    await q('set local session_replication_role = replica');
    await q(
      `insert into api_keys (id, agency_id, name, kind, prefix, key_hash, scopes, created_by, created_at)
       select gen_random_uuid(), $1, 'k' || g, 'SECRET', 'p' || g || gen_random_uuid(), 'h', array['read'],
              gen_random_uuid(), now() - g * interval '1 minute'
         from generate_series(1, 5000) g`,
      [agencyId],
    );
    await q(
      `insert into api_keys (id, agency_id, name, kind, prefix, key_hash, scopes, created_by)
       select gen_random_uuid(), gen_random_uuid(), 'o' || g, 'SECRET', 'o' || g || gen_random_uuid(), 'h',
              array['read'], gen_random_uuid()
         from generate_series(1, 5000) g`,
    );
    await q('analyze api_keys');
    await q(`select set_config('app.agency_id', $1, true)`, [agencyId]);
    await q('set local role app_user');
    const cursor = { at: new Date(), id: 'ffffffff-ffff-7fff-bfff-ffffffffffff', atUs: '2026-10-22T16:31:43.924123Z' };
    // the repo's own statement (built on a connection-less drizzle, run here as app_user), revokedAt clause included
    const query = apiKeysPageQuery(drizzle.mock() as unknown as Tx, agencyId, new Date(0), {
      limit: 25,
      cursor,
    }).toSQL();
    const rows = await q(`explain ${query.sql}`, query.params);
    return rows.map((r) => String(Object.values(r)[0])).join('\n');
  });
  console.log(`[S11-F9] api keys:\n${plan}`);
  expect(plan).toContain('api_keys_agency_created_idx');
  expect(plan).toMatch(/Index Cond: .*ROW\(created_at, id\) >/);
  expect(plan).not.toMatch(/Filter: .*created_at/);
  expect(plan).not.toMatch(/\bSort\b|Seq Scan/);
});
