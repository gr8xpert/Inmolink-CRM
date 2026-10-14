/**
 * migration use cases (PATTERNS §7). Legacy taxonomy import (S2-06, PLAN §14): maps each legacy location,
 * property type and feature onto the curated v2 taxonomy through the alias resolver, writes an alias for
 * every legacy spelling that does not already resolve to its target, and records `legacy_id_maps`.
 *
 * Nothing is invented or guessed: the v2 taxonomy is curated, so a legacy row with no confident match is
 * not created as new data; it is listed in the report with a reason for staff (who map it, then re-run: the
 * run is idempotent). Writes take the `tx` of a `withSystem()` call (reference data, like taxonomy admin):
 * the only caller is the operator script, so there is no `ctx` and no policy check. Staff-set maps
 * (`method = 'manual'`) are never overwritten.
 */
import type { LegacyTaxonomyExtract, LegacyTaxonomyReport, LegacyUnmappedReason } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import * as taxonomy from '../taxonomy';
import * as repo from './repo';

type Entity = repo.MapEntity;
type Resolution = taxonomy.Resolution;

export type ImportOptions = {
  /** Resolve and report only: no alias and no map is written. */
  dryRun?: boolean;
};

type Item = { id: string; name: string; names: Record<string, string>; aliases: string[]; parentId?: string | null };

/** A spelling shared by two canonical entries resolves "unmatched" with a candidate at confidence 1. */
const isAmbiguous = (r: Resolution) => r.status === 'unmatched' && r.candidate?.confidence === 1;

/** Distinct spellings of an item by normalised key, its primary name first. */
function spellings(item: Item): { key: string; text: string }[] {
  const seen = new Map<string, string>();
  for (const text of [item.name, ...Object.values(item.names), ...item.aliases]) {
    const key = taxonomy.aliasKey(text);
    if (key && !seen.has(key)) seen.set(key, text);
  }
  return [...seen].map(([key, text]) => ({ key, text }));
}

/** Depth of each location in the legacy tree; items with a missing parent or a cycle are absent (invalid). */
function legacyDepths(items: readonly Item[]): Map<string, number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = new Map<string, number>();
  const bad = new Set<string>();
  for (const item of items) {
    const chain: Item[] = [];
    let cur: Item | undefined = item;
    let base: number | null = 0;
    while (cur) {
      if (depth.has(cur.id)) base = depth.get(cur.id) as number;
      else if (bad.has(cur.id) || chain.includes(cur))
        base = null; // known bad, or a cycle
      else {
        chain.push(cur);
        if (cur.parentId == null) {
          base = 0;
        } else {
          cur = byId.get(cur.parentId);
          if (!cur) base = null; // missing parent
          continue;
        }
      }
      break;
    }
    chain.reverse().forEach((c, i) => {
      if (base === null) bad.add(c.id);
      else depth.set(c.id, base + i + 1);
    });
  }
  return depth;
}

type Mapped = { item: Item; targetId: string; via: Resolution };

const unmappedReason = (best: Resolution[], invalid: boolean): LegacyUnmappedReason =>
  invalid
    ? 'invalid'
    : best.some(isAmbiguous)
      ? 'ambiguous'
      : best.some((r) => r.candidate)
        ? 'low_confidence'
        : 'no_match';

async function mapEntity(
  tx: Tx,
  entity: Entity,
  items: readonly Item[],
  opts: ImportOptions,
  report: LegacyTaxonomyReport,
): Promise<void> {
  const kind = entity as taxonomy.TaxonomyKind;
  const counts = { total: items.length, mapped: 0, exact: 0, fuzzy: 0, unmapped: 0 };
  report.counts[entity] = counts;

  // One batch for every distinct spelling of the kind (never a query per row).
  const allKeys = new Map<string, string>();
  for (const item of items) for (const s of spellings(item)) allKeys.set(s.key, s.text);
  const keys = [...allKeys.keys()];
  const resolved = new Map<string, Resolution>();
  (await taxonomy.resolveMany(tx, kind, [...allKeys.values()])).forEach((r, i) => {
    resolved.set(keys[i] as string, r);
  });

  // Locations go level by level, so a parent is mapped before its children are checked against it.
  // Depth 0 = invalid (missing parent or cycle); non-locations are one level.
  const depths = entity === 'location' ? legacyDepths(items) : null;
  const levels = new Map<number, Item[]>();
  for (const item of items) {
    const d = depths ? (depths.get(item.id) ?? 0) : 1;
    levels.set(d, [...(levels.get(d) ?? []), item]);
  }
  const targetOf = new Map<string, string>(); // legacy id → v2 id
  const mapped: Mapped[] = [];
  const unmapped = (item: Item, best: Resolution[], reason: LegacyUnmappedReason) => {
    counts.unmapped++;
    const cand = best.find((r) => r.candidate)?.candidate ?? null;
    report.unmapped.push({
      entity,
      legacyId: item.id,
      name: item.name,
      reason,
      candidateId: cand?.id ?? null,
      candidateScore: cand ? Number(cand.confidence.toFixed(3)) : null,
      parentUnmapped: item.parentId != null && !targetOf.has(item.parentId),
    });
  };

  for (const depth of [...levels.keys()].sort((x, y) => x - y)) {
    const level = levels.get(depth) as Item[];
    const own = new Map<string, Resolution[]>(
      level.map((item) => [item.id, spellings(item).map((s) => resolved.get(s.key) as Resolution)]),
    );
    // A shared location name is retried under the mapped legacy parent: one call per distinct parent.
    const retry = new Map<string, Item[]>();
    for (const item of level) {
      const parentTarget = item.parentId ? targetOf.get(item.parentId) : undefined;
      const primary = own.get(item.id)?.[0];
      if (depths && depth > 0 && parentTarget && primary && isAmbiguous(primary)) {
        retry.set(parentTarget, [...(retry.get(parentTarget) ?? []), item]);
      }
    }
    for (const [parentId, group] of retry) {
      const texts = group.flatMap((item) => spellings(item).map((s) => s.text));
      const hinted = await taxonomy.resolveMany(tx, 'location', texts, { parentId });
      let i = 0;
      for (const item of group) {
        const n = spellings(item).length;
        own.set(item.id, hinted.slice(i, i + n));
        i += n;
      }
    }

    const candidates: Mapped[] = [];
    for (const item of level) {
      const best = own.get(item.id) as Resolution[];
      const invalid = best.length === 0 || (depths !== null && depth === 0);
      const primary = best[0];
      // An ambiguous primary name is never settled by a fuzzy secondary spelling.
      const via =
        invalid || !primary
          ? undefined
          : primary.status === 'exact'
            ? primary
            : isAmbiguous(primary)
              ? undefined
              : (best.find((r) => r.status === 'exact') ?? best.find((r) => r.status === 'fuzzy'));
      if (!via?.id) unmapped(item, best, unmappedReason(best, invalid));
      else candidates.push({ item, targetId: via.id, via });
    }

    // The match must sit under the location the legacy parent maps to (any ancestor: legacy trees skip levels).
    const checked = depths ? candidates.filter((c) => c.item.parentId && targetOf.has(c.item.parentId)) : [];
    const ancestors = await taxonomy.locationAncestors(
      tx,
      checked.map((c) => c.targetId),
    );
    for (const c of candidates) {
      const parentTarget = depths && c.item.parentId ? targetOf.get(c.item.parentId) : undefined;
      if (parentTarget && !ancestors.get(c.targetId)?.has(parentTarget)) {
        const hint: Resolution = {
          status: 'unmatched',
          id: null,
          confidence: 0,
          candidate: { id: c.targetId, confidence: c.via.confidence },
        };
        unmapped(c.item, [hint], 'parent_mismatch');
        continue;
      }
      counts.mapped++;
      if (c.via.status === 'exact') counts.exact++;
      else counts.fuzzy++;
      targetOf.set(c.item.id, c.targetId);
      mapped.push(c);
    }
  }

  // Aliases: every legacy spelling that does not already resolve (globally, without hints) to its target.
  const claimed = new Map<string, string>(); // alias key → owner (this run)
  const toWrite: { ownerId: string; alias: string; legacyId: string; key: string }[] = [];
  for (const m of mapped) {
    for (const s of spellings(m.item)) {
      const res = resolved.get(s.key) as Resolution;
      if (res.status === 'exact') {
        if (res.id !== m.targetId) {
          report.aliasConflicts.push({ entity, legacyId: m.item.id, spelling: s.text, ownerId: res.id as string });
        }
        continue;
      }
      if (isAmbiguous(res)) continue; // shared name: the parent told them apart; a global alias would not
      const owner = claimed.get(s.key);
      if (owner) {
        if (owner !== m.targetId) {
          report.aliasConflicts.push({ entity, legacyId: m.item.id, spelling: s.text, ownerId: owner });
        }
        continue;
      }
      claimed.set(s.key, m.targetId);
      toWrite.push({ ownerId: m.targetId, alias: s.text, legacyId: m.item.id, key: s.key });
    }
  }
  if (opts.dryRun) report.aliasesAdded += toWrite.length;
  else if (toWrite.length > 0) {
    // One bulk write; a spelling someone else owns comes back as a conflict, never aborts the run.
    const { inserted, owners } = await taxonomy.importAliases(tx, kind, toWrite);
    report.aliasesAdded += inserted.size;
    for (const w of toWrite) {
      const owner = owners.get(w.key);
      if (!inserted.has(w.key) && owner !== w.ownerId) {
        report.aliasConflicts.push({ entity, legacyId: w.legacyId, spelling: w.alias, ownerId: owner ?? '' });
      }
    }
  }

  // legacy_id_maps: upsert (manual maps kept); a map that pointed elsewhere is replaced and counted.
  const before = await repo.getMaps(
    tx,
    entity,
    mapped.map((m) => m.item.id),
  );
  report.remapped += mapped.filter((m) => {
    const prev = before.get(m.item.id);
    return prev !== undefined && prev.method !== 'manual' && prev.newId !== m.targetId;
  }).length;
  if (!opts.dryRun) {
    await repo.upsertMaps(
      tx,
      entity,
      mapped.map((m) => ({ id: newId(), legacyId: m.item.id, newId: m.targetId, method: m.via.status })),
    );
  }
}

/** Imports the legacy taxonomy extract; returns the report (the artifact of the run). */
export async function importLegacyTaxonomy(
  tx: Tx,
  extract: LegacyTaxonomyExtract,
  opts: ImportOptions = {},
): Promise<LegacyTaxonomyReport> {
  const report: LegacyTaxonomyReport = {
    counts: {
      location: { total: 0, mapped: 0, exact: 0, fuzzy: 0, unmapped: 0 },
      propertyType: { total: 0, mapped: 0, exact: 0, fuzzy: 0, unmapped: 0 },
      feature: { total: 0, mapped: 0, exact: 0, fuzzy: 0, unmapped: 0 },
    },
    aliasesAdded: 0,
    remapped: 0,
    unmapped: [],
    aliasConflicts: [],
  };
  await mapEntity(tx, 'location', extract.locations, opts, report);
  await mapEntity(tx, 'propertyType', extract.propertyTypes, opts, report);
  await mapEntity(tx, 'feature', extract.features, opts, report);
  return report;
}
