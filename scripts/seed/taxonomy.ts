import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { type CopyValue, copyNewRows } from './copy';
import { SEEDED_AT } from './identity';
import { seededId } from './rng';
import type { Seeder } from './seeders';

/**
 * Taxonomy for the scale seed (S3-F6): a synthetic Spain-sized tree — 1 country, 20 regions, 2,000 cities, 26,000
 * areas at `--agencies` ≥ 1,000 (fewer below, so a test seed stays small; a smaller tree is a prefix of the larger
 * one) — names in English and Spanish, and one property type group with eight types. Deterministic IDs per seed,
 * idempotent like every seeder. Listings (`listings.ts`) point at its cities and areas.
 */

const REGIONS = 20;
const TYPES = ['Apartment', 'Penthouse', 'Villa', 'Townhouse', 'Finca', 'Plot', 'Studio', 'Duplex'] as const;

/** Tree size for `agencies`: the full tree from 1,000 agencies up. */
export function taxonomySize(agencies: number): { cities: number; areas: number } {
  const cities = Math.min(2_000, Math.max(REGIONS * 2, agencies * 2));
  return { cities, areas: Math.min(26_000, cities * 13) };
}

export const seededLocationId = (seed: number, level: 'country' | 'region' | 'city' | 'area', i: number) =>
  seededId(seed, `taxonomy.locations.${level}`, i);
export const seededTypeId = (seed: number, i: number) => seededId(seed, 'taxonomy.types', i);

/** A city's region and an area's city: fixed by index, so every seed run builds the same tree. */
export const regionOfCity = (c: number) => c % REGIONS;
export const cityOfArea = (a: number, cities: number) => a % cities;

const LOCATION_COLUMNS = ['id', 'parent_id', 'level', 'depth', 'created_at', 'updated_at'] as const;
const TRANSLATION_COLUMNS = ['location_id', 'parent_id', 'locale', 'name', 'slug'] as const;
const CHUNK = 5_000;

async function copyLocations(
  level: 'COUNTRY' | 'REGION' | 'CITY' | 'AREA',
  depth: number,
  nodes: { id: string; parentId: string | null; label: string }[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < nodes.length; i += CHUNK) {
    const part = nodes.slice(i, i + CHUNK);
    inserted += await withSystemClient(`seed.taxonomy.${level.toLowerCase()}`, async (client) => {
      const n = await copyNewRows(
        client,
        'locations',
        LOCATION_COLUMNS,
        part.map((l): CopyValue[] => [l.id, l.parentId, level, depth, SEEDED_AT, SEEDED_AT]),
      );
      await copyNewRows(
        client,
        'location_translations',
        TRANSLATION_COLUMNS,
        part.flatMap((l): CopyValue[][] => [
          [l.id, l.parentId, 'en', l.label, `seed-${l.id.slice(-12)}`],
          [l.id, l.parentId, 'es', l.label, `seed-${l.id.slice(-12)}`],
        ]),
      );
      return n;
    });
  }
  return inserted;
}

export const taxonomySeeder: Seeder = {
  name: 'taxonomy.locations',

  // The dev seed's demo agencies use the S2 taxonomy fixtures; nothing synthetic here.
  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies, seed }) {
    const { cities, areas } = taxonomySize(agencies);
    const country = seededLocationId(seed, 'country', 0);
    const regionIds = Array.from({ length: REGIONS }, (_, r) => seededLocationId(seed, 'region', r));
    const cityIds = Array.from({ length: cities }, (_, c) => seededLocationId(seed, 'city', c));
    let inserted = await copyLocations('COUNTRY', 1, [{ id: country, parentId: null, label: `Seedland ${seed}` }]);
    inserted += await copyLocations(
      'REGION',
      2,
      regionIds.map((id, r) => ({ id, parentId: country, label: `Region ${r + 1}` })),
    );
    inserted += await copyLocations(
      'CITY',
      3,
      cityIds.map((id, c) => ({ id, parentId: regionIds[regionOfCity(c)] as string, label: `City ${c + 1}` })),
    );
    inserted += await copyLocations(
      'AREA',
      4,
      Array.from({ length: areas }, (_, a) => ({
        id: seededLocationId(seed, 'area', a),
        parentId: cityIds[cityOfArea(a, cities)] as string,
        label: `Area ${a + 1}`,
      })),
    );

    // One group of eight property types.
    const group = seededId(seed, 'taxonomy.typeGroups', 0);
    await withSystemClient('seed.taxonomy.types', async (client) => {
      await copyNewRows(client, 'property_type_groups', ['id', 'key', 'sort'], [[group, `seed-${seed}-homes`, 0]]);
      await copyNewRows(
        client,
        'property_type_group_translations',
        ['group_id', 'locale', 'name', 'slug'],
        [
          [group, 'en', 'Homes', `seed-${seed}-homes`],
          [group, 'es', 'Viviendas', `seed-${seed}-homes`],
        ],
      );
      const types = TYPES.map((name, t) => ({ id: seededTypeId(seed, t), name, t }));
      await copyNewRows(
        client,
        'property_types',
        ['id', 'group_id', 'key', 'sort'],
        types.map((x): CopyValue[] => [x.id, group, `seed-${seed}-${x.name.toLowerCase()}`, x.t]),
      );
      await copyNewRows(
        client,
        'property_type_translations',
        ['type_id', 'locale', 'name', 'slug'],
        types.flatMap((x): CopyValue[][] => [
          [x.id, 'en', x.name, `seed-${seed}-${x.name.toLowerCase()}`],
          [x.id, 'es', x.name, `seed-${seed}-${x.name.toLowerCase()}`],
        ]),
      );
    });

    const r = await withSystem('seed.taxonomy.count', (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from locations where id = ${country} or parent_id = ${country}
              or parent_id = any(${`{${regionIds.join(',')}}`}::uuid[]) or parent_id = any(${`{${cityIds.join(',')}}`}::uuid[])`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};

/**
 * Removes a seed's taxonomy (tests and staging resets): its listings must be gone first (they reference it).
 * Deepest level first (parents are RESTRICT), then the property types and their group.
 */
export async function removeSeededTaxonomy(seed: number): Promise<void> {
  const country = seededLocationId(seed, 'country', 0);
  await withSystem('seed.taxonomy.remove', async (tx) => {
    await tx.execute(sql`delete from properties where country_id = ${country}`);
    for (const depth of [4, 3, 2, 1]) {
      await tx.execute(sql`
        delete from locations where depth = ${depth} and id in (
          with recursive t as (
            select id from locations where id = ${country}
            union all select l.id from locations l join t on l.parent_id = t.id
          ) select id from t)`);
    }
    await tx.execute(sql`delete from property_types where key like ${`seed-${seed}-%`}`);
    await tx.execute(sql`delete from property_type_groups where key like ${`seed-${seed}-%`}`);
  });
}
