import { buildLocationTree, localizedLocationsSql } from '@inmolink/core/modules/taxonomy';
import { closeDb } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Cold taxonomy reload at Spain scale (S3-F2). The S2-F5 synthetic tree (1 country, 20 regions, 2,000 cities,
 * 26,000 areas, 5 locales → 140k translations) is seeded in a rolled-back superuser transaction, then the reload
 * statement runs as `app_public` (the role website reads load with) and its rows are nested into the tree. The
 * old whole-tree DISTINCT ON sorted every locale (0.9 s with a disk spill); two keyed locale joins sort nothing.
 */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

const TABLES = ['locations', 'location_translations'];

it('[S3-F2] cold reload of a Spain-sized tree < 300 ms with no sort spill (EXPLAIN)', async () => {
  const out = await withAdminRollback(TABLES, async (q) => {
    await q(`insert into locations (id, parent_id, level, depth)
             values (md5('reload-c')::uuid, null, 'COUNTRY', 1)`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('reload-r' || g)::uuid, md5('reload-c')::uuid, 'REGION', 2 from generate_series(1, 20) g`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('reload-ci' || g)::uuid, md5('reload-r' || (1 + g % 20))::uuid, 'CITY', 3
               from generate_series(1, 2000) g`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('reload-a' || g)::uuid, md5('reload-ci' || (1 + g % 2000))::uuid, 'AREA', 4
               from generate_series(1, 26000) g`);
    // Every location in es, en, nl, de and fr — except 500 areas only in fr (the "any locale" fallback path).
    await q(`insert into location_translations (location_id, parent_id, locale, name, slug)
             select l.id, l.parent_id, loc, 'Lugar ' || substr(md5(l.id::text || loc), 1, 10),
                    'reload-' || replace(l.id::text, '-', '')
               from locations l cross join unnest(array['es', 'en', 'nl', 'de', 'fr']) loc
              where l.id in (
                      select md5('reload-c')::uuid union all select md5('reload-r' || g)::uuid from generate_series(1, 20) g
                      union all select md5('reload-ci' || g)::uuid from generate_series(1, 2000) g
                      union all select md5('reload-a' || g)::uuid from generate_series(501, 26000) g)
                 or (loc = 'fr' and l.id in (select md5('reload-a' || g)::uuid from generate_series(1, 500) g))`);
    for (const t of TABLES) await q(`analyze ${t}`);

    await q('set local role app_public');
    // German: wanted locale 'de', fallback English.
    const st = new PgDialect().sqlToQuery(localizedLocationsSql('de'));
    await q(st.sql, st.params); // warm the buffers, as a running process's would be
    const plan = (await q(`explain (analyze, buffers) ${st.sql}`, st.params))
      .map((r) => String(Object.values(r)[0]))
      .join('\n');
    // Server time without per-node timing overhead; the test's superuser connection over Docker Desktop adds a
    // transfer the app's pooled connection on the database host does not have, so wall time is logged only.
    const timed = (await q(`explain (analyze, timing off) ${st.sql}`, st.params)).map((r) =>
      String(Object.values(r)[0]),
    );
    const execMs = Number(/Execution Time: ([\d.]+) ms/.exec(timed.join('\n'))?.[1]);
    const started = performance.now();
    const rows = (await q(st.sql, st.params)) as Parameters<typeof buildLocationTree>[1];
    const fetched = performance.now();
    const tree = buildLocationTree('de', rows, []);
    const buildMs = performance.now() - fetched;
    return {
      plan,
      execMs,
      buildMs,
      wallMs: performance.now() - started,
      rows: rows.length,
      countries: tree.locations.length,
    };
  });

  const ms = out.execMs + out.buildMs;
  console.log(
    `[S3-F2] cold reload: ${out.rows} rows — statement ${out.execMs.toFixed(0)} ms + tree ${out.buildMs.toFixed(0)} ms = ${ms.toFixed(0)} ms (wall with transfer ${out.wallMs.toFixed(0)} ms)\n${out.plan}`,
  );
  expect(out.rows).toBeGreaterThanOrEqual(28_021);
  expect(out.countries).toBeGreaterThanOrEqual(1);
  // no sort or hash spill: no external sort, no temp buffers, no multi-batch hash
  expect(out.plan).not.toMatch(/Sort Method: external|Disk:|temp (read|written)=|Batches: [2-9]/);
  expect(out.plan).not.toMatch(/Unique|Sort Key: l\.id/);
  expect(ms).toBeLessThan(300);
}, 300_000);
