/**
 * The bulk loader (S6-02, PATTERNS §13): the `FeedSink` every feed run writes through. Per batch of valid items:
 *
 * 1. **prepare** (outside the fenced transaction): parse each item as a `FeedListing`, then resolve its taxonomy
 *    through the S2-05 resolver in one short `withSystem` transaction — location level by level with the level above
 *    as hint, the property type, the features — queueing unmatched values for staff (`resolveAndQueue`). Known
 *    values are remembered for the rest of the run. An unmatched value holds the listing as DRAFT; once staff map it,
 *    the next run resolves it, the listing's import hash changes and the MERGE promotes it.
 * 2. **write** (inside the run's fenced batch transaction, `withTenant`): `properties.importListingBatch` — COPY →
 *    staging → MERGE, field locks honoured, unchanged items skipped by hash, events bulk-inserted — then the
 *    changed listings' image URLs go to the media queue (`media.queueFeedImages`, fetched later, hash-first).
 * 3. **finish** (in the transaction that ends a successful run): listings of the connection missing from the feed
 *    for N runs in a row are WITHDRAWN (N: the connection's `withdrawAfterMissedRuns`, else
 *    `IMPORT_WITHDRAW_AFTER_MISSED_RUNS`). A run with no valid item withdraws nothing (a broken feed is not an empty
 *    portfolio).
 */
import { createHash } from 'node:crypto';
import { type Commission, FeedListing, FeedLoaderSettings, type LocationLevel } from '@inmolink/contracts';
import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { AppError } from '@inmolink/platform/errors';
import { withMemberCtx } from '../../member';
import * as agencies from '../agencies';
import * as identity from '../identity';
import * as media from '../media';
import * as properties from '../properties';
import * as taxonomy from '../taxonomy';
import { defaultWithdrawAfterMissedRuns, RUNS } from './config';
import type { ItemError, ValidItem } from './pipeline';
import * as repo from './repo';

/**
 * One item's size as JSON (characters): a batch of 500 stays well inside the worker's memory budget (long
 * multilingual descriptions fit; a feed stuffing megabytes into one item gets a per-item error).
 */
const MAX_ITEM_CHARS = 128 * 1024;

/** Bumped when what the loader writes for the same feed item changes: every listing is written once more. */
const LOADER_VERSION = 1;

/** What a run tells its sink. */
export interface SinkRun {
  runId: string;
  agencyId: string;
  connectionId: string;
  connector: string;
  settings: Record<string, unknown>;
  /** When the run was first claimed (S6-08: listings created since are not the anomaly guard's base). */
  startedAt: Date;
}

export interface SinkCounts {
  created: number;
  updated: number;
  unchanged: number;
  held: number;
  /** S7-F3: seen references the write recorded (kept on the run's logged row; a sink that keeps none omits it). */
  seen?: number;
}

/** One run's loader: holds run-level state (owner, defaults, the taxonomy cache). */
export interface RunLoader<Prepared = unknown> {
  /** Outside any transaction of the run (may open its own short ones). Never writes listings. */
  prepare(items: ValidItem[]): Promise<{ prepared: Prepared; errors: ItemError[] }>;
  /**
   * Inside the fenced batch transaction. `seenRefs`: references of the batch's failed items (still in the feed).
   * `errors`: items the write could not store (counted as failed).
   */
  write(tx: Tx, prepared: Prepared, seenRefs: readonly string[]): Promise<SinkCounts & { errors: ItemError[] }>;
  /**
   * Inside the transaction that ends a successful run, before the run is ended (S6-08 anomaly guard): the connection's
   * live listings and how many of them this run did not see. `finish` in the same transaction reuses the result.
   */
  dropStats(tx: Tx): Promise<{ live: number; missing: number }>;
  /** Inside the transaction that ends a successful run (after its fence). Answers the listings withdrawn. */
  finish(tx: Tx, totals: { valid: number }): Promise<number>;
  /**
   * After a successful run committed (S6-08 freshness via feed): its listings last confirmed before `before` are
   * confirmed, in short transactions of their own. Answers how many.
   */
  confirmFresh(before: Date): Promise<number>;
  /** Inside the transaction that ends a failed run. */
  abandon(tx: Tx): Promise<void>;
}

/** Where valid items go; `start` runs once per run, after the claim. */
export interface FeedSink {
  /**
   * Inside the transaction that claims a run again (attempt > 1), fenced by that claim (S7-F2 review): drops what an
   * earlier attempt left for the run. Never in `start`, which runs after the claim committed — a worker that lost
   * its lease meanwhile would wipe what the new owner wrote.
   */
  reset?(tx: Tx, runId: string): Promise<void>;
  /** Reads only (owner, defaults): nothing it does needs the run's fence. */
  start(run: SinkRun): Promise<RunLoader>;
}

/**
 * S7-F3: the run's seen references are not all there (the UNLOGGED table lost rows in a crash or a failover). Retryable:
 * the next attempt reads the feed again from a clean slate.
 */
export class SeenRefsLostError extends Error {
  override readonly name = 'SeenRefsLostError';
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`feed run seen references lost (expected ${expected}, found ${actual}); the run starts over`);
  }
}

/** A run that cannot start loading: no member to own its listings (the run fails with `FEED_NO_OWNER`). */
export class FeedNoOwnerError extends Error {
  override readonly name = 'FeedNoOwnerError';
  constructor() {
    super('no active member to own imported listings');
  }
}

/** Validates and counts, writes nothing (tests of the run machinery; connectors' dry runs). */
export const countOnlySink: FeedSink = {
  async start() {
    return {
      async prepare() {
        return { prepared: null, errors: [] };
      },
      async write() {
        return { created: 0, updated: 0, unchanged: 0, held: 0, errors: [] };
      },
      async dropStats() {
        return { live: 0, missing: 0 };
      },
      async confirmFresh() {
        return 0;
      },
      async finish() {
        return 0;
      },
      async abandon() {},
    };
  },
};

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clip = (s: string, n: number) => s.slice(0, n);

/** `properties.source` of a connector's listings: its key as an upper-case format name (`kyero` → `KYERO`). */
export const sourceOf = (connector: string) => connector.toUpperCase().replaceAll('-', '_');

const LEVELS: readonly { key: 'country' | 'region' | 'city' | 'area'; level: LocationLevel }[] = [
  { key: 'country', level: 'COUNTRY' },
  { key: 'region', level: 'REGION' },
  { key: 'city', level: 'CITY' },
  { key: 'area', level: 'AREA' },
];

export type Kind = 'location' | 'propertyType' | 'feature';

/**
 * Taxonomy resolution for a run: `resolveAndQueue` per (kind, hints) group of distinct values, one call per group;
 * matches are remembered for the run (bounded), unmatched values are resolved — and counted for staff — again in
 * every batch that has them.
 */
/** What taxonomy resolution needs: the id each value resolves to (null: unmatched). The dry run swaps in a read-only one. */
export interface TaxonomyResolver {
  resolve(
    tx: Tx,
    kind: Kind,
    values: readonly { text: string; example: string }[],
    hints?: taxonomy.ResolveHints,
  ): Promise<(string | null)[]>;
}

class RunResolver implements TaxonomyResolver {
  private readonly known = new Map<string, string>();

  private key(kind: Kind, hints: taxonomy.ResolveHints, text: string): string {
    return `${kind}|${hints.parentId ?? ''}|${hints.level ?? ''}|${taxonomy.aliasKey(text)}`;
  }

  /** The id each value resolves to (null: unmatched). `values`: text and an example (the feed reference). */
  async resolve(
    tx: Tx,
    kind: Kind,
    values: readonly { text: string; example: string }[],
    hints: taxonomy.ResolveHints = {},
  ): Promise<(string | null)[]> {
    const out: (string | null)[] = values.map((v) => this.known.get(this.key(kind, hints, v.text)) ?? null);
    const pending = new Map<string, { text: string; count: number; example: string }>();
    values.forEach((v, i) => {
      if (out[i] !== null) return;
      const k = this.key(kind, hints, v.text);
      const p = pending.get(k);
      if (p) p.count += 1;
      else pending.set(k, { text: v.text, count: 1, example: v.example });
    });
    if (pending.size === 0) return out;
    const inputs = [...pending.values()];
    const results = await taxonomy.resolveAndQueue(tx, kind, inputs, hints);
    const resolved = new Map<string, string | null>();
    inputs.forEach((input, i) => {
      const id = results[i]?.status === 'unmatched' ? null : (results[i]?.id ?? null);
      const k = this.key(kind, hints, input.text);
      resolved.set(k, id);
      if (id && this.known.size < RUNS.MAX_CACHED_RESOLUTIONS) this.known.set(k, id);
    });
    return values.map((v, i) => out[i] ?? resolved.get(this.key(kind, hints, v.text)) ?? null);
  }
}

export interface Parsed {
  position: number;
  listing: FeedListing;
}

/** Resolved taxonomy of each parsed item (same order). */
export interface Resolved {
  locationId: string | null;
  propertyTypeId: string | null;
  featureIds: string[];
  held: properties.ImportHold[];
}

/** Location level by level: each value under the level above it when that one was given and matched. */
async function resolveLocations(
  tx: Tx,
  resolver: TaxonomyResolver,
  items: readonly Parsed[],
  out: Resolved[],
  levelOnly: boolean,
) {
  /** The matched id at the previous level, per item (undefined: that level was not given). */
  const above: (string | undefined)[] = items.map(() => undefined);
  const blocked = items.map(() => false);
  for (const { key, level } of LEVELS) {
    const groups = new Map<string, number[]>();
    items.forEach((p, i) => {
      if (blocked[i] || !p.listing.location[key]) return;
      const group = levelOnly ? '' : (above[i] ?? '');
      groups.set(group, [...(groups.get(group) ?? []), i]);
    });
    for (const [parentId, members] of groups) {
      const ids = await resolver.resolve(
        tx,
        'location',
        members.map((i) => ({ text: items[i]?.listing.location[key] as string, example: items[i]?.listing.ref ?? '' })),
        parentId ? { parentId, level } : { level },
      );
      members.forEach((i, j) => {
        const id = ids[j] ?? null;
        const r = out[i] as Resolved;
        if (id) {
          r.locationId = id;
          above[i] = id;
        } else {
          // Held at the deepest level matched so far; the levels below wait for staff to map this one.
          r.held.push('location');
          blocked[i] = true;
        }
      });
    }
    // A level the item skipped: the next one is resolved by its level alone (its parent is not known).
    items.forEach((p, i) => {
      if (!p.listing.location[key]) above[i] = undefined;
    });
  }
}

/**
 * `levelOnly` (the mapper dry run, a request): every location level is looked up in one statement for all items, by
 * level alone and not under each item parent, so the cost is constant whatever the sample. A name that exists under
 * several parents is then reported unmatched; a real run resolves it under its parent.
 */
export async function resolveTaxonomy(
  tx: Tx,
  resolver: TaxonomyResolver,
  items: readonly Parsed[],
  opts: { levelOnly?: boolean } = {},
): Promise<Resolved[]> {
  const out: Resolved[] = items.map(() => ({ locationId: null, propertyTypeId: null, featureIds: [], held: [] }));
  await resolveLocations(tx, resolver, items, out, opts.levelOnly ?? false);
  const types = await resolver.resolve(
    tx,
    'propertyType',
    items.map((p) => ({ text: p.listing.propertyType, example: p.listing.ref })),
  );
  types.forEach((id, i) => {
    const r = out[i] as Resolved;
    r.propertyTypeId = id;
    if (!id) r.held.push('propertyType');
  });
  const flat = items.flatMap((p, i) => p.listing.features.map((text) => ({ i, text, example: p.listing.ref })));
  if (flat.length > 0) {
    const ids = await resolver.resolve(tx, 'feature', flat);
    flat.forEach((f, j) => {
      const r = out[f.i] as Resolved;
      const id = ids[j];
      if (id) {
        if (!r.featureIds.includes(id)) r.featureIds.push(id);
      } else if (!r.held.includes('feature')) r.held.push('feature');
    });
  }
  return out;
}

/** The listing the MERGE writes, with the hash that decides whether it is written at all. */
function toImport(listing: FeedListing, r: Resolved): properties.ImportListing {
  const featureIds = [...r.featureIds].sort();
  const held = [...r.held].sort();
  const values = {
    status: listing.status,
    transactionType: listing.transactionType,
    priceCents: listing.priceCents,
    currency: listing.currency,
    pricePeriod: listing.transactionType === 'SALE' ? null : listing.pricePeriod,
    priceOnRequest: listing.priceOnRequest,
    builtM2: listing.builtM2,
    plotM2: listing.plotM2,
    terraceM2: listing.terraceM2,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    yearBuilt: listing.yearBuilt,
    energyRating: listing.energyRating,
    energyEmissionsRating: listing.energyEmissionsRating,
    coordinates: listing.coordinates,
    locationPrecision: listing.locationPrecision,
    propertyTypeId: r.propertyTypeId,
    locationId: r.locationId,
    featureIds,
    translations: listing.translations,
  };
  const imagesHash = listing.images.length > 0 ? sha256(listing.images) : null;
  return {
    ref: listing.ref,
    hash: sha256([LOADER_VERSION, values, held, imagesHash]),
    imagesHash,
    held,
    ...values,
  };
}

/** The field a refused item's error names. */
const REJECTED_FIELD = {
  PROPERTY_TYPE_UNMATCHED: 'propertyType',
  LOCATION_UNMATCHED: 'location',
  DUPLICATE_REF: 'ref',
} as const;

interface Prepared {
  items: properties.ImportListing[];
  positions: Map<string, number>;
  images: Map<string, string[]>;
}

/** The connection's loader settings; a malformed value falls back to its default. */
function loaderSettings(settings: Record<string, unknown>): FeedLoaderSettings {
  const out: FeedLoaderSettings = {};
  const owner = FeedLoaderSettings.shape.ownerUserId.safeParse(settings.ownerUserId);
  if (owner.success && owner.data) out.ownerUserId = owner.data;
  const n = FeedLoaderSettings.shape.withdrawAfterMissedRuns.safeParse(settings.withdrawAfterMissedRuns);
  if (n.success && n.data) out.withdrawAfterMissedRuns = n.data;
  return out;
}

/** The member new listings belong to: the connection's `ownerUserId` while an active member, else the first admin. */
async function ownerOf(agencyId: string, wanted: string | undefined): Promise<string> {
  const owner = await withSystem('imports.loader: owner of imported listings', async (tx) => {
    if (wanted) {
      const { role } = await identity.getMemberAccess(tx, { agencyId, userId: wanted });
      if (role) return wanted;
    }
    const [admin] = await identity.listAgencyAdmins(tx, agencyId);
    return admin?.userId ?? null;
  });
  if (!owner) throw new FeedNoOwnerError();
  return owner;
}

/** The production sink: feed items become listings (S6-02). */
export const listingSink: FeedSink = {
  /**
   * S7-F2: a run claimed again reads the feed from the start, so the references its earlier attempt saw go — else
   * the cross-batch duplicate check would refuse every item that attempt had written. One primary-key range delete.
   */
  async reset(tx, runId) {
    await properties.discardImportSeen(tx, runId);
  },

  async start(run) {
    const settings = loaderSettings(run.settings);
    const ownerUserId = await ownerOf(run.agencyId, settings.ownerUserId);
    let defaults: { commission: Commission; splitBp: number };
    try {
      defaults = await withMemberCtx({ userId: ownerUserId, agencyId: run.agencyId, requestId: run.runId }, (ctx) =>
        agencies.getAgencyDefaultCommission(ctx),
      );
    } catch (err) {
      if (err instanceof AppError && err.code === 'FORBIDDEN') throw new FeedNoOwnerError();
      throw err;
    }
    const importRun: properties.ImportRun = {
      agencyId: run.agencyId,
      runId: run.runId,
      connectionId: run.connectionId,
      source: sourceOf(run.connector),
      ownerUserId,
      commission: defaults.commission,
      splitBp: defaults.splitBp,
    };
    const withdrawAfter = settings.withdrawAfterMissedRuns ?? defaultWithdrawAfterMissedRuns();
    const resolver = new RunResolver();
    /** The run's missing references, from `dropStats` (same transaction as `finish`). */
    let missingRefs: string[] | undefined;

    const loader: RunLoader<Prepared> = {
      async prepare(valid) {
        const errors: ItemError[] = [];
        const parsed: Parsed[] = [];
        const refs = new Set<string>();
        for (const v of valid) {
          const result = FeedListing.safeParse({ ...(v.item as object), ref: v.ref });
          if (result.success && JSON.stringify(result.data).length > MAX_ITEM_CHARS) {
            errors.push({
              position: v.position,
              itemRef: clip(v.ref, 200),
              code: 'ITEM_TOO_LARGE',
              field: null,
              message: null,
            });
          } else if (!result.success) {
            const issue = result.error.issues[0];
            errors.push({
              position: v.position,
              itemRef: clip(v.ref, 200),
              code: 'INVALID_ITEM',
              field: issue?.path.length ? clip(issue.path.join('.'), 120) : null,
              message: issue ? clip(issue.message, 500) : null,
            });
          } else if (refs.has(result.data.ref)) {
            errors.push({
              position: v.position,
              itemRef: clip(v.ref, 200),
              code: 'DUPLICATE_REF',
              field: 'ref',
              message: null,
            });
          } else {
            refs.add(result.data.ref);
            parsed.push({ position: v.position, listing: result.data });
          }
        }
        const resolved =
          parsed.length === 0
            ? []
            : await withSystem('imports.loader: resolve feed taxonomy', (tx) => resolveTaxonomy(tx, resolver, parsed));
        const items = parsed.map((p, i) => toImport(p.listing, resolved[i] as Resolved));
        return {
          prepared: {
            items,
            positions: new Map(parsed.map((p) => [p.listing.ref, p.position])),
            images: new Map(
              parsed.filter((p) => p.listing.images.length > 0).map((p) => [p.listing.ref, p.listing.images]),
            ),
          },
          errors,
        };
      },

      async write(tx, prepared, seenRefs) {
        const result = await properties.importListingBatch(tx, importRun, prepared.items, seenRefs);
        const queued = result.imagesChanged.flatMap((c) => {
          const urls = prepared.images.get(c.ref);
          return urls ? [{ listingId: c.listingId, urls }] : [];
        });
        await media.queueFeedImages(tx, run.agencyId, queued);
        return {
          seen: result.seen,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          held: result.held,
          errors: result.rejected.map((r) => ({
            position: prepared.positions.get(r.ref) ?? 0,
            itemRef: clip(r.ref, 200),
            code: r.code,
            field: REJECTED_FIELD[r.code],
            message: null,
          })),
        };
      },

      async dropStats(tx) {
        // S7-F3: the seen table is UNLOGGED — a crash or a failover since the batches committed empties it, and the
        // anti-join would then count every listing as missing. The run's logged count must match before it is used;
        // otherwise the run fails retryably, is claimed again and starts over (the claim resets both).
        const [expected, actual] = await Promise.all([
          repo.runSeenCount(tx, run.runId),
          properties.countImportSeen(tx, run.runId),
        ]);
        if (expected !== actual) throw new SeenRefsLostError(expected, actual);
        const stats = await properties.importDropStats(tx, importRun, run.startedAt);
        missingRefs = stats.refs;
        return { live: stats.live, missing: stats.missing };
      },

      async confirmFresh(before) {
        const ids = await withTenant({ agencyId: run.agencyId }, (tx) =>
          properties.listingsToConfirmFromFeed(tx, importRun, before),
        );
        let confirmed = 0;
        for (let i = 0; i < ids.length; i += properties.FEED_CONFIRM_BATCH) {
          const batch = ids.slice(i, i + properties.FEED_CONFIRM_BATCH);
          confirmed += await withTenant({ agencyId: run.agencyId }, (tx) =>
            properties.confirmListingsFromFeed(tx, importRun, batch, before),
          );
        }
        return confirmed;
      },

      async finish(tx, totals) {
        if (totals.valid === 0) {
          await properties.discardImportSeen(tx, run.runId);
          return 0;
        }
        return properties.withdrawMissingImports(tx, importRun, withdrawAfter, missingRefs);
      },

      async abandon(tx) {
        await properties.discardImportSeen(tx, run.runId);
      },
    };
    return loader as RunLoader;
  },
};
