import * as matching from '@inmolink/core/modules/matching';
import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { scaleAgencyKindStatus } from './agencies';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import { SEEDED_AT, scaleUserProfiles } from './identity';
import { PER_AGENCY } from './profile';
import { createRng, seededId } from './rng';
import type { Seeder } from './seeders';
import { seededLocationId, taxonomySize } from './taxonomy';

/**
 * Client profiles for the scale seed (S16-F4, PLAN §4.1 "200 active client profiles" per agency, §15 1M): an agent's
 * saved search for a client, 40 per member. Shaped like the matching storm's profiles were: 30 % own stock, 50 %
 * network, 20 % both; mostly sales; one or two seeded places (city or area) for most; a budget and a bedroom minimum
 * for many. **DAILY**: matching records their alerts for the digest, no instant notification fires for synthetic
 * users. Keys from `matching.searchKeys` — the service's own — with the network open for a VERIFIED agency (the
 * agencies seeder's status; the matching worker re-keys an agency when that changes). COPY per chunk, deterministic.
 */

export const seededSavedSearchId = (seed: number, a: number, i: number) =>
  seededId(seed, `matching.saved_searches:${a}`, i);
/** The seeded profiles' frequency: alerts go into the daily digest; none is instant. */
export const SEEDED_PROFILE_FREQUENCY = 'DAILY';

const COLUMNS = [
  'id',
  'agency_id',
  'user_id',
  'name',
  'scope',
  'frequency',
  'transaction_type',
  'location_ids',
  'price_min_cents',
  'price_max_cents',
  'beds_min',
  'match_keys',
  'created_at',
  'updated_at',
] as const;

const pgArray = (ids: readonly string[]) => `{${ids.join(',')}}`;
const HOUR = 3_600_000;

export const savedSearchesSeeder: Seeder = {
  name: 'matching.saved_searches',

  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies: count, seed, chunk, onProgress }) {
    const { cities, areas } = taxonomySize(count);
    const write = async (start: number, end: number) => {
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        const rng = createRng(seed, `matching.saved_searches:${a}`);
        const agencyId = seededId(seed, 'agencies', a);
        const networkOpen = scaleAgencyKindStatus(seed, a).status === 'VERIFIED';
        const people = scaleUserProfiles(seed, a);
        for (let i = 0; i < PER_AGENCY.clientProfiles; i++) {
          const u = i % PER_AGENCY.users;
          const r = rng.next();
          const scope = r < 0.3 ? 'OWN' : r < 0.8 ? 'NETWORK' : 'ALL';
          const t = rng.next();
          const transactionType = t < 0.75 ? 'SALE' : t < 0.9 ? 'RENT_LONG_TERM' : null;
          const places = scope !== 'OWN' || rng.next() < 0.4 ? (rng.next() < 0.8 ? 1 : 2) : 0;
          const locationIds = [
            ...new Set(
              Array.from({ length: places }, () =>
                rng.next() < 0.6
                  ? seededLocationId(seed, 'area', rng.int(0, areas - 1))
                  : seededLocationId(seed, 'city', rng.int(0, cities - 1)),
              ),
            ),
          ];
          const rent = transactionType === 'RENT_LONG_TERM';
          const max = rng.next() < 0.7 ? (rent ? rng.int(8, 40) * 100_00 : rng.int(15, 200) * 10_000_00) : null;
          const min = max !== null && rng.next() < 0.3 ? Math.floor(max / 2) : null;
          const at = new Date(SEEDED_AT.getTime() - (PER_AGENCY.clientProfiles - i) * 6 * HOUR);
          const client = people[(i * 7) % people.length]?.name.split(' ').slice(1).join(' ') || 'Client';
          rows.push([
            seededSavedSearchId(seed, a, i),
            agencyId,
            seededId(seed, `identity.users:${a}`, u),
            `${client} family #${i + 1}`,
            scope,
            SEEDED_PROFILE_FREQUENCY,
            transactionType,
            pgArray(locationIds),
            min,
            max,
            rng.next() < 0.5 ? rng.int(1, 4) : null,
            pgArray(matching.searchKeys({ agencyId, scope, transactionType, locationIds }, networkOpen)),
            at,
            at,
          ]);
        }
      }
      return withSystemClient('seed.matching.saved_searches', (client) =>
        copyNewRows(client, 'saved_searches', COLUMNS, rows),
      );
    };
    const inserted = await forEachChunk(count, agenciesPerChunk(chunk, PER_AGENCY.clientProfiles), write, onProgress);
    const agencyIds = Array.from({ length: count }, (_, a) => seededId(seed, 'agencies', a));
    // the members' list index (agency_id, user_id, created_at, id) leads with the agency: no scan of every profile
    const r = await withSystem('seed.matching.saved_searches.count', (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from saved_searches
             where agency_id = any(${pgArray(agencyIds)}::uuid[]) and name like '% family #%'`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};
