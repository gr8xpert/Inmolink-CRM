/**
 * Legacy load toolkit (S4-04; reused by S14-02 for listings, contacts, leads and media). PLAN §14 Path A step 3:
 * staged rows → validate → transform → merge per agency, `legacy_id_maps` for every loaded row, and a report whose
 * counts are checked against the extract's inventory (step 6). Everything here takes the `tx` of a `withSystem()`
 * call made by an operator script; nothing is guessed: a row that cannot be loaded is listed with a reason.
 */
import type { LegacyLoadCounts, LegacyLoadIssueReason, LegacyLoadReport } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import type { z } from 'zod';
import * as agencies from '../agencies';
import * as repo from './repo';

export type LegacyEntity = repo.LegacyEntity;

/** Starts an agency's report. */
export function newLoadReport(legacyAgencyId: string, agencyId: string, dryRun: boolean): LegacyLoadReport {
  return { legacyAgencyId, agencyId, dryRun, counts: {}, issues: [], matches: true };
}

/** The counts of one entity, created on first use. `legacyRows` is the inventory's count (null: none given). */
export function countsOf(report: LegacyLoadReport, entity: string, legacyRows: number | null = null): LegacyLoadCounts {
  report.counts[entity] ??= {
    legacyRows,
    staged: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    mapped: 0,
    matches: false,
  };
  return report.counts[entity];
}

/** Lists a row that is not loaded (once per entity and legacy id) and counts it as failed. */
export function addIssue(
  report: LegacyLoadReport,
  entity: string,
  legacyId: string,
  reason: LegacyLoadIssueReason,
  detail: string | null = null,
): void {
  report.issues.push({ entity, legacyId, reason, detail });
  countsOf(report, entity).failed += 1;
}

/** Counts a loaded row by what the run did to it. */
export function countOutcome(report: LegacyLoadReport, entity: string, outcome: 'created' | 'updated' | 'unchanged') {
  const c = countsOf(report, entity);
  c[outcome] += 1;
  c.mapped += 1;
}

/** Settles `matches`: every legacy row of every entity is mapped (against the inventory when one was given). */
export function finishReport(report: LegacyLoadReport): LegacyLoadReport {
  for (const c of Object.values(report.counts)) c.matches = c.mapped === (c.legacyRows ?? c.staged);
  report.matches = Object.values(report.counts).every((c) => c.matches);
  return report;
}

/**
 * Validates staged rows against `schema`: the valid ones once per legacy id (in staging order); invalid and
 * duplicate rows listed. A row without a usable id is listed under the id `#<line>`.
 */
export function validateRows<S extends z.ZodType<{ id: string }>>(
  report: LegacyLoadReport,
  entity: string,
  schema: S,
  rows: readonly unknown[],
): z.output<S>[] {
  const counts = countsOf(report, entity);
  counts.staged += rows.length;
  const seen = new Set<string>();
  const out: z.output<S>[] = [];
  rows.forEach((raw, i) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const rawId = (raw as { id?: unknown } | null)?.id;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : `#${i + 1}`;
      const issue = parsed.error.issues[0];
      addIssue(report, entity, id, 'invalid', issue ? `${issue.path.join('.')}: ${issue.message}` : null);
      return;
    }
    const row = parsed.data;
    if (seen.has(row.id)) {
      addIssue(report, entity, row.id, 'duplicate');
      return;
    }
    seen.add(row.id);
    out.push(row);
  });
  return out;
}

/** The v2 ids these legacy ids of one entity became (one statement per 1,000). */
export async function targetsOf(
  tx: Tx,
  entity: LegacyEntity,
  legacyIds: readonly string[],
): Promise<Map<string, string>> {
  const maps = await repo.getMaps(tx, entity, [...new Set(legacyIds)]);
  return new Map([...maps].map(([k, v]) => [k, v.newId]));
}

/** Records (or confirms) the v2 id of each loaded legacy row; a staff-set (`manual`) map is never overwritten. */
export async function recordMaps(
  tx: Tx,
  entity: LegacyEntity,
  pairs: Iterable<[legacyId: string, newId: string]>,
): Promise<void> {
  await repo.upsertMaps(
    tx,
    entity,
    [...pairs].map(([legacyId, target]) => ({ id: newId(), legacyId, newId: target, method: 'import' })),
  );
}

/**
 * The v2 agency a legacy agency became. `given` (the operator's `--agency <legacy>=<uuid>`) is recorded as a manual
 * map when none exists; a given agency that contradicts the recorded map is refused (an agency is never moved
 * silently). Neither → an error naming the legacy agency (an operator script's message).
 */
export async function resolveLegacyAgency(tx: Tx, legacyAgencyId: string, given?: string): Promise<string> {
  const known = (await repo.getMaps(tx, 'agency', [legacyAgencyId])).get(legacyAgencyId);
  if (known && given && known.newId !== given) {
    throw new Error(`legacy agency ${legacyAgencyId} is already mapped to another agency`);
  }
  if (known) return known.newId;
  if (!given) throw new Error(`legacy agency ${legacyAgencyId} has no v2 agency: pass --agency <legacy>=<uuid>`);
  if ((await agencies.getAgencyName(tx, given)) === null) throw new Error(`agency ${given} does not exist`);
  await repo.upsertMaps(tx, 'agency', [{ id: newId(), legacyId: legacyAgencyId, newId: given, method: 'manual' }]);
  return given;
}

class DryRun extends Error {}

/**
 * Runs `fn` in a savepoint; with `dryRun` the savepoint is rolled back after `fn` built its result, so a dry run
 * goes through every check and statement and leaves nothing behind.
 */
export async function inSavepoint<T>(tx: Tx, dryRun: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!dryRun) return tx.transaction(fn);
  let result: T | undefined;
  try {
    await tx.transaction(async (sp) => {
      result = await fn(sp);
      throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return result as T;
}

/** A URL slug: lower-case ASCII words joined by `-` (accents folded); empty when nothing is left. */
export function slugify(text: string, max = 80): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

/** A content locale as v2 stores it (`en`, `en-GB`), or null when the legacy code is not one. */
export function contentLocale(code: string): string | null {
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i.exec(code.trim());
  if (!m) return null;
  return m[2] ? `${(m[1] as string).toLowerCase()}-${m[2].toUpperCase()}` : (m[1] as string).toLowerCase();
}

/** A legacy enum value normalised for lookups: lower case, words joined by `_` (`Off-plan` → `off_plan`). */
export const enumKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Splits `items` into batches of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
