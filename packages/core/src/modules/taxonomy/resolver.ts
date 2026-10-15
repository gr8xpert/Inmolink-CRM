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
};

const UNMATCHED: Resolution = { status: 'unmatched', id: null, confidence: 0, candidate: null };

/** Resolves distinct normalised keys; every key has an entry in the result. */
async function resolveKeys(
  tx: Tx,
  kind: TaxonomyKind,
  keys: string[],
  hints: ResolveHints,
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const exact = new Map<string, { alias?: string; names: Set<string> }>();
    for (const r of await repo.exactMatches(tx, kind, chunk, hints)) {
      const e = exact.get(r.key) ?? { names: new Set<string>() };
      if (r.viaAlias) e.alias = r.id;
      else e.names.add(r.id);
      exact.set(r.key, e);
    }
    const fuzzyKeys: string[] = [];
    for (const key of chunk) {
      const e = exact.get(key);
      const id = e?.alias ?? (e?.names.size === 1 ? [...e.names][0] : undefined);
      if (id) out.set(key, { status: 'exact', id, confidence: 1, candidate: null });
      else if (e && e.names.size > 1) {
        // The same name twice (two towns called alike): only staff or a parent hint can tell.
        out.set(key, { ...UNMATCHED, candidate: { id: [...e.names].sort()[0] as string, confidence: 1 } });
      } else fuzzyKeys.push(key);
    }
    const byKey = new Map<string, repo.KeyMatch[]>();
    for (const m of await repo.fuzzyMatches(tx, kind, fuzzyKeys, hints)) {
      byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);
    }
    for (const key of fuzzyKeys) {
      const [top, second] = byKey.get(key) ?? [];
      if (!top) out.set(key, UNMATCHED);
      else if (top.score >= FUZZY_ACCEPT && (!second || top.score - second.score >= FUZZY_MARGIN)) {
        out.set(key, { status: 'fuzzy', id: top.id, confidence: top.score, candidate: null });
      } else out.set(key, { ...UNMATCHED, candidate: { id: top.id, confidence: top.score } });
    }
  }
  return out;
}

/** Resolves the values in order. Read-only: a tenant `ctx` or a system transaction both work. */
export async function resolveMany(
  tx: Tx,
  kind: TaxonomyKind,
  values: readonly string[],
  hints: ResolveHints = {},
): Promise<Resolution[]> {
  const keys = values.map(valueKey);
  const resolved = await resolveKeys(tx, kind, [...new Set(keys.filter(Boolean))], hints);
  return keys.map((k) => (k ? (resolved.get(k) ?? UNMATCHED) : UNMATCHED));
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
  const results = await resolveMany(
    tx,
    kind,
    values.map((v) => v.text),
    hints,
  );
  const queue = new Map<string, repo.UnmatchedUpsert>();
  values.forEach((v, i) => {
    const key = valueKey(v.text);
    const r = results[i] as Resolution;
    if (!key || r.status !== 'unmatched') return;
    const row = queue.get(key) ?? {
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
    if (v.example && row.examples.length < EXAMPLES_MAX && !row.examples.includes(v.example)) {
      row.examples.push(v.example.slice(0, VALUE_MAX));
    }
    queue.set(key, row);
  });
  await repo.upsertUnmatched(tx, [...queue.values()]);
  return results;
}
