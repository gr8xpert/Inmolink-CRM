import { newId } from '@inmolink/platform/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneStaleTaxonomy, STALE_TEST_AGENCY_HOURS, setupTestDb } from '../test/test-db';
import { closeDb } from './client';

beforeAll(() => setupTestDb('script'), 120_000);
afterAll(() => closeDb());

describe('pruneStaleTaxonomy', () => {
  it('[S12-F23] removes stale unused taxonomy leaf first and keeps fresh rows', async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
    await admin.connect();
    try {
      const old = `now() - interval '${STALE_TEST_AGENCY_HOURS + 1} hours'`;
      const [parent, child, fresh, group, feature, freshGroup] = Array.from({ length: 6 }, () => newId());
      const tag = parent?.slice(-8);
      await admin.query(
        `insert into locations (id, parent_id, level, depth, created_at) values
           ($1, null, 'COUNTRY', 1, ${old}), ($2, $1, 'REGION', 2, ${old}), ($3, null, 'COUNTRY', 1, now())`,
        [parent, child, fresh],
      );
      await admin.query(`insert into feature_groups (id, key, created_at) values ($1, $2, ${old}), ($3, $4, now())`, [
        group,
        `prune-${tag}`,
        freshGroup,
        `prune-fresh-${tag}`,
      ]);
      await admin.query(
        `insert into features (id, group_id, key, icon, created_at) values ($1, $2, $3, 'waves', ${old})`,
        [feature, group, `prune-f-${tag}`],
      );
      await pruneStaleTaxonomy(admin);
      const count = async (table: string, ids: unknown[]) =>
        Number((await admin.query(`select count(*) from ${table} where id = any($1::uuid[])`, [ids])).rows[0].count);
      expect(await count('locations', [parent, child])).toBe(0);
      expect(await count('locations', [fresh])).toBe(1);
      expect(await count('features', [feature])).toBe(0);
      expect(await count('feature_groups', [group])).toBe(0);
      expect(await count('feature_groups', [freshGroup])).toBe(1);
      await admin.query('delete from locations where id = $1', [fresh]);
      await admin.query('delete from feature_groups where id = $1', [freshGroup]);
    } finally {
      await admin.end();
    }
  });
});
