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
import { agencyOfLegacy } from './legacy-rows';
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

/** Lists something left out of a row that was loaded all the same (an invalid phone, an unmapped feature). */
export function addWarning(
  report: LegacyLoadReport,
  entity: string,
  legacyId: string,
  reason: LegacyLoadIssueReason,
  detail: string | null = null,
): void {
  report.issues.push({ entity, legacyId, reason, detail });
}

const COUNT_KEYS = ['staged', 'created', 'updated', 'unchanged', 'failed', 'mapped'] as const;

/** Adds a batch's counts and issues to the agency's report (the inventory's `legacyRows` stay the agency's). */
export function mergeInto(
  report: LegacyLoadReport,
  part: { counts: Record<string, Partial<Record<(typeof COUNT_KEYS)[number], number>>>; issues: readonly unknown[] },
): void {
  for (const [entity, c] of Object.entries(part.counts)) {
    const into = countsOf(report, entity);
    for (const k of COUNT_KEYS) into[k] += c[k] ?? 0;
  }
  report.issues.push(...(part.issues as LegacyLoadReport['issues']));
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
    // A staging line that was not JSON (the script's reader marks it with its line number).
    const line = (raw as { __unparsableLine?: unknown } | null)?.__unparsableLine;
    if (typeof line === 'number') {
      addIssue(report, entity, `#${line}`, 'invalid', 'not JSON');
      return;
    }
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

/** Platform reference data (one map for every agency): the legacy taxonomy (S2-06). */
export type PlatformEntity = 'location' | 'propertyType' | 'feature';
/** An agency's own rows: a map is accepted only for the agency being loaded. */
export type TenantEntity = Exclude<LegacyEntity, PlatformEntity | 'agency'>;

/** The v2 ids these legacy taxonomy ids became (one statement per 1,000). */
export async function targetsOf(
  tx: Tx,
  entity: PlatformEntity,
  legacyIds: readonly string[],
): Promise<Map<string, string>> {
  const maps = await repo.getMaps(tx, entity, [...new Set(legacyIds)]);
  return new Map([...maps].map(([k, v]) => [k, v.newId]));
}

/**
 * The v2 rows of the agency these legacy ids became (`own`), and the legacy ids mapped to anything else (`foreign`:
 * another agency's row, or a map of unknown owner) — never followed, never re-pointed. One statement per 1,000.
 */
export async function agencyTargets(
  tx: Tx,
  entity: TenantEntity,
  legacyIds: readonly string[],
  agencyId: string,
): Promise<{ own: Map<string, string>; foreign: Set<string> }> {
  const own = new Map<string, string>();
  const foreign = new Set<string>();
  for (const [k, v] of await repo.getMaps(tx, entity, [...new Set(legacyIds)])) {
    if (v.targetAgencyId === agencyId) own.set(k, v.newId);
    else foreign.add(k);
  }
  return { own, foreign };
}

/** The rows whose legacy id is mapped to another agency's row, listed as collisions; the rest kept. */
export function dropCollisions<T extends { id: string }>(
  report: LegacyLoadReport,
  entity: string,
  rows: readonly T[],
  foreign: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => {
    if (!foreign.has(r.id)) return true;
    addIssue(report, entity, r.id, 'legacy_id_collision');
    return false;
  });
}

/** Records (or confirms) the v2 id of each legacy taxonomy row; a staff-set (`manual`) map is never overwritten. */
export async function recordMaps(
  tx: Tx,
  entity: PlatformEntity,
  pairs: Iterable<[legacyId: string, newId: string]>,
): Promise<void> {
  await repo.upsertMaps(
    tx,
    entity,
    [...pairs].map(([legacyId, target]) => ({ id: newId(), legacyId, newId: target, method: 'import' })),
  );
}

/**
 * Records (or confirms) the v2 row of the agency each loaded legacy row became. A map of another agency's row is never
 * re-pointed (the loaders drop those rows first: `agencyTargets`, `dropCollisions`).
 */
export async function recordAgencyMaps(
  tx: Tx,
  entity: TenantEntity,
  agencyId: string,
  pairs: Iterable<[legacyId: string, newId: string, method?: AgencyMapMethod]>,
): Promise<void> {
  await repo.upsertMaps(
    tx,
    entity,
    [...pairs].map(([legacyId, target, method]) => ({
      id: newId(),
      legacyId,
      newId: target,
      method: method ?? AGENCY_MAP_METHOD.imported,
      targetAgencyId: agencyId,
    })),
  );
}

/**
 * How a tenant row's map was made (`legacy_id_maps.method`): the load created the row (`import`), or matched one that
 * was there before it (`matched`, S14 review: users matched by e-mail to an existing member, or a second legacy user
 * with the e-mail of the first). A later `matched` answer never downgrades a map of the same row (`upsertMaps`): a
 * re-run finds the members it created, and they stay `import` — the ones the cutover mails.
 */
export const AGENCY_MAP_METHOD = { imported: 'import', matched: 'matched' } as const;
export type AgencyMapMethod = (typeof AGENCY_MAP_METHOD)[keyof typeof AGENCY_MAP_METHOD];

/** An operator-facing refusal of the load: its message names ids only, never row data (safe to print and store). */
export class LegacyMigrationError extends Error {
  override name = 'LegacyMigrationError';
}

/**
 * The v2 agency a legacy agency became. `given` (the operator's `--agency <legacy>=<uuid>`) is recorded as a manual
 * map when none exists; a given agency that contradicts the recorded map is refused (an agency is never moved
 * silently), and so is an agency another legacy agency already became (one to one). Neither → an error naming the
 * legacy agency (an operator script's message).
 */
export async function resolveLegacyAgency(tx: Tx, legacyAgencyId: string, given?: string): Promise<string> {
  const known = await agencyOfLegacy(tx, legacyAgencyId);
  if (known && given && known !== given) {
    throw new LegacyMigrationError(`legacy agency ${legacyAgencyId} is already mapped to another agency`);
  }
  if (known) return known;
  if (!given)
    throw new LegacyMigrationError(`legacy agency ${legacyAgencyId} has no v2 agency: pass --agency <legacy>=<uuid>`);
  if ((await agencies.getAgencyName(tx, given)) === null)
    throw new LegacyMigrationError(`agency ${given} does not exist`);
  // One to one: a v2 agency is the target of one legacy agency only (two legacy agencies never merge silently).
  if ((await repo.legacyIdsOf(tx, 'agency', given, 1)).length > 0) {
    throw new LegacyMigrationError(`agency ${given} is already the target of another legacy agency`);
  }
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

/**
 * What a failed batch records (checkpoint, report, logs): the error's code, the constraint it broke and the batch's
 * first legacy id — never the message, which may quote the row's values (names, e-mails).
 */
export function failureOf(err: unknown, firstLegacyId: string | null): string {
  if (err instanceof LegacyMigrationError) return err.message;
  const cause = (err as { cause?: { code?: unknown; constraint?: unknown } } | null)?.cause;
  const pg = err as { code?: unknown; constraint?: unknown } | null;
  const dbCode = typeof cause?.code === 'string' ? cause.code : typeof pg?.code === 'string' ? pg.code : null;
  const constraint =
    typeof cause?.constraint === 'string'
      ? cause.constraint
      : typeof pg?.constraint === 'string'
        ? pg.constraint
        : null;
  const appCode = (err as { code?: unknown } | null)?.code;
  const code =
    dbCode && /^[0-9A-Z]{5}$/.test(dbCode)
      ? `DB_${dbCode}`
      : typeof appCode === 'string' && /^[A-Z_]{2,60}$/.test(appCode)
        ? appCode
        : err instanceof Error
          ? err.name
          : 'UNKNOWN';
  return [
    `code=${code}`,
    ...(constraint && /^[a-z0-9_]{1,63}$/.test(constraint) ? [`constraint=${constraint}`] : []),
    ...(firstLegacyId ? [`first=${firstLegacyId.slice(0, 100)}`] : []),
  ].join(' ');
}
