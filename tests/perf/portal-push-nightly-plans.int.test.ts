import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, countQueries, withSystem, withSystemClient } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as repo from '../../packages/core/src/modules/exports/repo';

/**
 * Push teardown and nightly sweep plans at size (S10-F8, S10-F9): one push connection with 20,000 sync rows (17,000
 * adverts still up — 15,000 SYNCED, 2,000 FAILED — and 3,000 WITHDRAWN) and 20,000 portal connections over the
 * sweep's agencies, most already covered tonight. The teardown reads every advert once (keyset pages, statement and
 * row counts); `liveAdverts` / `hasLiveAdverts` read `portal_listing_sync_live_idx`, the nightly lanes
 * `agency_portal_connections_lane_idx`: no Seq Scan, < 20 ms each. The plans are logged for STATUS.
 */

const log = createLogger({ service: 'perf', level: 'info' });
const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const ROWS = 20_000;
/** Sync rows of each other agency (the table is shared). */
const OTHER_ROWS = 10_000;
const LIVE = 17_000;
const CONNECTIONS = 20_000;
const SWEEP_AGENCIES = 8;
const LANES = 6;
const PAGE = 100;
const BUDGET_MS = 20;

let owner: Founder;
const sweep: Founder[] = [];
let connectionId = '';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.portal-push-plans', fn);
const exec = (q: ReturnType<typeof sql>) =>
  system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    return tx.execute(q);
  });

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

/**
 * EXPLAIN ANALYZE of the statements `fn` ran (as app_system, with their parameters), after one warm run each; each in
 * its own rolled-back transaction (a write is measured, not kept).
 */
async function explain(fn: () => Promise<unknown>): Promise<{ indexes: string[]; seq: string[]; ms: number }[]> {
  const ran: { q: string; params: unknown[] }[] = [];
  await countQueries(fn, { onQuery: (q, params) => ran.push({ q, params }) });
  return withSystemClient('perf.portal-push-plans explain', async (client) => {
    const out: { indexes: string[]; seq: string[]; ms: number }[] = [];
    for (const { q, params } of ran) {
      await client.query('begin');
      await client.query(q, params);
      const res = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] }>(
        `explain (analyze, buffers, format json) ${q}`,
        params,
      );
      await client.query('rollback');
      const plan = res.rows[0]?.['QUERY PLAN'][0] as { Plan: PlanNode; 'Execution Time': number };
      const all = nodes(plan.Plan);
      out.push({
        indexes: all.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])),
        seq: all.flatMap((n) => (n['Node Type'] === 'Seq Scan' ? [n['Relation Name'] ?? '?'] : [])),
        ms: plan['Execution Time'],
      });
    }
    return out;
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  owner = await createFounder();
  for (let i = 0; i < SWEEP_AGENCIES; i++) sweep.push(await createFounder());
  const ids = await system(async (tx) => {
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-pp'),
      translations: tr(`Pushplan ${RUN}`, 'pushplan'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-pp-g'),
      sort: 0,
      translations: tr(`Homes ${RUN}`, 'perf-pp-g'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('perf-pp-t'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'perf-pp-t'),
    });
    return { country, type };
  });
  connectionId = newId();
  await exec(sql`
    insert into agency_portal_connections (id, agency_id, channel_code, name, token_hash, token_hint, token_created_at,
                                           created_by, enabled)
    values (${connectionId}, ${owner.agencyId}, 'kyero', 'Teardown', ${`perf-pp-${RUN}`}, 'abcd', now(),
            ${owner.userId}, false)`);
  await exec(sql`
    with l as (
      insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                              bedrooms, bathrooms, built_m2, energy_rating, lat, lng, property_type_id, location_id,
                              country_id)
      select gen_random_uuid(), ${owner.agencyId}, ${owner.userId}, 'PP' || lpad(i::text, 5, '0'), 'ACTIVE', 'PUBLIC',
             'SALE', 10000000, 2, 1, 90, 'C', 36.5, -4.9, ${ids.type}, ${ids.country}, ${ids.country}
        from generate_series(1, ${ROWS}) as i
      returning id, ref
    )
    insert into portal_listing_sync (connection_id, property_id, agency_id, state, remote_id, payload_hash, error_code,
                                     synced_at)
    select ${connectionId}, l.id, ${owner.agencyId},
           (case when n <= 15000 then 'SYNCED' when n <= ${LIVE} then 'FAILED' else 'WITHDRAWN' end)::portal_sync_state,
           'r-' || l.ref, 'h', case when n > 15000 and n <= ${LIVE} then 'PORTAL_REFUSED' end, now()
      from (select l.*, row_number() over (order by l.ref) as n from l) l`);
  // The sweep's connections: most covered tonight already (the late-night case — a lane walks past them), a few due.
  await exec(sql`
    insert into agency_portal_connections (id, agency_id, channel_code, name, token_hash, token_hint, token_created_at,
                                           created_by, nightly_at)
    select gen_random_uuid(), a.agency_id, 'kyero', 'Night ' || n, 'perf-pp-' || ${RUN} || '-' || a.k || '-' || n,
           'abcd', now(), a.user_id, case when n % 500 = 0 then null else now() end
      from unnest(${sql.raw(`array[${sweep.map((f) => `'${f.agencyId}'`).join(', ')}]::uuid[]`)},
                  ${sql.raw(`array[${sweep.map((f) => `'${f.userId}'`).join(', ')}]::uuid[]`)})
             with ordinality as a(agency_id, user_id, k),
           generate_series(1, ${CONNECTIONS / SWEEP_AGENCIES}) as n`);
  // Other agencies' push state next to it (the table is shared by every agency): 10,000 listings and sync rows each.
  for (const f of sweep) {
    await exec(sql`
      with l as (
        insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                                bedrooms, bathrooms, built_m2, energy_rating, lat, lng, property_type_id, location_id,
                                country_id)
        select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'PQ' || lpad(i::text, 5, '0'), 'ACTIVE', 'PUBLIC',
               'SALE', 10000000, 2, 1, 90, 'C', 36.5, -4.9, ${ids.type}, ${ids.country}, ${ids.country}
          from generate_series(1, ${OTHER_ROWS}) as i
        returning id
      )
      insert into portal_listing_sync (connection_id, property_id, agency_id, state, remote_id, payload_hash, synced_at)
      select (select id from agency_portal_connections where agency_id = ${f.agencyId} limit 1), l.id, ${f.agencyId},
             'SYNCED', 'q-' || l.id, 'h', now()
        from l`);
  }
  // Issue rows of the connection for every listing (a portal that refuses them all): the issue write's range delete.
  await exec(sql`
    insert into portal_connection_issues (connection_id, property_id, agency_id, errors, checked_at)
    select ${connectionId}, id, ${owner.agencyId}, '[{"code":"NO_DOCUMENT"}]'::jsonb, now() - interval '1 day'
      from properties where agency_id = ${owner.agencyId}`);
  await exec(sql`analyze portal_connection_issues`);
  await exec(sql`analyze portal_listing_sync`);
  await exec(sql`analyze agency_portal_connections`);
}, 300_000);

afterAll(async () => {
  const mine = [owner, ...sweep].map((f) => f.agencyId);
  await exec(sql`delete from agency_portal_connections where agency_id in ${mine}`);
  await exec(sql`delete from properties where agency_id in ${mine}`);
  await closeDb();
});

it('[S10-F8] teardown of 17,000 live adverts reads each row once: keyset pages, one statement per 100', async () => {
  const seen = new Set<string>();
  let rows = 0;
  let after: string | null = null;
  const statements = await countQueries(async () => {
    for (;;) {
      const from = after;
      const page: repo.SyncRow[] = await system((tx) =>
        repo.liveAdverts(tx, owner.agencyId, connectionId, { after: from, limit: PAGE }),
      );
      rows += page.length;
      for (const r of page) seen.add(r.propertyId);
      if (page.length < PAGE) break;
      after = page.at(-1)?.propertyId ?? null;
    }
  });
  // FAILED adverts are still up (only a refused withdrawal leaves the set): 17,000, each read once.
  expect(seen.size).toBe(LIVE);
  expect(rows).toBe(LIVE);
  expect(statements).toBe(Math.floor(LIVE / PAGE) + 1);
});

it('[S10-F8] EXPLAIN: liveAdverts (first and a middle page) and hasLiveAdverts use the partial index, < 20 ms', async () => {
  const middle = await system(async (tx) =>
    (await repo.liveAdverts(tx, owner.agencyId, connectionId, { after: null, limit: 8_500 })).at(-1),
  );
  const plans = await explain(async () => {
    await system((tx) => repo.liveAdverts(tx, owner.agencyId, connectionId, { after: null, limit: PAGE }));
    await system((tx) =>
      repo.liveAdverts(tx, owner.agencyId, connectionId, { after: middle?.propertyId ?? null, limit: PAGE }),
    );
    await system((tx) => repo.hasLiveAdverts(tx, owner.agencyId, connectionId));
  });
  expect(plans).toHaveLength(3);
  for (const p of plans) {
    expect(p.indexes).toContain('portal_listing_sync_live_idx');
    expect(p.seq).toEqual([]);
    expect(p.ms).toBeLessThan(BUDGET_MS);
  }
  log.info({ plans }, 'S10-F8 push teardown plans on 100,000 sync rows (20,000 of the connection)');
});

it('[S10-F9] EXPLAIN: the nightly sweep and a lane step read the lane index, no Seq Scan, < 20 ms at 20,000 connections', async () => {
  const before = new Date(Date.now() - 60 * 60_000);
  const firsts = await system((tx) => repo.firstNightlyAgencies(tx, { before, lanes: LANES }));
  const mine = new Set(sweep.map((f) => f.agencyId));
  expect(firsts.some((f) => mine.has(f.agencyId))).toBe(true);
  const start = firsts.find((f) => mine.has(f.agencyId)) as { lane: number; agencyId: string };
  const plans = await explain(async () => {
    await system((tx) => repo.firstNightlyAgencies(tx, { before, lanes: LANES }));
    await system((tx) => repo.nextNightlyAgency(tx, { before, lanes: LANES, lane: start.lane, after: start.agencyId }));
  });
  expect(plans).toHaveLength(2);
  for (const p of plans) {
    expect(p.indexes).toContain('agency_portal_connections_lane_idx');
    expect(p.seq).toEqual([]);
    expect(p.ms).toBeLessThan(BUDGET_MS);
  }
  log.info({ plans, lanes: LANES }, 'S10-F9 nightly sweep plans on 20,000 connections');
});

it('[S10-F9] EXPLAIN: one round’s issue write (range delete + upsert) reads the primary key, no Seq Scan, < 20 ms at 20,000 issues', async () => {
  const ids = await system(async (tx) =>
    (
      await tx.execute<{ id: string }>(
        sql`select property_id as id from portal_connection_issues where connection_id = ${connectionId}
               order by property_id offset 10000 limit 201`,
      )
    ).rows.map((r) => r.id),
  );
  const range = { after: ids[0] as string, upTo: ids.at(-1) as string };
  const failures = ids.slice(1, 101).map((propertyId) => ({ propertyId, errors: [{ code: 'NO_PRICE' }] }));
  const plans = await explain(() =>
    system((tx) =>
      repo.syncIssuesMany(
        tx,
        owner.agencyId,
        [
          { connectionId, range, failures },
          { connectionId, range: { after: null, upTo: ids[0] as string }, failures: [] },
        ],
        new Date(),
      ),
    ),
  );
  expect(plans).toHaveLength(1);
  for (const p of plans) {
    expect(p.seq.filter((t) => t === 'portal_connection_issues')).toEqual([]);
    expect(p.indexes).toContain('portal_connection_issues_connection_id_property_id_pk');
    expect(p.ms).toBeLessThan(BUDGET_MS);
  }
  log.info({ plans }, 'S10-F9 issue write plan on 20,000 issue rows');
});
