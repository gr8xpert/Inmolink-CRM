import { sql } from 'drizzle-orm';
import { type Clock, clock as processClock } from '../clock';
import { AppError } from '../errors';
import type { SqlExecutor } from '../sql';

/**
 * Feature flags (PLAN §3 #42): ship dark → pilot agencies → everyone. Rows live in the global
 * `feature_flags` table (`@inmolink/db` schema/flags.ts — keep column names in sync). Every flag is
 * loaded in one query and kept in process for 60 s, so `flag()` costs no query on a warm process.
 * Other processes see a change within 60 s.
 *
 * Dashboard and workers only: `app_public` (feed-api, portal) has no grant on `feature_flags`.
 */

/** The part of `ctx` (PATTERNS §4) flags need — structural, so platform does not depend on core. */
export interface FlagCtx {
  tx: SqlExecutor;
  tenant?: { agencyId: string } | null;
}

interface FlagRow {
  enabled: boolean;
  enabledFor: ReadonlySet<string>;
  disabledFor: ReadonlySet<string>;
}

const KEY_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs a short read-only transaction of its own (`withGlobalRead` in `@inmolink/db`). */
export type FlagReader = <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

let ttlMs = 60_000;
let flagClock: Clock = processClock;
let reader: FlagReader | undefined;
let snapshot: { flags: Map<string, FlagRow>; expiresAt: number } | undefined;
let reloading: Promise<Map<string, FlagRow>> | undefined;
/** Bumped by invalidation, so a reload that started before it does not store its stale rows. */
let generation = 0;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new TypeError(`invalid flag key "${key.slice(0, 40)}"`);
}

function assertAgency(agencyId: string): void {
  if (!UUID_RE.test(agencyId)) throw new TypeError('agencyId must be a UUID');
}

/** Tests only: TTL and clock. */
export function configureFlags(options: { ttlSeconds?: number; clock?: Clock } = {}): void {
  ttlMs = (options.ttlSeconds ?? 60) * 1_000;
  flagClock = options.clock ?? processClock;
  snapshot = undefined;
  reloading = undefined;
  generation++;
}

/**
 * Where reloads run (S1-F3). With a reader, the 60-second reload is a short read of its own instead of a
 * statement on the first caller's transaction: a request whose transaction has already failed (Postgres
 * refuses every further statement in it) can still read flags, and does not fail the concurrent requests
 * that share its reload. Apps set it at boot through `configureDb` in `@inmolink/core`; without it (unit
 * tests, scripts) the reload runs on the caller's `ctx.tx`.
 */
export function configureFlagReader(read: FlagReader | undefined): void {
  reader = read;
}

/**
 * Drops this process's copy; the next `flag()` reloads. Call it after the transaction that wrote a
 * flag has committed — inside it, a concurrent request could reload the old rows and keep them 60 s.
 */
export function invalidateFlags(): void {
  snapshot = undefined;
  reloading = undefined;
  generation++;
}

const toSet = (v: unknown): ReadonlySet<string> =>
  new Set(Array.isArray(v) ? v.map((id) => String(id).toLowerCase()) : []);

async function load(tx: SqlExecutor): Promise<Map<string, FlagRow>> {
  const current = snapshot;
  if (current && current.expiresAt > flagClock.nowMs()) return current.flags;
  // Concurrent requests on an expired snapshot share one reload.
  if (!reloading) {
    const read = reader;
    const p = (read ? read((own) => fetchFlags(own)) : fetchFlags(tx)).finally(() => {
      if (reloading === p) reloading = undefined;
    });
    reloading = p;
  }
  // Stale while revalidating (own-read mode): an expired snapshot is served while the reload runs, so a
  // request never waits for a pool slot the reload cannot get, and a failed reload keeps the last rows.
  if (current && reader) {
    reloading.catch(() => undefined);
    return current.flags;
  }
  return reloading;
}

async function fetchFlags(tx: SqlExecutor): Promise<Map<string, FlagRow>> {
  const started = generation;
  const { rows } = await tx.execute(sql`select key, enabled, enabled_for, disabled_for from feature_flags`);
  const flags = new Map<string, FlagRow>();
  for (const r of rows) {
    flags.set(String(r.key), {
      enabled: r.enabled === true,
      enabledFor: toSet(r.enabled_for),
      disabledFor: toSet(r.disabled_for),
    });
  }
  if (started === generation) snapshot = { flags, expiresAt: flagClock.nowMs() + ttlMs };
  return flags;
}

/**
 * Whether `key` is on for the caller's agency: its override if any (`disabled_for` wins), else the
 * flag's default. Unknown flags are off.
 */
export async function flag(ctx: FlagCtx, key: string): Promise<boolean> {
  assertKey(key);
  const row = (await load(ctx.tx)).get(key);
  if (!row) return false;
  const agencyId = ctx.tenant?.agencyId?.toLowerCase();
  if (agencyId) {
    if (row.disabledFor.has(agencyId)) return false;
    if (row.enabledFor.has(agencyId)) return true;
  }
  return row.enabled;
}

/**
 * Creates or updates a flag's default. Staff only — `tx` must come from `withSystem()`; call
 * `invalidateFlags()` after it commits.
 */
export async function setFlag(tx: SqlExecutor, key: string, values: { enabled: boolean; description?: string }) {
  assertKey(key);
  await tx.execute(sql`
    insert into feature_flags (key, enabled, description) values (${key}, ${values.enabled}, ${values.description ?? ''})
    on conflict (key) do update set enabled = excluded.enabled,
      description = coalesce(${values.description ?? null}, feature_flags.description), updated_at = now()`);
}

/**
 * Sets (`true`/`false`) or clears (`null`) one agency's override. Staff only — `tx` from `withSystem()`;
 * call `invalidateFlags()` after it commits. Throws `NOT_FOUND` for an unknown flag.
 */
export async function setFlagOverride(tx: SqlExecutor, key: string, agencyId: string, enabled: boolean | null) {
  assertKey(key);
  assertAgency(agencyId);
  const { rows } = await tx.execute(sql`
    update feature_flags set
      enabled_for = array_remove(enabled_for, ${agencyId}::uuid)
        || case when ${enabled}::boolean is true then array[${agencyId}::uuid] else '{}'::uuid[] end,
      disabled_for = array_remove(disabled_for, ${agencyId}::uuid)
        || case when ${enabled}::boolean is false then array[${agencyId}::uuid] else '{}'::uuid[] end,
      updated_at = now()
    where key = ${key}
    returning key`);
  if (rows.length === 0) throw new AppError('NOT_FOUND', { flag: key });
}
