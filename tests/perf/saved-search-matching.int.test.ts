import { setupTestDb, withAdminRollback } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { listingKeys } from '../../packages/core/src/modules/matching/alerts';
import { type ListingProbe, matchQuery } from '../../packages/core/src/modules/matching/repo';

/**
 * Saved-search matching at scale (S5-06 perf review): 5,000 agencies × 50 saved searches (250,000) — searches of
 * 2,000 places over the network, many broad searches of each agency's own stock (`own:<agency>:*`), and broad network
 * searches (any place: 500 for sales, 100 for anything). A batch of 100 changed listings of one agency, each at three
 * places, is matched in one statement (rolled back, nothing stays): the GIN inverse index reads only the owner's own
 * searches and the network searches of those places or anywhere — never other agencies' own-stock searches — within
 * the hot-path SQL budget.
 */

const AGENCIES = 5_000;
const PER_AGENCY = 50;
const PLACES = 2_000;
const BATCH = 100;
/** Listings per statement (`PROBE_CHUNK`). */
const CHUNK = 5;
const TYPES = 10;
const SQL_BUDGET_MS = 20;

describe('saved search matching at scale', () => {
  it('[S5-06] a batch of 100 listings probes only the searches that may see them (250k searches, 5,000 agencies)', async () => {
    await setupTestDb('worker');
    const owner = newId();
    const place = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    const type = (i: number) => `00000000-0000-4000-9000-${i.toString(16).padStart(12, '0')}`;
    const probes: ListingProbe[] = Array.from({ length: BATCH }, (_, i) => {
      const locationIds = [place(0), place(1 + (i % 20)), place(100 + i)];
      return {
        listingId: newId(),
        ownerAgencyId: owner,
        kind: 'NEW' as const,
        keys: listingKeys({ ownerAgencyId: owner, transactionType: 'SALE', locationIds, network: true }),
        transactionType: 'SALE',
        locationIds,
        propertyTypeId: type(i % TYPES),
        featureIds: [],
        priceCents: 50_000_000 + i * 100_000,
        beds: 3,
        baths: 2,
        areaM2: 120,
        network: true,
        shareAll: true,
        preferredAgencyIds: [],
      };
    });
    const plan = await withAdminRollback(['saved_searches'], async (q) => {
      await q('set local session_replication_role = replica');
      // per agency: 30 network searches of one place each, 15 broad own-stock ones, 4 own ones of a place, 1 broad
      // network one (SALE anywhere for one agency in ten, anything anywhere for one in fifty)
      await q(
        `insert into saved_searches (id, agency_id, user_id, name, property_type_ids, price_max_cents, location_ids,
                                     match_keys)
         select gen_random_uuid(), a.id, gen_random_uuid(), 'S' || s,
                -- broad network searches name a type and a budget (as buyers' searches do)
                case when s = 50 then array[('00000000-0000-4000-9000-' || lpad(to_hex(a.n % ${TYPES}), 12, '0'))::uuid]
                     else '{}'::uuid[] end,
                case when s = 50 then 30000000 + (a.n % 10) * 10000000 end,
                case when s <= 30 or (s > 45 and s <= 49)
                  then array[('00000000-0000-4000-8000-' || lpad(to_hex((a.n * 7 + s) % ${PLACES}), 12, '0'))::uuid]
                  else '{}'::uuid[] end,
                case
                  when s <= 30 then array['net:' || (case when s % 2 = 0 then 'SALE' else 'RENT_LONG_TERM' end) || ':'
                       || ('00000000-0000-4000-8000-' || lpad(to_hex((a.n * 7 + s) % ${PLACES}), 12, '0'))]
                  when s <= 45 then array['own:' || a.id || ':*']
                  when s <= 49 then array['own:' || a.id || ':SALE']
                  when a.n % 50 = 0 then array['net:*:*', 'own:' || a.id || ':*']
                  when a.n % 10 = 0 then array['net:SALE:*', 'own:' || a.id || ':SALE']
                  else array['own:' || a.id || ':RENT_LONG_TERM'] end
           from (select gen_random_uuid() as id, n from generate_series(1, ${AGENCIES}) n) a,
                generate_series(1, ${PER_AGENCY}) s`,
      );
      // the owner's own searches (broad and of its places)
      await q(
        `insert into saved_searches (id, agency_id, user_id, name, match_keys)
         select gen_random_uuid(), $1::uuid, gen_random_uuid(), 'Own ' || s, array['own:' || $1::text || ':*']
           from generate_series(1, ${PER_AGENCY}) s`,
        [owner],
      );
      await q('analyze saved_searches');
      await q(`select gin_clean_pending_list('saved_searches_match_keys_idx'::regclass)`);
      await q('set local role app_system');
      const query = new PgDialect().sqlToQuery(matchQuery(probes.slice(0, CHUNK)));
      // warm, then the median of three runs (one slow run on a shared test box is noise, not the plan); per-node
      // timing off: its clock calls per row on a virtualised test box cost more than the query
      await q(`explain (analyze, format json) ${query.sql}`, query.params);
      const runs: unknown[] = [];
      for (let r = 0; r < 3; r++) {
        const out = await q(`explain (analyze, buffers, timing off, format json) ${query.sql}`, query.params);
        runs.push(Object.values(out[0] ?? {})[0]);
      }
      const time = (x: unknown) => (x as { 'Execution Time': number }[])[0]?.['Execution Time'] ?? 0;
      return runs.sort((a, b) => time(a) - time(b))[1];
    });
    const nodes: Record<string, unknown>[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(n);
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk((plan as { Plan: Record<string, unknown> }[])[0]?.Plan as Record<string, unknown>);
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'saved_searches')).toBe(false);
    expect(nodes.find((n) => n['Node Type'] === 'Bitmap Index Scan')?.['Index Name']).toBe(
      'saved_searches_match_keys_idx',
    );
    const heap = nodes.find((n) => n['Node Type'] === 'Bitmap Heap Scan');
    const perListing = Number(heap?.['Actual Rows'] ?? 0);
    const loops = Number(heap?.['Actual Loops'] ?? 1);
    // per listing: the owner's 50, the broad network ones (600), ~75 of each of its 3 places — never the 75,000
    // own-stock searches of other agencies or the 150,000 network searches of other places
    expect(perListing).toBeLessThan(1_500);
    const ms = (plan as { 'Execution Time': number }[])[0]?.['Execution Time'] as number;
    const matches = Number(nodes[0]?.['Actual Rows'] ?? 0);
    console.info(
      `[S5-06] saved-search matching, ${AGENCIES * PER_AGENCY} searches, ${loops} listings per statement: ` +
        `${perListing} candidates per listing, ${matches} matches, ${ms.toFixed(1)} ms`,
    );
    // one statement of `CHUNK` listings (a batch of 100 is twenty): the hot-path SQL budget
    expect(ms).toBeLessThan(SQL_BUDGET_MS);
  }, 600_000);
});
