import { FeedListing, type FeedListingInput } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as taxonomy from '../../taxonomy';
import { type Parsed, RunResolver, resolveTaxonomy } from '../load';

/**
 * S7-F10: the loader's taxonomy resolution at run scale — a 20k-listing run in the loader's 500-item batches over a
 * tree of 20 cities with 10 areas each. A location level is one statement per batch whatever its parents, and a value
 * that matches nothing is resolved and queued for staff once per run (its later sightings counted at the run's end).
 */

const RUN = newId().slice(-8).toLowerCase();
const CITIES = 20;
const AREAS_PER_CITY = 10;
const LISTINGS = 20_000;
const BATCH = 500;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('imports.resolver-batching.test', fn);
const tr = (name: string, slug: string) => [{ locale: 'en', name, slug: `${slug}-${RUN}` }];

const names = {
  country: `Batchland ${RUN}`,
  region: `Costa Lote ${RUN}`,
  city: (c: number) => `Villa Lote ${c} ${RUN}`,
  area: (c: number, a: number) => `Barrio ${c}-${a} ${RUN}`,
  type: `Batch Villa ${RUN}`,
  /** A spelling no location has, under every city (1 listing in 50). */
  nowhere: `Qzx Nowhere ${RUN}`,
};
const ids = { country: '', region: '', cities: [] as string[], areas: [] as string[][], type: '' };

/** Listing i: city i % 20, one of its areas; every 50th names an area that does not exist. */
function parsed(i: number): Parsed {
  const c = i % CITIES;
  const a = Math.floor(i / CITIES) % AREAS_PER_CITY;
  const input: FeedListingInput = {
    ref: `RB-${i}`,
    transactionType: 'SALE',
    priceCents: 350_000_00,
    propertyType: names.type,
    location: {
      country: names.country,
      region: names.region,
      city: names.city(c),
      area: i % 50 === 7 ? names.nowhere : names.area(c, a),
    },
    features: [],
    translations: [{ locale: 'en', title: `Villa ${i}`, description: 'Batch.' }],
  };
  return { position: i, listing: FeedListing.parse(input) };
}

const ITEMS = Array.from({ length: LISTINGS }, (_, i) => parsed(i));
const batches = Array.from({ length: LISTINGS / BATCH }, (_, b) => ITEMS.slice(b * BATCH, (b + 1) * BATCH));
/** Statements reading the location names and aliases (exact or fuzzy matches; the queue write names them too). */
const LOCATION_MATCH = /^\s*select\b[\s\S]*\blocation_(aliases|translations)\b/;
const QUEUE_WRITE = /insert into "taxonomy_unmatched"/;

async function queuedCount(): Promise<number | null> {
  const res = await system((tx) =>
    tx.execute<{ count: number }>(
      sql`select count from taxonomy_unmatched where kind = 'location' and value_key = ${taxonomy.aliasKey(names.nowhere)}`,
    ),
  );
  return res.rows[0]?.count ?? null;
}

beforeAll(async () => {
  await setupTestDb('worker');
  await system(async (tx) => {
    ids.country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `rb-c-${RUN}`,
      translations: tr(names.country, 'batchland'),
    });
    ids.region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: ids.country,
      code: `rb-r-${RUN}`,
      translations: tr(names.region, 'costa-lote'),
    });
    for (let c = 0; c < CITIES; c++) {
      const city = await taxonomy.createLocation(tx, {
        level: 'CITY',
        parentId: ids.region,
        code: `rb-ci${c}-${RUN}`,
        translations: tr(names.city(c), `villa-lote-${c}`),
      });
      ids.cities.push(city);
      const areas: string[] = [];
      for (let a = 0; a < AREAS_PER_CITY; a++) {
        areas.push(
          await taxonomy.createLocation(tx, {
            level: 'AREA',
            parentId: city,
            code: `rb-a${c}-${a}-${RUN}`,
            translations: tr(names.area(c, a), `barrio-${c}-${a}`),
          }),
        );
      }
      ids.areas.push(areas);
    }
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `rb-houses-${RUN}`,
      sort: 0,
      translations: tr(`Batch Houses ${RUN}`, 'batch-houses'),
    });
    ids.type = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `rb-villa-${RUN}`,
      sort: 0,
      translations: tr(names.type, 'batch-villa'),
    });
  });
}, 300_000);

afterAll(closeDb);

describe('import taxonomy resolution at run scale (S7-F10)', () => {
  it('[S7-F10] a 20k-listing run resolves each location level in one statement per batch, and queues an unmatched value once per run', async () => {
    const resolver = new RunResolver();
    const perBatch: { locations: number; queued: number }[] = [];
    for (const [b, batch] of batches.entries()) {
      let resolved: Awaited<ReturnType<typeof resolveTaxonomy>> = [];
      let queued = 0;
      const locations = await countQueries(
        async () => {
          queued = await countQueries(
            async () => {
              resolved = await system((tx) => resolveTaxonomy(tx, resolver, batch));
              resolver.commit(); // as the loader does once the batch's transaction committed
            },
            { match: QUEUE_WRITE },
          );
        },
        { match: LOCATION_MATCH },
      );
      perBatch.push({ locations, queued });
      // Resolved under the right parents: the city's own area, or held at the city for the unknown one.
      batch.forEach((p, j) => {
        const i = p.position;
        const r = resolved[j];
        const c = i % CITIES;
        if (i % 50 === 7) {
          expect(r, `listing ${i}`).toMatchObject({ locationId: ids.cities[c], held: ['location'] });
        } else {
          const a = Math.floor(i / CITIES) % AREAS_PER_CITY;
          expect(r?.locationId, `listing ${i}`).toBe(ids.areas[c]?.[a]);
          expect(r?.propertyTypeId).toBe(ids.type);
        }
      });
      if (b === 0) expect(await queuedCount()).toBe(BATCH / 50); // queued with the first batch's sightings
    }
    // The first batch: one exact statement per level (4) — 20 cities and 200 areas under them, not one per parent — and
    // one fuzzy statement for the unknown area under its 20 cities; one queue write. Later batches: all known.
    expect(perBatch[0]).toEqual({ locations: 5, queued: 1 });
    expect(perBatch.slice(1).every((s) => s.locations === 0 && s.queued === 0)).toBe(true);
    // The run's end counts the later sightings in one statement: every listing that named it, once.
    const flushed = await countQueries(() => system((tx) => resolver.flush(tx)), { match: QUEUE_WRITE });
    expect(flushed).toBe(1);
    expect(await queuedCount()).toBe(LISTINGS / 50);
    expect(await countQueries(() => system((tx) => resolver.flush(tx)), { match: QUEUE_WRITE })).toBe(0);
  }, 300_000);

  it('[S7-F10] a batch whose transaction rolls back is queued again by the next one', async () => {
    const resolver = new RunResolver();
    await expect(
      system(async (tx) => {
        await resolveTaxonomy(tx, resolver, batches[0] as Parsed[]);
        throw new Error('the batch transaction failed');
      }),
    ).rejects.toThrow('the batch transaction failed');
    resolver.rollback(); // as the loader does when the transaction failed
    const queued = await countQueries(
      async () => {
        await system((tx) => resolveTaxonomy(tx, resolver, batches[1] as Parsed[]));
        resolver.commit();
      },
      { match: QUEUE_WRITE },
    );
    expect(queued).toBe(1);
    // …and once committed, not again.
    const again = await countQueries(() => system((tx) => resolveTaxonomy(tx, resolver, batches[2] as Parsed[])), {
      match: QUEUE_WRITE,
    });
    expect(again).toBe(0);
  }, 300_000);

  it('[S7-F10] every batch with new values: one statement per location level, whatever the number of parents', async () => {
    // A resolver per batch (nothing remembered): each batch asks every level again.
    for (const batch of batches.slice(0, 5)) {
      const statements = await countQueries(() => system((tx) => resolveTaxonomy(tx, new RunResolver(), batch)), {
        match: LOCATION_MATCH,
      });
      // country, region, city, area exact + the unknown area's fuzzy statement (20 parents at once)
      expect(statements).toBe(5);
    }
  }, 300_000);
});
