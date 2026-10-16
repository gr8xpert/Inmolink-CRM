import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import { SEEDED_AT } from './identity';
import { PER_AGENCY } from './profile';
import { createRng, seededId } from './rng';
import type { Seeder } from './seeders';
import { cityOfArea, regionOfCity, seededLocationId, seededTypeId, taxonomySize } from './taxonomy';

/**
 * Listings for the scale seed (S3-F6): PLAN §4.1's 150 own listings per agency, and **5,000 for agency 0** — the
 * agency the list and bulk budgets are measured on (S3-07). Each sits in a seeded city or area with its country,
 * region and city (S3-F6), owned by one of the agency's seeded users; a mix of statuses, visibilities, prices and sizes.
 * COPY per chunk of agencies, deterministic per seed, idempotent.
 */

/** Listings of agency `a`. */
export const listingsOf = (a: number) => (a === 0 ? 5_000 : PER_AGENCY.ownListings);
export const seededListingId = (seed: number, a: number, i: number) => seededId(seed, `properties.listings:${a}`, i);

const COLUMNS = [
  'id',
  'agency_id',
  'owner_user_id',
  'ref',
  'status',
  'visibility',
  'transaction_type',
  'price_cents',
  'bedrooms',
  'bathrooms',
  'built_m2',
  'energy_rating',
  'property_type_id',
  'location_id',
  'country_id',
  'region_id',
  'city_id',
  'created_at',
  'updated_at',
] as const;

const STATUSES = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'DRAFT', 'DRAFT', 'SOLD'];
const VISIBILITIES = [
  'PRIVATE',
  'PRIVATE',
  'PRIVATE',
  'PRIVATE',
  'PRIVATE',
  'PRIVATE',
  'SHARED',
  'SHARED',
  'SHARED',
  'PUBLIC',
];
const RATINGS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

export const listingsSeeder: Seeder = {
  name: 'properties.listings',

  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies: count, seed, chunk, onProgress }) {
    const { cities, areas } = taxonomySize(count);
    const country = seededLocationId(seed, 'country', 0);
    const write = async (start: number, end: number) => {
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        const rng = createRng(seed, `properties.listings:${a}`);
        const agencyId = seededId(seed, 'agencies', a);
        for (let i = 0; i < listingsOf(a); i++) {
          // Four in five in an area, the rest in a city.
          const inArea = rng.next() < 0.8;
          const area = rng.int(0, areas - 1);
          const city = inArea ? cityOfArea(area, cities) : rng.int(0, cities - 1);
          const region = seededLocationId(seed, 'region', regionOfCity(city));
          const cityId = seededLocationId(seed, 'city', city);
          const location = inArea ? seededLocationId(seed, 'area', area) : cityId;
          const rent = rng.next() < 0.15;
          const day = 86_400_000;
          const at = new Date(SEEDED_AT.getTime() - ((listingsOf(a) - i) * day) / 10);
          rows.push([
            seededListingId(seed, a, i),
            agencyId,
            seededId(seed, `identity.users:${a}`, rng.int(0, PER_AGENCY.users - 1)),
            `SD${String(i).padStart(6, '0')}`,
            rng.pick(STATUSES),
            rng.pick(VISIBILITIES),
            rent ? 'RENT_LONG_TERM' : 'SALE',
            rng.next() < 0.05 ? null : rent ? rng.int(60, 400) * 1_000_00 : rng.int(80, 3_000) * 1_000_00 * 10,
            rng.int(0, 6),
            rng.int(1, 5),
            String(rng.int(35, 600)),
            rng.pick(RATINGS),
            seededTypeId(seed, rng.int(0, 7)),
            location,
            country,
            region,
            cityId,
            at,
            at,
          ]);
        }
      }
      return withSystemClient('seed.properties.listings', (client) => copyNewRows(client, 'properties', COLUMNS, rows));
    };
    // About 150 rows per agency: `--chunk` agencies or more per transaction (agency 0 alone is 5,000).
    const inserted = await forEachChunk(count, agenciesPerChunk(chunk, PER_AGENCY.ownListings), write, onProgress);
    const ids = Array.from({ length: count }, (_, a) => seededId(seed, 'agencies', a));
    const r = await withSystem('seed.properties.count', (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from properties where agency_id = any(${pgArray(ids)}::uuid[]) and ref like 'SD%'`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};
