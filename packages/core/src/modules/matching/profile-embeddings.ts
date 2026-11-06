/**
 * Client-profile embeddings (R2-01b, PLAN §8 #4, §7 M9): one multilingual vector per active client profile, for the
 * match engine's semantic score against listing vectors (R2-02). Same model and size as the listing embeddings
 * (R2-01a, `search.embeddingModel` / `search.embedChunk`): one vector space. Worker-only (`withSystem`); the model call
 * runs outside any transaction and is metered to the profile's agency.
 *
 * - **Text** (`profileEmbeddingText`): the hard criteria as words — transaction, property types, places (with their
 *   parents), rooms, sizes, must-have features, in the fallback content locale — then the client's wishes. No price (a
 *   budget edit must not cost a re-embed; the engine filters price structurally), no name or contact: the profile holds
 *   none, and contact details typed into the wishes are removed (`search.embeddingClean`, `.claude/rules/ai.md`).
 * - **Which profiles:** `mode` not `OFF`. A profile switched off, or deleted, loses its vector.
 * - **Never twice for the same text:** `content_hash` = sha256(model, text); unchanged → only `source_version` moves.
 * - **Re-embed on change:** `matching.clientProfiles.changed` (R2-02's profile service emits it on every write) queues
 *   `matching.embedProfiles`.
 * - **Backfill:** `matching.profileEmbeddingsSweep` (daily) queues one `matching.profileEmbeddingsBackfill` walk per
 *   agency over all its profiles, `PROFILE_BACKFILL_WINDOW` at a time: the texts are rebuilt and compared by hash, so a
 *   taxonomy rename or a model switch (texts change, versions do not) is caught too; orphan vectors are dropped.
 * - **Degrades like the listings':** budget or outage stops the page (left to the next event or sweep); a misconfigured
 *   provider fails without retry.
 */

import { type Tx, withSystem } from '@inmolink/db';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import type { AiCtx } from '@inmolink/platform/ai';
import type { ErrorCode } from '@inmolink/platform/errors';
import * as billing from '../billing';
import * as search from '../search';
import * as taxonomy from '../taxonomy';
import * as repo from './repo';

/** The AI feature (usage records, budgets). */
export const PROFILE_EMBED_FEATURE = 'matching.profile-embeddings';
/** Profiles a backfill page reads (texts rebuilt, the changed ones embedded). */
export const PROFILE_BACKFILL_WINDOW = 500;

const LEVEL_ORDER = ['AREA', 'CITY', 'REGION', 'COUNTRY'] as const;
const TRANSACTION_WORDS: Record<string, string> = {
  SALE: 'to buy',
  RENT_LONG_TERM: 'to rent long term',
  RENT_SHORT_TERM: 'to rent short term',
};

/** The criteria and wishes a text is built from (a profile row without price, mode or ids of people). */
export type ProfileFacts = Omit<repo.ProfileSource, 'id' | 'version' | 'mode'>;

/** Taxonomy names the text needs: an item's name, and a location's lineage names (itself first, country last). */
export interface ProfileNames {
  name(id: string): string | null;
  place(id: string): string[];
}

const fmt = (n: number) => String(Number(n.toFixed(2)));

/**
 * The text a profile is embedded from (pure: the same criteria and names always give the same text). Lists are
 * sorted, so the order ids were picked in never changes the text. Criteria first, so the cut at
 * `search.EMBED_TEXT_MAX_CHARS` only ever shortens the wishes.
 */
export function profileEmbeddingText(p: ProfileFacts, names: ProfileNames): string {
  const named = (ids: readonly string[]) =>
    [...new Set(ids.map((id) => names.name(id)).filter((n): n is string => !!n))].sort();
  const types = named(p.propertyTypeIds);
  const places = [...new Set(p.locationIds.map((id) => names.place(id).join(', ')).filter((s) => s.length > 0))].sort();
  const features = named(p.featureIds);
  const area =
    p.areaMinM2 != null && p.areaMaxM2 != null
      ? `${fmt(p.areaMinM2)}–${fmt(p.areaMaxM2)} m²`
      : p.areaMinM2 != null
        ? `at least ${fmt(p.areaMinM2)} m²`
        : p.areaMaxM2 != null
          ? `at most ${fmt(p.areaMaxM2)} m²`
          : null;
  const sizes = [
    p.bedsMin != null ? `at least ${p.bedsMin} bedrooms` : null,
    p.bathsMin != null ? `at least ${p.bathsMin} bathrooms` : null,
    area,
  ].filter((s): s is string => s !== null);
  const lines = [
    `Looking ${p.transactionType ? (TRANSACTION_WORDS[p.transactionType] ?? 'for a property') : 'for a property'}`,
    types.length > 0 ? `Property types: ${types.join('; ')}` : '',
    places.length > 0 ? `Places: ${places.join('; ')}` : '',
    sizes.join(', '),
    features.length > 0 ? `Must have: ${features.join(', ')}` : '',
    search.embeddingClean(p.wishes),
  ].filter((l) => l.length > 0);
  return lines.join('\n').slice(0, search.EMBED_TEXT_MAX_CHARS);
}

const NO_NAMES: ProfileNames = { name: () => null, place: () => [] };

/** The names of these profiles' taxonomy ids in the fallback content locale (two statements for any number). */
async function namesFor(tx: Tx, profiles: readonly repo.ProfileSource[]): Promise<ProfileNames> {
  const locale = FALLBACK_CONTENT_LOCALE;
  const tax = await taxonomy.taxonomyForReadModels(
    tx,
    {
      locations: profiles.flatMap((p) => p.locationIds),
      propertyTypes: profiles.flatMap((p) => p.propertyTypeIds),
      features: profiles.flatMap((p) => p.featureIds),
    },
    [locale],
  );
  const name = (id: string) => taxonomy.taxonName(tax, id, locale)?.name ?? null;
  return {
    name,
    place: (id) =>
      [...(tax.lineage.get(id) ?? [])]
        .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
        .map((l) => name(l.id))
        .filter((n): n is string => !!n),
  };
}

export interface EmbedProfilesResult {
  /** Off (no provider): nothing read, nothing called. */
  disabled: boolean;
  embedded: number;
  /** Hash unchanged: no model call. */
  unchanged: number;
  /** Vectors dropped (profile gone or switched off). */
  deleted: number;
  /** Left stale: the gateway said no (budget, outage). */
  degraded: number;
  degradeCode: ErrorCode | null;
}

const NOTHING: EmbedProfilesResult = {
  disabled: false,
  embedded: 0,
  unchanged: 0,
  deleted: 0,
  degraded: 0,
  degradeCode: null,
};

/**
 * Embeds these profiles of one agency (≤ a few hundred ids): rebuilds their texts, skips unchanged ones, embeds the
 * rest `search.EMBED_BATCH` at a time outside any transaction, then writes the vectors (never over a newer version).
 * Profiles gone or `OFF` lose their vector. Idempotent: a re-run finds every hash unchanged.
 */
export async function embedProfiles(
  input: { agencyId: string; profileIds: readonly string[] },
  options: { requestId?: string } = {},
): Promise<EmbedProfilesResult> {
  const model = search.embeddingModel();
  if (model === null) return { ...NOTHING, disabled: true };
  const ids = [...new Set(input.profileIds)];
  if (ids.length === 0) return NOTHING;

  const read = await withSystem('matching.embedProfiles', async (tx) => {
    const active = (await repo.profileSources(tx, input.agencyId, ids)).filter((p) => p.mode !== 'OFF');
    const keep = new Set(active.map((p) => p.id));
    const deleted = await repo.deleteProfileEmbeddings(
      tx,
      input.agencyId,
      ids.filter((id) => !keep.has(id)),
    );
    const names = active.length > 0 ? await namesFor(tx, active) : NO_NAMES;
    const hashes = await repo.profileEmbeddingHashes(tx, [...keep]);
    const todo: { source: repo.ProfileSource; text: string; hash: string }[] = [];
    const same: { profileId: string; version: number }[] = [];
    for (const p of active) {
      const text = profileEmbeddingText(p, names);
      const hash = search.embeddingHash(model, text);
      if (hashes.get(p.id) === hash) same.push({ profileId: p.id, version: p.version });
      else todo.push({ source: p, text, hash });
    }
    await repo.touchProfileEmbeddings(tx, same);
    const plan = todo.length > 0 ? (await billing.planOf(tx, input.agencyId)).code : null;
    return { todo, unchanged: same.length, deleted, plan };
  });

  const ctx: AiCtx = { tenant: { agencyId: input.agencyId, plan: read.plan }, requestId: options.requestId };
  let embedded = 0;
  for (let i = 0; i < read.todo.length; i += search.EMBED_BATCH) {
    const chunk = read.todo.slice(i, i + search.EMBED_BATCH);
    const res = await search.embedChunk(
      ctx,
      PROFILE_EMBED_FEATURE,
      model,
      chunk.map((c) => c.text),
    );
    if (res.vectors === null) {
      return {
        ...NOTHING,
        embedded,
        unchanged: read.unchanged,
        deleted: read.deleted,
        degraded: read.todo.length - i,
        degradeCode: res.degradeCode,
      };
    }
    const vectors = res.vectors;
    embedded += await withSystem('matching.embedProfiles', (tx) =>
      repo.upsertProfileEmbeddings(
        tx,
        chunk.map((c, j) => ({
          profileId: c.source.id,
          ownerAgencyId: input.agencyId,
          embedding: vectors[j] ?? [],
          model,
          contentHash: c.hash,
          sourceVersion: c.source.version,
        })),
      ),
    );
  }
  return { ...NOTHING, embedded, unchanged: read.unchanged, deleted: read.deleted };
}

export interface ProfileBackfillResult extends EmbedProfilesResult {
  /** The next page's cursor; null when the walk is done (or stopped: degraded / off). */
  next: string | null;
}

/**
 * One page of an agency's profile backfill: the next `PROFILE_BACKFILL_WINDOW` profiles after `after` — their texts
 * rebuilt and the changed ones embedded — and the window's orphan vectors dropped.
 */
export async function profileBackfillPage(
  input: { agencyId: string; after: string | null },
  options: { requestId?: string; window?: number } = {},
): Promise<ProfileBackfillResult> {
  if (search.embeddingModel() === null) return { ...NOTHING, disabled: true, next: null };
  const window = options.window ?? PROFILE_BACKFILL_WINDOW;
  const page = await withSystem('matching.profileEmbeddingsBackfill', async (tx) => {
    const ids = await repo.profileWindow(tx, { agencyId: input.agencyId, after: input.after, window });
    const last = ids.length === window ? (ids.at(-1) ?? null) : null;
    const orphans = await repo.deleteOrphanProfileEmbeddings(tx, {
      agencyId: input.agencyId,
      after: input.after,
      upTo: last,
    });
    return { ids, last, orphans };
  });
  const res = await embedProfiles({ agencyId: input.agencyId, profileIds: page.ids }, options);
  return { ...res, deleted: res.deleted + page.orphans, next: res.degraded > 0 ? null : page.last };
}
