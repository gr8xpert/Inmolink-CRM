import { withSystem, withSystemClient } from '@inmolink/db';
import { sql } from 'drizzle-orm';
import { IMPORT_STORM, multiFeedTenants } from '../perf/lib/storm';
import { scaleAgencyKindStatus } from './agencies';
import { agenciesPerChunk, type CopyValue, copyNewRows, forEachChunk } from './copy';
import { SEEDED_AT } from './identity';
import { PER_AGENCY } from './profile';
import { seededId } from './rng';
import type { Seeder } from './seeders';

/**
 * Feed connections for the scale seed (S16-F4, PLAN §15 "5,000 feed connections"): every agency has a Kyero
 * connection, pointing at `<feedBaseUrl>/s<seed>/a<agency>.xml` — a host given at seed time (`--feed-base-url`), by
 * default a reserved `.invalid` one that never resolves. The import storm's multi-feed tenants have more
 * (`feedConnectionsOf`): the first 7 VERIFIED agencies 8, the next 25 VERIFIED ones 2 (`multiFeedTenants` of the
 * acceptance storm's 500 feeds), so the storm provisions none — 5,074 connections over the 5,000 agencies.
 * **Off** (`enabled = false`, no `next_run_at`, manual only): the scheduler never picks one up, so a seeded stack
 * fetches nothing. The import storm (`pnpm perf:storm import`) turns the ones it needs on for its run, points them at
 * its fixture feeds and turns them off again with their seeded URL (`scripts/perf/storm.ts`). Not `paused_at`: that is
 * the anomaly guard's state, with a reason and a staff queue of its own.
 */

/** Never resolves (RFC 2606): a seeded connection turned on by mistake fails its fetch, it reaches no one. */
export const DEFAULT_FEED_BASE_URL = 'https://load-feeds.invalid';
/** The seeded connections' name: how the import storm finds them. */
export const SEEDED_FEED_NAME = 'Seeded feed (S16-F4)';
export const seededFeedConnectionId = (seed: number, a: number, i = 0) =>
  seededId(seed, `imports.feed_connections:${a}`, i);

/** The seeded URL of agency `a`'s connection `i` (its first: `a<agency>.xml`). */
export function seededFeedUrl(base: string, seed: number, a: number, i = 0): string {
  return `${base.replace(/\/+$/, '')}/s${seed}/a${a}${i === 0 ? '' : `-${i}`}.xml`;
}

/**
 * Connections of each of agencies `[0, count)`: `PER_AGENCY.feedConnections` (1), and for the acceptance import
 * storm's multi-feed tenants 8 (the first `eight` VERIFIED agencies) or 2 (the next `two`). Deterministic per seed.
 */
export function feedConnectionsOf(seed: number, count: number): number[] {
  const { eight, two } = multiFeedTenants(IMPORT_STORM.feeds);
  let verified = 0;
  return Array.from({ length: count }, (_, a) => {
    if (scaleAgencyKindStatus(seed, a).status !== 'VERIFIED' || verified >= eight + two) {
      return PER_AGENCY.feedConnections;
    }
    return verified++ < eight ? 8 : 2;
  });
}

const COLUMNS = ['id', 'agency_id', 'name', 'connector', 'url', 'enabled', 'created_at', 'updated_at'] as const;

const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

export const feedConnectionsSeeder: Seeder = {
  name: 'imports.feed_connections',

  async dev() {
    return { inserted: 0, total: 0 };
  },

  async scale({ agencies: count, seed, chunk, feedBaseUrl = DEFAULT_FEED_BASE_URL, onProgress }) {
    if (!/^https?:\/\/[^/\s]+/.test(feedBaseUrl)) throw new TypeError('feedBaseUrl must be an http(s) origin');
    const per = feedConnectionsOf(seed, count);
    const write = async (start: number, end: number) => {
      const rows: CopyValue[][] = [];
      for (let a = start; a < end; a++) {
        for (let i = 0; i < (per[a] ?? 1); i++) {
          rows.push([
            seededFeedConnectionId(seed, a, i),
            seededId(seed, 'agencies', a),
            SEEDED_FEED_NAME,
            'kyero',
            seededFeedUrl(feedBaseUrl, seed, a, i),
            false,
            SEEDED_AT,
            SEEDED_AT,
          ]);
        }
      }
      return withSystemClient('seed.imports.feed_connections', (client) =>
        copyNewRows(client, 'feed_connections', COLUMNS, rows),
      );
    };
    const inserted = await forEachChunk(count, agenciesPerChunk(chunk, PER_AGENCY.feedConnections), write, onProgress);
    const ids = per.flatMap((n, a) => Array.from({ length: n }, (_, i) => seededFeedConnectionId(seed, a, i)));
    const r = await withSystem('seed.imports.feed_connections.count', (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from feed_connections where id = any(${pgArray(ids)}::uuid[])`,
      ),
    );
    return { inserted, total: r.rows[0]?.n ?? 0 };
  },
};
