import * as media from '@inmolink/core/modules/media';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * Full read-model rebuild at scale (S5-01 acceptance): 200,000 SHARED, ACTIVE listings of 40 agencies with three
 * content locales each (en, es, de), three translations, two features and two processed photos per listing — the
 * listing count of the 1,000-agency scale seed — rebuilt by `pnpm ops:rebuild-read-models`' own runner
 * (`search.rebuildAllReadModels`, its default batch and concurrency) in < 30 min, 600,000 documents. In the `perf`
 * project: it runs alone, and it deletes its rows again (the shared test database keeps every run's rows).
 */

const RUN = newId().slice(-8);
const log = createLogger({ service: 'perf', level: 'info' });
const code = (s: string) => `${s}-${RUN}`;
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: code(slug) }];
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.read-model-rebuild', fn);
const rows = <T>(q: ReturnType<typeof sql>) =>
  system(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    return (await tx.execute(q)).rows as T[];
  });

/** A Postgres array literal of text values (a JS array parameter would expand to a tuple). */
const arr = (xs: readonly string[]) =>
  sql`array[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`;

const AGENCIES = 40;
const PER_AGENCY = 5_000;
const LOCALES = ['en', 'es', 'de'];
const BUDGET_MS = 30 * 60_000;
/** Refs of this file's listings (unique per agency): an earlier crashed run's rows are found by them. */
const REF = /^RM[0-9]{5}$/;

let agencies: Founder[] = [];
let ids: { location: string; type: string; features: string[] };
const photos = Array.from({ length: 2 }, (_, i) => `${RUN}${i}`.padEnd(64, 'c'));

async function cleanup(): Promise<void> {
  // The rebuild queues every target's index push (S5-03); nothing syncs them here.
  await rows(
    sql`delete from search_index_queue where target_id in (select id from properties where ref ~ ${REF.source})`,
  );
  await rows(sql`delete from listing_read_models where agency_id in
    (select distinct agency_id from properties where ref ~ ${REF.source})`);
  await rows(sql`delete from properties where ref ~ ${REF.source}`);
}

beforeAll(async () => {
  await setupTestDb('worker');
  media.configureMedia({ urlKey: `perf-read-model-key-${RUN}-0123456789abcdef` });
  await cleanup();
  agencies = await Promise.all(Array.from({ length: AGENCIES }, () => createFounder()));
  const agencyIds = agencies.map((a) => a.agencyId);
  await rows(sql`update agency_settings set enabled_locales = ${`{${LOCALES.join(',')}}`}::text[]
    where agency_id in ${agencyIds}`);
  ids = await system(async (tx) => {
    const location = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('perf-rm'),
      translations: tr(`Rebuildland ${RUN}`, 'rebuildland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('perf-rm-houses'),
      sort: 0,
      translations: tr(`Houses ${RUN}`, 'perf-rm-houses'),
    });
    const type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('perf-rm-villa'),
      sort: 0,
      translations: tr(`Villa ${RUN}`, 'perf-rm-villa'),
    });
    const featureGroup = await taxonomy.createFeatureGroup(tx, {
      key: code('perf-rm-fg'),
      sort: 0,
      translations: tr(`Outdoor ${RUN}`, 'perf-rm-fg'),
    });
    const features = [];
    for (const f of ['pool', 'garden']) {
      features.push(
        await taxonomy.createFeature(tx, {
          groupId: featureGroup,
          key: code(`perf-rm-${f}`),
          sort: 0,
          icon: f,
          translations: tr(`${f} ${RUN}`, `perf-rm-${f}`),
        }),
      );
    }
    return { location, type, features };
  });
  await rows(sql`insert into media_objects (sha256, size_bytes, content_type, pipeline, variants_ready, width, height)
    select p, 100000, 'image/jpeg', 1, 31, 1600, 1200 from unnest(${arr(photos)}) p on conflict do nothing`);
  const started = Date.now();
  for (const f of agencies) {
    await rows(sql`
      with l as (
        insert into properties (id, agency_id, owner_user_id, ref, status, visibility, transaction_type, price_cents,
                                bedrooms, bathrooms, built_m2, energy_rating, lat, lng, property_type_id, location_id,
                                country_id)
        select gen_random_uuid(), ${f.agencyId}, ${f.userId}, 'RM' || lpad(i::text, 5, '0'), 'ACTIVE',
               'SHARED', 'SALE', 10000000 + i::bigint * 100000, i % 6, i % 4, 80 + i % 300, 'C',
               36.5 + (i % 1000) / 10000.0, -4.9 + (i % 1000) / 10000.0, ${ids.type}, ${ids.location}, ${ids.location}
          from generate_series(1, ${PER_AGENCY}) as i
        returning id, agency_id
      ),
      t as (
        insert into property_translations (property_id, agency_id, locale, title, description, slug)
        select l.id, l.agency_id, loc, 'Villa with sea views ' || loc,
               repeat('A bright villa with a pool and a garden, close to the beach. ', 20), 'villa-' || replace(l.id::text, '-', '')
          from l cross join unnest(${arr(LOCALES)}) loc
        returning 1
      ),
      ft as (
        insert into property_features (property_id, agency_id, feature_id)
        select l.id, l.agency_id, f from l cross join unnest(${arr(ids.features)}::uuid[]) f
        returning 1
      )
      insert into property_media (id, property_id, agency_id, sha256, kind, position, is_cover)
      select gen_random_uuid(), l.id, l.agency_id, p.sha, 'IMAGE', p.n - 1, p.n = 1
        from l cross join unnest(${arr(photos)}) with ordinality as p(sha, n)`);
  }
  log.info({ listings: AGENCIES * PER_AGENCY, seconds: Math.round((Date.now() - started) / 1000) }, 'seeded');
  await rows(sql`analyze properties, property_translations, property_features, property_media`);
}, 1_800_000);

afterAll(async () => {
  await cleanup();
  await rows(sql`delete from media_objects where sha256 = any(${arr(photos)})`);
  await closeDb();
}, 600_000);

it(
  '[S5-01] Rebuild of 200k listings × 3 locales completes in < 30 min locally',
  async () => {
    const started = Date.now();
    let lastLog = 0;
    const result = await search.rebuildAllReadModels({
      kinds: ['LISTING'],
      concurrency: 4,
      reason: 'perf.read-model-rebuild',
      onProgress: (p) => {
        if (Date.now() - lastLog < 30_000) return;
        lastLog = Date.now();
        log.info({ done: p.done, perSecond: Math.round(p.done / (p.elapsedMs / 1000)) }, 'rebuild progress');
      },
    });
    const ms = Date.now() - started;
    const [count] = await rows<{ n: string }>(sql`select count(*) as n from listing_read_models
      where agency_id in ${agencies.map((a) => a.agencyId)}`);
    log.info(
      { ms, minutes: +(ms / 60_000).toFixed(1), perSecond: Math.round(result.LISTING.done / (ms / 1000)), result },
      'read-model rebuild (200k listings × 3 locales)',
    );
    expect(Number(count?.n)).toBe(AGENCIES * PER_AGENCY * LOCALES.length);
    expect(ms).toBeLessThan(BUDGET_MS);
  },
  BUDGET_MS + 600_000,
);
