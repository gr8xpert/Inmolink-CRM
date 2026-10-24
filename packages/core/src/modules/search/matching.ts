import { createLogger, type Logger } from '@inmolink/platform/logger';
import { type Filter, type SearchEngine, searchEngine } from '@inmolink/platform/search';
import { metrics } from '@opentelemetry/api';
import { type AttributeQuery, attributeFilters, othersInNetwork } from './filters';
import { listingsIndex } from './index-doc';
import { listingsIndexUid } from './indexer';

/**
 * Listing matching for workers (S11-05, the network board's buyer requests): which agencies own ACTIVE listings that
 * match a set of attributes, how many each, and a sample of their ids — over the search engine, never a join over raw
 * tables (CLAUDE.md rule 9). Every indexed listing counts, whatever its sharing: the answer goes to each owner about
 * its own listings, never to the asker. Listings without an index document (PRIVATE ones) are not matched.
 *
 * The engine counts at most `maxValuesPerFacet` owners per query, so the owners are read in rounds: each round asks
 * for the owners not found yet (a facet: exact counts, the most matching first), then the newest `MATCH_SAMPLE`
 * matching ids of that round's owners and those ids' owners — three engine calls a round, until a round finds fewer
 * owners than the facet's cap. `MATCH_MAX_ROUNDS` bounds a request matching nearly the whole network: the rest is left
 * out, counted on `inmolink.network.match_truncated` and logged. An owner whose matches all fall outside its round's
 * sample is still counted, with no ids.
 */

/** Matching ids read per round (the newest first). */
export const MATCH_SAMPLE = 1_000;
/** Longest wait for each engine call: the job fails and retries rather than hanging. */
export const MATCH_ENGINE_TIMEOUT_MS = 5_000;
/** Rounds of owners per request: 50 × 200 = 10,000 agencies (twice PLAN §1's 5,000). */
export const MATCH_MAX_ROUNDS = 50;

const truncations = metrics.getMeter('@inmolink/core').createCounter('inmolink.network.match_truncated', {
  description: 'Buyer requests whose matching owners exceeded MATCH_MAX_ROUNDS rounds (the rest were not notified)',
});

let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'search' });
  return log;
};

export interface OwnerMatch {
  agencyId: string;
  /** Matching listings of the agency (the engine's count). */
  count: number;
  /** Up to `perAgency` of them, newest first. */
  listingIds: string[];
}

export interface OwnerMatches {
  owners: OwnerMatch[];
  /** More owners matched than `MATCH_MAX_ROUNDS` rounds read. */
  truncated: boolean;
}

export async function matchListingOwners(
  query: Omit<AttributeQuery, 'kind' | 'developmentId' | 'geoBox'>,
  options: { excludeAgencyId: string; perAgency: number; engine?: SearchEngine; maxRounds?: number },
): Promise<OwnerMatches> {
  const engine = options.engine ?? searchEngine();
  const uid = listingsIndexUid();
  const def = listingsIndex(uid);
  const base: Filter[] = [
    ...attributeFilters({ ...query, kind: 'LISTING' }),
    { op: 'eq', field: 'status', value: 'ACTIVE' },
    // not the asker's own, nor listings hidden from the network for freshness (stale data)
    ...othersInNetwork(options.excludeAgencyId),
  ];
  const found = new Map<string, OwnerMatch>();
  const maxRounds = options.maxRounds ?? MATCH_MAX_ROUNDS;
  for (let round = 0; ; round++) {
    const notYet: Filter[] =
      found.size === 0 ? [] : [{ op: 'not', filter: { op: 'in', field: 'ownerAgencyId', values: [...found.keys()] } }];
    const facet = await engine.search(def, {
      filter: { op: 'and', filters: [...base, ...notYet] },
      facets: ['ownerAgencyId'],
      limit: 0,
      timeoutMs: MATCH_ENGINE_TIMEOUT_MS,
    });
    const counts = Object.entries(facet.facets.ownerAgencyId ?? {}).filter(
      ([agencyId, count]) => agencyId !== options.excludeAgencyId && count > 0 && !found.has(agencyId),
    );
    if (counts.length === 0) return { owners: sorted(found), truncated: false };
    if (round >= maxRounds) {
      truncations.add(1);
      logger().warn({ owners: found.size, rounds: round }, 'network matching: owners beyond the round limit left out');
      return { owners: sorted(found), truncated: true };
    }
    const agencyIds = counts.map(([agencyId]) => agencyId);
    for (const [agencyId, count] of counts) found.set(agencyId, { agencyId, count, listingIds: [] });
    const sample = await engine.search(def, {
      filter: { op: 'and', filters: [...base, { op: 'in', field: 'ownerAgencyId', values: agencyIds }] },
      sort: [{ field: 'publishedAt', dir: 'desc' }],
      limit: MATCH_SAMPLE,
      timeoutMs: MATCH_ENGINE_TIMEOUT_MS,
    });
    if (sample.ids.length > 0) {
      const owners = await engine.fetch(uid, sample.ids, ['id', 'ownerAgencyId']);
      const ownerOf = new Map(owners.map((d) => [String(d.id), String(d.ownerAgencyId)]));
      // the engine's order (newest first) within each agency
      for (const id of sample.ids) {
        const match = found.get(ownerOf.get(id) ?? '');
        if (match && match.listingIds.length < options.perAgency) match.listingIds.push(id);
      }
    }
    // the facet listed every remaining owner: nothing is left for another round
    if (Object.keys(facet.facets.ownerAgencyId ?? {}).length < def.maxValuesPerFacet) {
      return { owners: sorted(found), truncated: false };
    }
  }
}

const sorted = (found: Map<string, OwnerMatch>) =>
  [...found.values()].sort((a, b) => (a.agencyId < b.agencyId ? -1 : a.agencyId > b.agencyId ? 1 : 0));
