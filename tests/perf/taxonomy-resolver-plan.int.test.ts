import { exactMatchesSql, fuzzyMatchesSql, fuzzyThresholdSql } from '@inmolink/core/modules/taxonomy';
import { closeDb } from '@inmolink/db';
import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Resolver statements at Spain scale (S2-F5). A synthetic tree (1 country, 20 regions, 2,000 cities, 26,000
 * areas; names built from Spanish syllables in 5 locales; 20,000 aliases) is seeded and analysed on a superuser
 * connection in a transaction that is rolled back, then the repo's own statements are EXPLAIN ANALYZEd as
 * `app_system` (the role import workers resolve with) for one chunk of 500 keys. It lives in the `perf` project,
 * which runs alone after the other suites: the seed (~1 min) next to 22 parallel core forks made Windows forks crash.
 */

beforeAll(() => setupTestDb('worker'), 120_000);
afterAll(closeDb);

const TABLES = ['locations', 'location_translations', 'location_aliases'];
const SYLLABLES = `array['ma','bel','la','san','pe','dro','al','ham','bra','to','rre','mo','li','nos','fu','en','gi',
  'ro','cor','do','ba','vi','lla','nue','va','es','te','po','na','sie','rra','ca','sa','mar','sol','ri','o','ver','de']`;
/** A name of 2–4 syllables (+ a second word for every third), deterministic per seed text. */
const NAME = (seed: string) => `initcap(
  (${SYLLABLES})[1 + abs(hashtext(${seed} || 'a')) % 39] || (${SYLLABLES})[1 + abs(hashtext(${seed} || 'b')) % 39] ||
  case when abs(hashtext(${seed} || 'c')) % 2 = 0 then (${SYLLABLES})[1 + abs(hashtext(${seed} || 'd')) % 39] else '' end ||
  case when abs(hashtext(${seed} || 'e')) % 3 = 0
       then ' ' || (${SYLLABLES})[1 + abs(hashtext(${seed} || 'f')) % 39] || (${SYLLABLES})[1 + abs(hashtext(${seed} || 'g')) % 39]
       else '' end)`;

const render = (q: ReturnType<typeof exactMatchesSql>) => new PgDialect().sqlToQuery(q);

it('[S2-F5] EXPLAIN on scale: exact and fuzzy resolver statements use their indexes, no Seq Scan', async () => {
  const out = await withAdminRollback(TABLES, async (q) => {
    await q(`insert into locations (id, parent_id, level, depth, code)
             values (md5('plan-c')::uuid, null, 'COUNTRY', 1, null)`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('plan-r' || g)::uuid, md5('plan-c')::uuid, 'REGION', 2 from generate_series(1, 20) g`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('plan-ci' || g)::uuid, md5('plan-r' || (1 + g % 20))::uuid, 'CITY', 3 from generate_series(1, 2000) g`);
    await q(`insert into locations (id, parent_id, level, depth)
             select md5('plan-a' || g)::uuid, md5('plan-ci' || (1 + g % 2000))::uuid, 'AREA', 4 from generate_series(1, 26000) g`);
    await q(`insert into location_translations (location_id, parent_id, locale, name, slug)
             select l.id, l.parent_id, loc,
                    case when loc in ('es', 'en', 'de') then ${NAME('l.id::text')} else ${NAME('l.id::text || loc')} end,
                    'plan-' || replace(l.id::text, '-', '')
               from locations l cross join unnest(array['es', 'en', 'nl', 'de', 'fr']) loc
              where l.id in (select md5('plan-c')::uuid union all select md5('plan-r' || g)::uuid from generate_series(1, 20) g
                             union all select md5('plan-ci' || g)::uuid from generate_series(1, 2000) g
                             union all select md5('plan-a' || g)::uuid from generate_series(1, 26000) g)`);
    await q(`insert into location_aliases (id, location_id, alias, alias_key)
             select gen_random_uuid(), md5('plan-a' || g)::uuid, 'Plan alias ' || g, lower(${NAME("'al' || g")}) || ' ' || g
               from generate_series(1, 20000) g`);
    for (const t of TABLES) await q(`analyze ${t}`);

    // 500 keys: 250 real names with one letter changed (fuzzy territory), 250 that match nothing well.
    const names = (await q(`select distinct lower(name) as n from location_translations
                             where slug like 'plan-%' and locale = 'es' order by n limit 250`)) as { n: string }[];
    const exactKeys = names.map((r) => r.n);
    const fuzzyKeys = [
      ...exactKeys.map((k) => (k.length > 4 ? `${k.slice(0, 3)}x${k.slice(4)}` : `${k}x`)),
      ...Array.from({ length: 250 }, (_, i) => `qzw ${i} kvj`),
    ];

    // Production's planner costs (infra/ansible/roles/postgres/templates/postgresql.conf.j2, SSD): with the
    // docker default 4, the 500-key exact statement priced its index probes above one Seq Scan on some runs.
    await q('set local random_page_cost = 1.1');
    await q('set local role app_system');
    const threshold = render(fuzzyThresholdSql());
    await q(threshold.sql, threshold.params); // as `fuzzyMatches` does
    const plans: Record<string, { plan: string; ms: number }> = {};
    const statements = {
      exact: render(exactMatchesSql('location', [...exactKeys, ...fuzzyKeys.slice(250)], {})),
      'exact, level hint': render(exactMatchesSql('location', exactKeys, { level: 'CITY' })),
      fuzzy: render(fuzzyMatchesSql('location', fuzzyKeys, {})),
      'fuzzy, level hint': render(fuzzyMatchesSql('location', fuzzyKeys, { level: 'CITY' })),
      'fuzzy, parent hint': render(
        fuzzyMatchesSql('location', fuzzyKeys, { parentId: '00000000-0000-0000-0000-000000000000' }),
      ),
    };
    for (const [name, st] of Object.entries(statements)) {
      await q(st.sql, st.params); // warm the cache, as a running import's would be
      const rows = await q(`explain (analyze, costs off) ${st.sql}`, st.params);
      // Plan nodes only, each cut short: index conditions carry the 500 keys.
      const plan = rows.map((r) => String(Object.values(r)[0]).slice(0, 140)).join('\n');
      plans[name] = { plan, ms: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]) };
    }
    return plans;
  });

  for (const [name, { plan, ms }] of Object.entries(out)) {
    console.log(`[S2-F5] resolver, ${name}: ${ms} ms for 500 keys\n${plan}`);
    // 141k translations and 28k locations are never read whole. The 20k-row alias table may be: for 500
    // probes the planner prefers one seq scan (~3 ms) to 500 unique-index probes; it switches as aliases grow.
    expect(plan, name).not.toMatch(/Seq Scan on location_translations|Seq Scan on locations/);
  }
  expect(out.exact?.plan).toMatch(/location_translations_name_key_eq_idx/);
  expect(out.fuzzy?.plan).toMatch(/location_translations_name_key_idx/);
  expect(out.fuzzy?.plan).toMatch(/location_aliases_key_trgm_idx/);
  // S4-F2: a level hint is a per-candidate probe (a scalar subquery, `SubPlan`), never a hash join over `locations`
  for (const name of ['exact, level hint', 'fuzzy, level hint']) {
    expect(out[name]?.plan, name).toMatch(/SubPlan/);
    expect(out[name]?.plan, name).not.toMatch(/Hash (Semi |Right Semi )?Join/);
  }
  // Per key of a worker batch (timings vary with machine load; the plan checks above are the strict part):
  // exact ≈ 0.01 ms (one btree probe), fuzzy ≈ 2–6 ms (one GIN `%` probe), against the 20 ms SQL budget.
  expect((out.exact?.ms ?? Infinity) / 500).toBeLessThan(2);
  for (const name of ['fuzzy', 'fuzzy, level hint', 'fuzzy, parent hint']) {
    expect((out[name]?.ms ?? Infinity) / 500, name).toBeLessThan(20);
  }
}, 300_000);
