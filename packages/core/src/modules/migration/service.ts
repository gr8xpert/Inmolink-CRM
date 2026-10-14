/**
 * migration use cases (PATTERNS §7). Legacy taxonomy import (S2-06, PLAN §14): maps each legacy location,
 * property type and feature onto the curated v2 taxonomy through the alias resolver, writes an alias for
 * every legacy spelling that does not already resolve to its target, and records `legacy_id_maps`.
 *
 * Nothing is invented or guessed: the v2 taxonomy is curated, so a legacy row with no confident match is
 * not created as new data; it is listed in the report with a reason for staff (who map it, then re-run: the
 * run is idempotent). Writes take the `tx` of a `withSystem()` call (reference data, like taxonomy admin).
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

const ADD_ALIAS: Record<Entity, (tx: Tx, id: string, alias: string) => Promise<string>> = {
  location: taxonomy.addLocationAlias,
  propertyType: taxonomy.addPropertyTypeAlias,
  feature: taxonomy.addFeatureAlias,
};

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

type Mapped = { item: Item; targetId: string; via: Resolution; byKey: Map<string, Resolution> };

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

  const depths = entity === 'location' ? legacyDepths(items) : null;
  const order = depths ? [...items].sort((a, b) => (depths.get(a.id) ?? 99) - (depths.get(b.id) ?? 99)) : [...items];
  const targetOf = new Map<string, string>(); // legacy id → v2 id (locations: parents for child hints)
  const unmappedIds = new Set<string>();
  const mapped: Mapped[] = [];

  // A location whose spelling did not resolve alone (a shared name) is retried under its mapped parent.
  for (const item of order) {
    const sp = spellings(item);
    let own = new Map<string, Resolution>(sp.map((s) => [s.key, resolved.get(s.key) as Resolution]));
    const primary = sp[0];
    const parentTarget = item.parentId ? targetOf.get(item.parentId) : undefined;
    if (primary && own.get(primary.key)?.id == null && parentTarget) {
      const hinted = await taxonomy.resolveMany(
        tx,
        'location',
        sp.map((s) => s.text),
        { parentId: parentTarget },
      );
      own = new Map(sp.map((s, i) => [s.key, hinted[i] as Resolution]));
    }
    const best = sp.map((s) => own.get(s.key) as Resolution);
    const via =
      best.find((r, i) => r.status === 'exact' && i === 0) ??
      best.find((r) => r.status === 'exact') ??
      best.find((r) => r.status === 'fuzzy');
    const invalid = sp.length === 0 || (depths !== null && !depths.has(item.id));
    if (!via || !via.id || invalid) {
      counts.unmapped++;
      unmappedIds.add(item.id);
      const cand = best.find((r) => r.candidate)?.candidate ?? null;
      const reason: LegacyUnmappedReason = invalid
        ? 'invalid'
        : best.some(isAmbiguous)
          ? 'ambiguous'
          : cand
            ? 'low_confidence'
            : 'no_match';
      report.unmapped.push({
        entity,
        legacyId: item.id,
        name: item.name,
        reason,
        candidateId: cand?.id ?? null,
        candidateScore: cand ? Number(cand.confidence.toFixed(3)) : null,
        parentUnmapped: item.parentId != null && (unmappedIds.has(item.parentId) || !targetOf.has(item.parentId)),
      });
      continue;
    }
    counts.mapped++;
    if (via.status === 'exact') counts.exact++;
    else counts.fuzzy++;
    targetOf.set(item.id, via.id);
    mapped.push({ item, targetId: via.id, via, byKey: own });
  }

  // Aliases: every legacy spelling that does not already resolve to its target.
  const claimed = new Map<string, string>(); // alias key → owner (this run)
  for (const m of mapped) {
    for (const s of spellings(m.item)) {
      const res = m.byKey.get(s.key) as Resolution;
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
      if (!opts.dryRun) await ADD_ALIAS[entity](tx, m.targetId, s.text);
      report.aliasesAdded++;
    }
  }

  // legacy_id_maps: upsert; a map that pointed elsewhere is replaced and counted.
  const before = await repo.getMaps(
    tx,
    entity,
    mapped.map((m) => m.item.id),
  );
  report.remapped += mapped.filter((m) => {
    const prev = before.get(m.item.id);
    return prev !== undefined && prev !== m.targetId;
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
