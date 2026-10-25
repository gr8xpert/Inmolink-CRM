// S12-F16 → packages/db/src/tenancy/definer-search-path.int.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminQuery, setupTestDb } from '../../test/test-db';
import { closeDb } from '../client';

/**
 * S12-F16 (S11 review): every SECURITY DEFINER function in `public` — generated helpers and migration-created trigger
 * functions alike — runs with `search_path = pg_catalog, pg_temp`: no schema a role can create objects in, pg_temp
 * last, so no caller can shadow a name the function resolves. Read from the catalog, so a later migration that adds a
 * definer without the pin fails here.
 */

beforeAll(() => setupTestDb('http'), 120_000);
afterAll(() => closeDb());

describe('SECURITY DEFINER functions', () => {
  it('[S12-F16] every prosecdef function in public has search_path=pg_catalog, pg_temp', async () => {
    const rows = await adminQuery<{ fn: string; config: string[] | null }>(
      `select p.oid::regprocedure::text as fn, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
        order by 1`,
    );
    // the generated helpers and the migrations' trigger functions: there are definers to check
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const unpinned = rows
      .filter((r) => {
        const paths = (r.config ?? []).filter((c) => c.startsWith('search_path='));
        return paths.length !== 1 || paths[0] !== 'search_path=pg_catalog, pg_temp';
      })
      .map((r) => `${r.fn}: ${(r.config ?? []).join(' ') || 'no search_path'}`);
    expect(unpinned).toEqual([]);
  });

  it('[S12-F16] the S12-F12 network refusal of chat_messages_fanout is its own error (P0001, hint network_closed)', async () => {
    const [row] = await adminQuery<{ src: string }>(
      `select prosrc as src from pg_proc where oid = 'public.chat_messages_fanout()'::regprocedure`,
    );
    expect(row?.src).toMatch(/errcode = 'P0001', hint = 'network_closed'/);
  });
});
