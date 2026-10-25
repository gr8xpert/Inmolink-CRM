import * as agencies from '@inmolink/core/modules/agencies';
import * as exportsWorker from '@inmolink/core/modules/exports/worker';
import * as matching from '@inmolink/core/modules/matching';
import * as media from '@inmolink/core/modules/media';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import { createFounder, type Founder } from '@inmolink/core/test';
import { withSystem } from '@inmolink/db';
import { setAgencyStatus } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { newId } from '@inmolink/platform/ids';
import { createDispatcher, emit } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { log, runId, runSystem, setupQueueTest, teardownQueueTest, waitFor } from '../queue/helpers';

/**
 * Outbox fan-out of a 10,000-listing import (S13-F10 · S12 review): the import emits `properties.listings.imported`
 * (≤ 250 listings per event), the search subscription queues the read-model rebuilds, the build (`drainReadModelQueue`,
 * the body of `search.buildReadModels`) writes the read models and emits `search.listings.changed` (matching's
 * saved-search alerts) and `search.publicDocs.changed` (white-label edge purge, site feeds, exports) — all consumed by
 * the real subscriptions of search, matching, website-api and exports on the real dispatcher and queues.
 * Budgets: the events the import and its builds emit stay within 2 per 100 listings; the outbox backlog (every event
 * emitted by the builds) is fully delivered within LAG_BUDGET_MS of the last build's commit. (`created_at` is the
 * emitting transaction's start, so the per-event lag printed includes the build transaction's own duration.)
 * The agency, its listings and its events are this run's own and deleted afterwards.
 */

const RUN = runId();
const LISTINGS = 10_000;
const POOLS = ['indexing', 'matching', 'exports', 'default', 'website-api'];
/** `search.listings.changed` and `search.publicDocs.changed` for every 100 listings, imported events included. */
const EVENTS_PER_100 = 2;
/** The import's own `properties.listings.imported` events (≤ 250 listings each: 0.4 per 100). */
const IMPORTED_PER_100 = 0.5;
const LAG_BUDGET_MS = 10_000;
const code = (s: string) => `${s}-fanout-${RUN}`;

let owner: Founder;
let listingIds: string[] = [];

beforeAll(async () => {
  await setupQueueTest(`test-${RUN}`);
  await configureCache({ prefix: `t:fanout:${RUN}` });
  media.configureMedia({ urlKey: `perf-fanout-key-${RUN}-0123456789abcdef0123` });
  owner = await createFounder();
  await setAgencyStatus(owner.agencyId, 'VERIFIED');
  const ids = await withSystem('perf.import-fanout', async (tx) => {
    const tr = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: tr('Fanland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: tr('Homes') });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('v'),
      sort: 0,
      translations: tr('Villa'),
    });
    return { location, type };
  });
  // 10,000 live, shared listings as a first import leaves them (one statement; refs unique per agency).
  const made = await withSystem('perf.import-fanout', async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    const res = await tx.execute(sql`
      with l as (
        insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                                bedrooms, bathrooms, built_m2, energy_rating, property_type_id, location_id, country_id)
        select gen_random_uuid(), ${owner.agencyId}, ${owner.userId}, 'FO' || lpad(i::text, 6, '0'), 'ACTIVE',
               'PUBLIC', 'SALE', 10000000 + i::bigint * 10000, i % 6, i % 4, 80 + i % 300, 'C',
               ${ids.type}, ${ids.location}, ${ids.location}
          from generate_series(1, ${LISTINGS}) as i
        returning id
      ),
      t as (
        insert into property_translations (property_id, agency_id, locale, title, description, slug)
        select l.id, ${owner.agencyId}, 'en', 'Villa with sea views', 'A bright villa close to the beach.',
               'villa-' || replace(l.id::text, '-', '')
          from l
        returning 1
      )
      select id from l`);
    return res.rows.map((r) => (r as { id: string }).id);
  });
  listingIds = made;
  expect(listingIds).toHaveLength(LISTINGS);
}, 600_000);

afterAll(async () => {
  await withSystem('perf.import-fanout', async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    const a = owner.agencyId;
    await tx.execute(sql`delete from read_model_queue where owner_agency_id = ${a}`);
    await tx.execute(
      sql`delete from search_index_queue where target_id in (select id from properties where agency_id = ${a})`,
    );
    await tx.execute(sql`delete from listing_public_changes where owner_agency_id = ${a}`);
    await tx.execute(sql`delete from listing_read_models where agency_id = ${a}`);
    await tx.execute(sql`delete from outbox_events where agency_id = ${a}`);
    await tx.execute(sql`delete from properties where agency_id = ${a}`);
  }).catch((err) => log.warn({ err }, 'cleanup failed'));
  await closeCache();
  await teardownQueueTest(POOLS);
}, 600_000);

it('[S13-F10] a 10k-listing import fans out to ≤ 2 events per 100 listings, delivered within the lag budget (matching, white-label, read models)', async () => {
  search.registerSearchSubscriptions();
  matching.registerMatchingSubscriptions();
  websiteApi.registerWebsiteApiSubscriptions();
  exportsWorker.registerExportsSubscriptions();
  agencies.registerAgenciesSubscriptions();
  const dispatcher = createDispatcher({ runSystem, logger: log, pollMs: 50, agencyIds: [owner.agencyId] });
  try {
    // The import's own events: one per 250 listings, one INSERT (as `emitImported` does it).
    const imported: ReturnType<typeof properties.propertiesEvents.imported>[] = [];
    for (let i = 0; i < listingIds.length; i += properties.IMPORTED_PER_EVENT) {
      imported.push(
        properties.propertiesEvents.imported({
          agencyId: owner.agencyId,
          runId: newId(),
          listingIds: listingIds.slice(i, i + properties.IMPORTED_PER_EVENT),
        }),
      );
    }
    await withSystem('perf.import-fanout', (tx) => emit(tx, imported));
    await dispatcher.start();
    // The search subscription queued every listing's rebuild; the build job's body drains them.
    await waitFor(
      async () => {
        const { rows } = await withSystem('perf.import-fanout', (tx) =>
          tx.execute(sql`select count(*)::int as n from read_model_queue where owner_agency_id = ${owner.agencyId}`),
        );
        return Number((rows[0] as { n: number }).n) >= LISTINGS;
      },
      120_000,
      200,
    );
    const buildStarted = performance.now();
    // A target is due `READ_MODEL_DEBOUNCE_MS` after it was queued: the run waits for the tail of the burst, and
    // asks again for any left (the job re-requests itself the same way).
    const queued = async () =>
      Number(
        (
          (
            await withSystem('perf.import-fanout', (tx) =>
              tx.execute(
                sql`select count(*)::int as n from read_model_queue where owner_agency_id = ${owner.agencyId}`,
              ),
            )
          ).rows[0] as { n: number }
        ).n,
      );
    let runs = 0;
    while ((await queued()) > 0 && runs++ < 10) {
      await search.drainReadModelQueue(owner.agencyId, {
        recheckMs: 60_000,
        maxRechecks: 0,
        leaseMs: 120_000,
        budgetMs: 600_000,
        waitMs: search.READ_MODEL_DEBOUNCE_MS + 1_000,
      });
    }
    expect(await queued()).toBe(0);
    const buildMs = performance.now() - buildStarted;
    const [models] = (
      await withSystem('perf.import-fanout', (tx) =>
        tx.execute(sql`select count(*)::int as n from listing_read_models where agency_id = ${owner.agencyId}`),
      )
    ).rows as { n: number }[];
    expect(models?.n).toBe(LISTINGS);
    const lastEmit = performance.now();
    await waitFor(
      async () => {
        const { rows } = await withSystem('perf.import-fanout', (tx) =>
          tx.execute(
            sql`select count(*)::int as n from outbox_events where agency_id = ${owner.agencyId} and processed_at is null and dead_at is null`,
          ),
        );
        return Number((rows[0] as { n: number }).n) === 0;
      },
      LAG_BUDGET_MS * 3,
      100,
    );
    const drainMs = performance.now() - lastEmit;
    const { rows } = await withSystem('perf.import-fanout', (tx) =>
      tx.execute(sql`
        select type, count(*)::int as events,
               coalesce(extract(epoch from percentile_cont(0.95) within group (order by processed_at - created_at)) * 1000, 0)::int as lag_p95_ms,
               coalesce(extract(epoch from max(processed_at - created_at)) * 1000, 0)::int as lag_max_ms,
               count(*) filter (where dead_at is not null)::int as dead
          from outbox_events where agency_id = ${owner.agencyId} group by type order by type`),
    );
    const byType = rows as { type: string; events: number; lag_p95_ms: number; lag_max_ms: number; dead: number }[];
    const total = byType.reduce((n, r) => n + r.events, 0);
    const per100 = (total / LISTINGS) * 100;
    const searchEvents = byType.filter((r) => r.type.startsWith('search.')).reduce((n, r) => n + r.events, 0);
    process.stdout.write(
      `[S13-F10] ${LISTINGS} listings: build ${Math.round(buildMs)} ms, last backlog drained in ${Math.round(drainMs)} ms; ` +
        `${total} events (${per100.toFixed(2)} per 100; search.* ${((searchEvents / LISTINGS) * 100).toFixed(2)} per 100); ` +
        `${JSON.stringify(byType)}\n`,
    );
    expect(byType.reduce((n, r) => n + r.dead, 0)).toBe(0);
    expect(searchEvents / (LISTINGS / 100)).toBeLessThanOrEqual(EVENTS_PER_100);
    expect((total - searchEvents) / (LISTINGS / 100)).toBeLessThanOrEqual(IMPORTED_PER_100);
    expect(drainMs).toBeLessThan(LAG_BUDGET_MS);
  } finally {
    await dispatcher.stop();
  }
}, 900_000);
