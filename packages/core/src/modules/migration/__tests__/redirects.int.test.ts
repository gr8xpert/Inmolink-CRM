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
const HOST = `legacy-${RUN}.example`;
const rowFor = (path: string, to: string, host = HOST): migration.RedirectRow => ({
  source: 'portal',
  host,
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
      const res = await migration.resolveLegacyRedirect(
        'portal',
        `WWW.${HOST}:443`,
        `${r.pathKey.toUpperCase()}/?utm_source=x`,
      );
      expect(res).toEqual({ status: 301, targetPath: r.targetPath });
    }
    expect(await migration.resolveLegacyRedirect('portal', HOST, `/es/${RUN}/none`)).toBeNull();
    expect(await migration.resolveLegacyRedirect('plugin', HOST, rows[0]?.pathKey ?? '')).toBeNull();
    expect(await migration.resolveLegacyRedirect('portal', `other-${HOST}`, rows[0]?.pathKey ?? '')).toBeNull();
    const count = await withPublicRead((tx) =>
      tx.select({ id: legacyUrlRedirects.id }).from(legacyUrlRedirects).where(eq(legacyUrlRedirects.host, HOST)),
    );
    expect(count).toHaveLength(2);
  });

  it('[S14-review] the public role reads the key and target, not the target row id or the hit statistics', async () => {
    for (const column of [legacyUrlRedirects.targetId, legacyUrlRedirects.hits, legacyUrlRedirects.lastHitAt]) {
      const err = await withPublicRead((tx) =>
        tx.select({ c: column }).from(legacyUrlRedirects).where(eq(legacyUrlRedirects.host, HOST)),
      ).then(
        () => null,
        (e: unknown) => e as { code?: string; cause?: { code?: string } },
      );
      expect(err?.code ?? err?.cause?.code).toBe('42501');
    }
  });

  it('[S14-05] hit counters are buffered and flushed in one write', async () => {
    const r = rowFor('hits', '/es/hits');
    await migration.saveRedirects([r]);
    migration.resetRedirectCache();
    for (let i = 0; i < 3; i++) await migration.resolveLegacyRedirect('portal', HOST, r.pathKey);
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

  it('[S14-review] two agencies with the same plugin path on different hosts keep their own redirects', async () => {
    const a = {
      ...rowFor('contacto', '/es/a', `a-${HOST}`),
      source: 'plugin' as const,
      locale: '',
      pathKey: '/contacto',
    };
    const b = {
      ...rowFor('contacto', '/es/b', `b-${HOST}`),
      source: 'plugin' as const,
      locale: '',
      pathKey: '/contacto',
    };
    await migration.saveRedirects([a, b]);
    migration.resetRedirectCache();
    expect(await migration.resolveLegacyRedirect('plugin', `a-${HOST}`, '/contacto/')).toEqual({
      status: 301,
      targetPath: '/es/a',
    });
    expect(await migration.resolveLegacyRedirect('plugin', `b-${HOST}`, '/Contacto')).toEqual({
      status: 301,
      targetPath: '/es/b',
    });
    expect(await migration.resolveLegacyRedirect('plugin', `c-${HOST}`, '/contacto')).toBeNull();
  });

  it('[S14-review] the database refuses a target that is not a path on this site', async () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/es\\x', '/a\nb', 'es/x']) {
      const err = await migration.saveRedirects([rowFor(`bad-${bad.length}`, bad)]).then(
        () => null,
        (e: unknown) => e,
      );
      const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
      expect(e?.constraint ?? e?.cause?.constraint).toBe('legacy_url_redirects_target_ck');
    }
    const ok = await migration.saveRedirects([rowFor('good', '/es/good')]);
    expect(ok).toBe(1);
  });
});
