import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../pagination';
import { createFounder } from '../../../testing/factories';
import { listSites } from '../repo';

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

it('[S11-F9] a raw-column list pages rows whose times share a millisecond (different microseconds) with no skip or repeat', async () => {
  const f = await createFounder();
  const ids = [newId(), newId(), newId()];
  await withSystem('websites.keyset.test', async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.execute(sql`insert into website_sites (id, agency_id, name, mode, locales, default_locale, created_by, created_at)
        values (${id}, ${f.agencyId}, ${`s${i}`}, 'WIDGET', array['es'], 'es', ${newId()}, ${`2026-01-01T00:00:00.123${i}${i}${i}Z`}::timestamptz)`);
    }
  });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 6; n++) {
    const rows = await withSystem('websites.keyset.test', (tx) =>
      listSites(tx, f.agencyId, { limit: 1, cursor: decodeCursor(cursor) }),
    );
    const row = rows[0];
    if (!row) break;
    seen.push(row.id);
    cursor = encodeCursor({ at: row.createdAt, id: row.id, atUs: row.atUs });
  }
  expect(seen).toEqual(ids);
  expect(new Set(seen).size).toBe(3);
});
