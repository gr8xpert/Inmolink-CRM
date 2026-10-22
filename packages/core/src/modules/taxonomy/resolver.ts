/**
 * Alias resolver (S2-05, PLAN §7 M4/M5): maps a feed spelling to a location, property type or feature.
 * Order: feed alias → canonical name (exact, accent-insensitive) → trigram fallback. A fuzzy hit is accepted
 * only when it is clearly the best (score and margin); anything less is `unmatched`, carries the closest
 * candidate as a hint, and `resolveAndQueue` counts it in the staff queue. Never a silent guess.
 *
 * Batch-first: one statement per step for a whole list of distinct values (imports resolve hundreds at once,
 * never one query per listing).
 */
import type { LocationLevel } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import type { Ctx } from '../../context';
import { assertCan } from './policy';
import * as repo from './repo';
import { aliasKey } from './service';

/** A fuzzy match is taken only at or above this similarity (pg_trgm, 0–1)… */
export const FUZZY_ACCEPT = 0.85;
/** …and only when it beats the runner-up by this much, so near-ties go to staff. */
export const FUZZY_MARGIN = 0.15;
/** Examples kept per queued value. */
const EXAMPLES_MAX = 5;
/** Distinct values resolved per statement; larger lists are split. */
const CHUNK = 500;
/** Longest value resolved or queued (an alias is at most this long): longer text is free text, not a name. */
const VALUE_MAX = 200;

/** The key a value resolves on; '' (never matched, never queued) when empty or too long. */
const valueKey = (text: string) => (text.trim().length > VALUE_MAX ? '' : aliasKey(text));

export type TaxonomyKind = repo.ResolveKind;
/** Location feeds say where a value sits: its parent and/or level narrows the candidates. */
export type ResolveHints = { parentId?: string | null; level?: LocationLevel };

export type Resolution = {
  /** `exact`: alias or canonical name. `fuzzy`: confident trigram match. `unmatched`: nothing safe to pick. */
  status: 'exact' | 'fuzzy' | 'unmatched';
  /** The location / property type / feature id; null when unmatched. */
  id: string | null;
  /** 1 for exact, the similarity for fuzzy, 0 for unmatched. */
  confidence: number;
  /** When unmatched: the closest candidate (a hint for staff, never applied). */
  candidate: { id: string; confidence: number } | null;
};

export type ResolveInput = {
  /** The value as the feed wrote it. */
  text: string;
  /** How many listings carry it in this run (default 1). */
  count?: number;
  /** A source reference shown to staff (listing reference, feed name). */
  example?: string;
  /** More of them, newest first (S7-F10: sightings counted later in a run); `example` is the newest when both are set. */
  examples?: readonly string[];
  /** Locations: the parent this value sits under, overriding `hints.parentId` (S7-F10: a level's values at once). */
  parentId?: string | null;
};

/** A value to resolve: its text and, for locations, the parent it sits under (absent: `hints.parentId`). */
export type ResolveValue = { text: string; parentId?: string | null };

const UNMATCHED: Resolution = { status: 'unmatched', id: null, confidence: 0, candidate: null };

/** One (parent, key) query's identity in the maps below. */
const queryId = (q: repo.KeyQuery) => `${q.parentId ?? ''}|${q.key}`;

/** Resolves distinct (key, parent) queries; every query has an entry in the result, by `queryId`. */
async function resolveKeys(
  tx: Tx,
  kind: TaxonomyKind,
  queries: readonly repo.KeyQuery[],
  level: LocationLevel | undefined,
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  for (let i = 0; i < queries.length; i += CHUNK) {
    const chunk = queries.slice(i, i + CHUNK);
    const exact = new Map<string, { alias?: string; names: Set<string> }>();
    for (const r of await repo.exactMatches(tx, kind, chunk, level)) {
      const id = queryId({ key: r.key, parentId: r.parentId ?? null });
      const e = exact.get(id) ?? { names: new Set<string>() };
      if (r.viaAlias) e.alias = r.id;
      else e.names.add(r.id);
      exact.set(id, e);
    }
    const fuzzy: repo.KeyQuery[] = [];
    for (const q of chunk) {
      const e = exact.get(queryId(q));
      const id = e?.alias ?? (e?.names.size === 1 ? [...e.names][0] : undefined);
      if (id) out.set(queryId(q), { status: 'exact', id, confidence: 1, candidate: null });
      else if (e && e.names.size > 1) {
        // The same name twice (two towns called alike): only staff or a parent hint can tell.
        out.set(queryId(q), { ...UNMATCHED, candidate: { id: [...e.names].sort()[0] as string, confidence: 1 } });
      } else fuzzy.push(q);
    }
    const byQuery = new Map<string, repo.KeyMatch[]>();
    for (const m of await repo.fuzzyMatches(tx, kind, fuzzy, level)) {
      const id = queryId({ key: m.key, parentId: m.parentId ?? null });
      byQuery.set(id, [...(byQuery.get(id) ?? []), m]);
    }
    for (const q of fuzzy) {
      const [top, second] = byQuery.get(queryId(q)) ?? [];
      if (!top) out.set(queryId(q), UNMATCHED);
      else if (top.score >= FUZZY_ACCEPT && (!second || top.score - second.score >= FUZZY_MARGIN)) {
        out.set(queryId(q), { status: 'fuzzy', id: top.id, confidence: top.score, candidate: null });
      } else out.set(queryId(q), { ...UNMATCHED, candidate: { id: top.id, confidence: top.score } });
    }
  }
  return out;
}

/**
 * Resolves the values in order. Read-only: a tenant `ctx` or a system transaction both work. Each value may name its
 * own parent (locations): one statement per step for all of them, whatever the parents (S7-F10).
 */
export async function resolveMany(
  tx: Tx,
  kind: TaxonomyKind,
  values: readonly (string | ResolveValue)[],
  hints: ResolveHints = {},
): Promise<Resolution[]> {
  const queries = values.map((v): repo.KeyQuery => {
    const text = typeof v === 'string' ? v : v.text;
    const own = typeof v === 'string' ? undefined : v.parentId;
    const parentId = kind === 'location' ? ((own === undefined ? hints.parentId : own) ?? null) : null;
    return { key: valueKey(text), parentId };
  });
  const distinct = new Map<string, repo.KeyQuery>();
  for (const q of queries) if (q.key) distinct.set(queryId(q), q);
  const resolved = await resolveKeys(tx, kind, [...distinct.values()], hints.level);
  return queries.map((q) => (q.key ? (resolved.get(queryId(q)) ?? UNMATCHED) : UNMATCHED));
}

async function resolveOne(ctx: Ctx, kind: TaxonomyKind, text: string, hints: ResolveHints): Promise<Resolution> {
  assertCan(ctx, 'taxonomy.read');
  return (await resolveMany(ctx.tx, kind, [text], hints))[0] as Resolution;
}

/** The location a feed spelling means; `hints` (parent, level) keep "San Pedro" under the right city. */
export const resolveLocation = (ctx: Ctx, text: string, hints: ResolveHints = {}) =>
  resolveOne(ctx, 'location', text, hints);
export const resolveType = (ctx: Ctx, text: string) => resolveOne(ctx, 'propertyType', text, {});
export const resolveFeature = (ctx: Ctx, text: string) => resolveOne(ctx, 'feature', text, {});

/**
 * Import-side entry (worker, `withSystem()` transaction): resolves the values, and counts every unmatched one
 * in the staff queue with its examples and closest candidate. Returns one resolution per input, in order.
 * Run it again after staff mapped a value and the same input resolves exactly — that is how drafts waiting
 * on a mapping are promoted by the next import run.
 */
export async function resolveAndQueue(
  tx: Tx,
  kind: TaxonomyKind,
  values: readonly ResolveInput[],
  hints: ResolveHints = {},
): Promise<Resolution[]> {
  const results = await resolveMany(tx, kind, values, hints);
  await queueUnmatched(
    tx,
    values.map((input, i) => ({ kind, input, resolution: results[i] as Resolution })),
  );
  return results;
}

/** A value resolved earlier and to count in the staff queue (its resolution: unmatched ones are queued). */
export type QueueEntry = { kind: TaxonomyKind; input: ResolveInput; resolution: Resolution };

/**
 * Counts the unmatched values of `entries` in the staff queue with their examples and closest candidate, every kind in
 * one statement (nothing to count: no statement). Import runs call it once per value per run (S7-F10, `RunResolver`).
 */
export async function queueUnmatched(tx: Tx, entries: readonly QueueEntry[]): Promise<void> {
  const queue = new Map<string, repo.UnmatchedUpsert>();
  for (const { kind, input: v, resolution: r } of entries) {
    const key = valueKey(v.text);
    if (!key || r.status !== 'unmatched') continue;
    const row = queue.get(`${kind}|${key}`) ?? {
      id: newId(),
      kind,
      valueKey: key,
      value: v.text.trim(),
      count: 0,
      examples: [],
      candidateId: r.candidate?.id ?? null,
      candidateScore: r.candidate?.confidence ?? null,
    };
    row.count += Math.max(1, v.count ?? 1);
    // newest first: a later value of the batch is the more recent example (S3-F1)
    for (const raw of [...(v.examples ?? [])].reverse().concat(v.example ? [v.example] : [])) {
      if (!raw) continue;
      const example = raw.slice(0, VALUE_MAX);
      row.examples = [example, ...row.examples.filter((e) => e !== example)].slice(0, EXAMPLES_MAX);
    }
    queue.set(`${kind}|${key}`, row);
  }
  if (queue.size > 0) await repo.upsertUnmatched(tx, [...queue.values()]);
}
