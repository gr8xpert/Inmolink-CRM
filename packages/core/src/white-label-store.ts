import { type CacheKey, cache, cacheKey } from '@inmolink/platform/cache';
import type { AiRemovals } from './white-label';

/**
 * The model pass's cached removals (S12-03), module-neutral like the sanitizer: `ai-features` writes them from a
 * worker, every serving path that white-labels a network document's text reads them (the website serializer through
 * `website-api`, selections, the portal, PDFs) — one MGET per page, never a model call.
 *
 * One entry per (owner agency, target) on redis-cache: the removals of each of the target's texts, every locale, by
 * `textKey` (a page may show a document in a fallback locale, so entries are not per locale), stored only when the
 * model found something. A missing entry (none found, not processed yet, evicted by allkeys-lru, redis-cache down)
 * means the deterministic pass alone; an entry of an older listing version holds other text keys, so it never
 * applies to the new text.
 */

/** How long an entry lives without a newer listing version (the next version's run rewrites it). */
export const AI_REMOVALS_TTL_SECONDS = 60 * 86_400;

export interface AiRemovalsEntry {
  /** The highest read model version (of its locales) the entry was computed from. */
  version: number;
  /** The prompt version that answered (a new one re-asks). */
  prompt: number;
  /** Removals by `textKey` of each source text (empty: answered, nothing to remove). */
  texts: Record<string, string[]>;
}

export interface AiRemovalsTarget {
  /** The owner agency (the entry's tenant scope). */
  agencyId: string;
  targetId: string;
}

const keyOf = (t: AiRemovalsTarget): CacheKey =>
  cacheKey({ v: 1, module: 'white-label', entity: 'ai-removals', scope: { agencyId: t.agencyId }, id: t.targetId });

function isEntry(value: unknown): value is AiRemovalsEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AiRemovalsEntry>;
  return typeof v.version === 'number' && typeof v.prompt === 'number' && !!v.texts && typeof v.texts === 'object';
}

/** The entries of these targets by target id (missing ones absent), in one MGET. */
export async function readAiRemovalEntries(
  targets: readonly AiRemovalsTarget[],
): Promise<Map<string, AiRemovalsEntry>> {
  const out = new Map<string, AiRemovalsEntry>();
  if (targets.length === 0) return out;
  const values = await cache.peekMany(targets.map(keyOf));
  targets.forEach((t, i) => {
    const v = values[i];
    if (isEntry(v)) out.set(t.targetId, v);
  });
  return out;
}

/**
 * The removals a serving path applies to these documents' texts (`SiteView.aiRemovals`): by target id, then
 * `textKey`, so one owner's answer never applies to another target's text. Empty when none, and on any failure — a
 * serving path never fails on this.
 */
export async function readAiRemovals(targets: readonly AiRemovalsTarget[]): Promise<AiRemovals> {
  const unique = [...new Map(targets.map((t) => [`${t.agencyId}:${t.targetId}`, t])).values()];
  let entries: Map<string, AiRemovalsEntry>;
  try {
    entries = await readAiRemovalEntries(unique);
  } catch {
    return new Map();
  }
  const out = new Map<string, ReadonlyMap<string, readonly string[]>>();
  for (const [targetId, entry] of entries) {
    const texts = new Map<string, readonly string[]>();
    for (const [key, spans] of Object.entries(entry.texts)) {
      if (Array.isArray(spans) && spans.length > 0)
        texts.set(
          key,
          spans.filter((s) => typeof s === 'string'),
        );
    }
    if (texts.size > 0) out.set(targetId, texts);
  }
  return out;
}

/** Writes (or, `null`, deletes) a target's entry. Worker-only. */
export async function writeAiRemovals(target: AiRemovalsTarget, entry: AiRemovalsEntry | null): Promise<void> {
  const key = keyOf(target);
  if (entry === null) await cache.delete(key);
  else await cache.set(key, entry, { ttlSeconds: AI_REMOVALS_TTL_SECONDS });
}
