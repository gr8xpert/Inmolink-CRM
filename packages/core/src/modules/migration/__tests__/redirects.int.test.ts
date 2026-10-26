import { closeDb, withPublicRead, withSystem } from '@inmolink/db';
import { legacyUrlRedirects } from '@inmolink/db/schema/migration';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as migration from '../index';

/** Legacy redirect maps on the real test database (S14-05). Needs migration `legacy_url_redirects` applied. */

const RUN = newId().slice(-8).toLowerCase();
const L = newId();
const rowFor = (path: string, to: string): migration.RedirectRow => ({
  source: 'portal',
  locale: 'es',
  pathKey: `/es/${RUN}/${path}`,
  targetPath: to,
  entity: 'listing',
  targetId: L,
  status: 301,
});

beforeAll(async () => {
  await setupTestDb('worker');
  migration.resetRedirectCache();
});
afterAll(async () => {
  await withSystem('migration.test', (tx) => tx.delete(legacyUrlRedirects).where(eq(legacyUrlRedirects.targetId, L)));
  await closeDb();
});

describe('legacy redirects', () => {
  it('[S14-05] every saved legacy URL resolves to a 301 target; an unknown URL does not; re-saving is idempotent', async () => {
    const rows = [rowFor('a', `/es/listing/${L}`), rowFor('b', '/es/b')];
    await migration.saveRedirects(rows);
    await migration.saveRedirects(rows);
    for (const r of rows) {
      const res = await migration.resolveLegacyRedirect('portal', r.pathKey.toUpperCase() + '/?utm_source=x');
      expect(res).toEqual({ status: 301, targetPath: r.targetPath });
    }
    expect(await migration.resolveLegacyRedirect('portal', `/es/${RUN}/none`)).toBeNull();
    expect(await migration.resolveLegacyRedirect('plugin', rows[0]?.pathKey ?? '')).toBeNull();
    const count = await withPublicRead((tx) =>
      tx.select({ id: legacyUrlRedirects.id }).from(legacyUrlRedirects).where(eq(legacyUrlRedirects.targetId, L)),
    );
    expect(count).toHaveLength(2);
  });

  it('[S14-05] hit counters are buffered and flushed in one write', async () => {
    const r = rowFor('hits', '/es/hits');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    for (let i = 0; i < 3; i++) await migration.resolveLegacyRedirect('portal', r.pathKey);
    expect(await migration.flushRedirectHits()).toBe(1);
    expect(await migration.flushRedirectHits()).toBe(0);
    const [row] = await withSystem('migration.test', (tx) =>
      tx
        .select({ hits: legacyUrlRedirects.hits, at: legacyUrlRedirects.lastHitAt })
        .from(legacyUrlRedirects)
        .where(eq(legacyUrlRedirects.pathKey, r.pathKey)),
    );
    expect(row?.hits).toBe(3);
    expect(row?.at).not.toBeNull();
  });

  it('[S14-05] a changed target replaces the old one and keeps the hits', async () => {
    const r = rowFor('hits', '/es/moved');
    await migration.saveRedirects([r]);
    const [row] = await withSystem('migration.test', (tx) =>
      tx.select().from(legacyUrlRedirects).where(eq(legacyUrlRedirects.pathKey, r.pathKey)),
    );
    expect(row?.targetPath).toBe('/es/moved');
    expect(row?.hits).toBe(3);
  });
});
