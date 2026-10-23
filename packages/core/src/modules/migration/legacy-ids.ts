/**
 * Legacy ids at runtime (S8-02, PLAN §9.3, ADR 0006): the v1 shim resolves the legacy ids legacy websites send and
 * names a page's listings by their legacy ids.
 *
 * - **Taxonomy** (location, property type, feature — the filter ids): every map read whole into this process in one
 *   statement, at first use (feed-api preloads it at boot) and again in the background every few minutes. A request
 *   never resolves a taxonomy id in SQL: an id the map lacks is unknown, at no cost, however many a caller makes up.
 * - **Listings and units**: `app_public` cannot read those maps (registry predicate); the SECURITY DEFINER lookups
 *   answer only the ids asked for. A resolved id is kept per process (a mapping never changes once the migration wrote
 *   it); unknown ids sit in a small cache of their own for a minute, so made-up ids cannot push known ones out.
 */
import { withPublicRead } from '@inmolink/db';
import { LocalLru } from '@inmolink/platform/cache';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import type { SQL } from 'drizzle-orm';
import * as repo from './repo';

export type { LegacyEntity } from './repo';

type TaxonomyEntity = (typeof repo.TAXONOMY_ENTITIES)[number];

/** Taxonomy maps of this process: `<entity>:<legacy id>` → v2 id, and v2 id → its smallest legacy id. */
export interface LegacyTaxonomy {
  newId(entity: TaxonomyEntity, legacyId: string): string | undefined;
  legacyIdOf(newId: string): string | undefined;
  readonly size: number;
}

/** Reloaded in the background when older than this (a migration batch's new taxonomy maps show up within it). */
export const LEGACY_TAXONOMY_REFRESH_MS = 5 * 60_000;
/** A guard on the whole-table read (the legacy taxonomy is a few thousand rows). */
export const LEGACY_TAXONOMY_MAX_ROWS = 200_000;

let taxonomy: (LegacyTaxonomy & { loadedAt: number }) | null = null;
let loading: Promise<LegacyTaxonomy> | null = null;
let log: Logger | undefined;
const logger = () => {
  log ??= createLogger({ service: 'migration', level: process.env.LOG_LEVEL });
  return log;
};

function loadTaxonomy(): Promise<LegacyTaxonomy> {
  loading ??= (async () => {
    const rows = await withPublicRead((tx) => repo.taxonomyMaps(tx, LEGACY_TAXONOMY_MAX_ROWS + 1));
    if (rows.length > LEGACY_TAXONOMY_MAX_ROWS) {
      logger().warn({ rows: rows.length }, 'legacy taxonomy maps exceed the in-process cap: the rest is not loaded');
    }
    const forward = new Map<string, string>();
    const reverse = new Map<string, string>();
    // Ordered by entity, legacy id: the first legacy id of a v2 id is its smallest.
    for (const r of rows.slice(0, LEGACY_TAXONOMY_MAX_ROWS)) {
      forward.set(`${r.entity}:${r.legacyId}`, r.newId);
      if (!reverse.has(r.newId)) reverse.set(r.newId, r.legacyId);
    }
    const next = {
      newId: (entity: TaxonomyEntity, legacyId: string) => forward.get(`${entity}:${legacyId}`),
      legacyIdOf: (newId: string) => reverse.get(newId),
      size: forward.size,
      loadedAt: Date.now(),
    };
    taxonomy = next;
    return next;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * This process's taxonomy maps. The first call loads them (one statement); later calls answer at once and start a
 * background reload when they are older than `LEGACY_TAXONOMY_REFRESH_MS` (a failed reload keeps the old maps).
 */
export async function legacyTaxonomy(): Promise<LegacyTaxonomy> {
  const current = taxonomy;
  if (!current) return loadTaxonomy();
  if (Date.now() - current.loadedAt > LEGACY_TAXONOMY_REFRESH_MS && !loading) {
    loadTaxonomy().catch((err: unknown) => {
      logger().warn({ error: err instanceof Error ? err.name : typeof err }, 'legacy taxonomy reload failed');
    });
  }
  return current;
}

/** Loads the taxonomy maps now (feed-api boot, tests after writing maps). */
export async function reloadLegacyTaxonomy(): Promise<void> {
  if (loading) await loading.catch(() => undefined);
  await loadTaxonomy();
}

const known = new LocalLru<string>(50_000);
const unknown = new LocalLru<true>(2_000);
const KNOWN_TTL_MS = 10 * 60_000;
const UNKNOWN_TTL_MS = 60_000;

/** Tests: forget resolved listing and unit ids (the taxonomy maps stay: `resetLegacyTaxonomy`). */
export function resetLegacyIdCache(): void {
  known.clear();
  unknown.clear();
}

/** Tests: forget the taxonomy maps (the next use loads them). */
export function resetLegacyTaxonomy(): void {
  taxonomy = null;
}

/**
 * The listing or unit a legacy property id names (S8-02): `{ entity, newId }`, or null. Cached; a miss is one statement
 * (the SECURITY DEFINER lookup).
 */
export async function legacyTarget(legacyId: string): Promise<{ entity: 'listing' | 'unit'; newId: string } | null> {
  const hit = known.get(legacyId);
  if (hit) return JSON.parse(hit) as { entity: 'listing' | 'unit'; newId: string };
  if (unknown.get(legacyId)) return null;
  const rows = await withPublicRead((tx) => repo.listingTargetsOf(tx, [legacyId]));
  // A legacy id names a listing or a unit; should both exist, the listing wins (deterministic).
  const row = rows.find((r) => r.entity === 'listing') ?? rows[0];
  if (!row) {
    unknown.set(legacyId, true, UNKNOWN_TTL_MS);
    return null;
  }
  const target = { entity: row.entity as 'listing' | 'unit', newId: row.newId };
  known.set(legacyId, JSON.stringify(target), KNOWN_TTL_MS);
  return target;
}

/**
 * The legacy ids of these listing and unit ids as a subquery for the caller's own statement (`select … as legacy`):
 * `read` turns its value into newId → legacy id. No statement of its own.
 */
export function legacyIdsQuery(newIds: readonly string[]): { sql: SQL; read: (value: unknown) => Map<string, string> } {
  return {
    sql: repo.listingLegacyIdsJson(newIds),
    read: (value) => new Map(Object.entries((value ?? {}) as Record<string, string>)),
  };
}
