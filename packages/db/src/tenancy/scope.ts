import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { assertSystemAllowed, dbConfig, dbLogger, getDb, getPgClient, type Tx } from '../client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantScope {
  agencyId: string;
  userId?: string;
}

/**
 * Request work for one agency, as `app_user` (RLS applies). Settings are transaction-local
 * (`set_config(…, true)`), so they vanish at commit/rollback — safe with PgBouncer transaction pooling.
 */
export async function withTenant<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(scope.agencyId)) throw new TypeError('withTenant: agencyId must be a UUID');
  if (scope.userId !== undefined && !UUID.test(scope.userId)) throw new TypeError('withTenant: userId must be a UUID');
  return getDb('app_user').transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.agency_id', ${scope.agencyId}, true),
                                set_config('app.user_id', ${scope.userId ?? ''}, true)`);
    return fn(tx);
  });
}

export interface SystemOptions {
  /**
   * High-frequency platform plumbing (outbox claim/ack every poll): the audit line is logged at
   * `debug`, not `info`. The reason is still set on the transaction.
   */
  routine?: boolean;
}

/**
 * Cross-tenant work as `app_system` (BYPASSRLS) — workers and scripts only, never request paths.
 * The reason is logged and set on the transaction (`app.system_reason`) for audit triggers.
 */
export async function withSystem<T>(
  reason: string,
  fn: (tx: Tx) => Promise<T>,
  options: SystemOptions = {},
): Promise<T> {
  assertSystemAllowed();
  if (reason.trim() === '') throw new TypeError('withSystem: a reason is required');
  dbLogger()[options.routine ? 'debug' : 'info']({ reason, appRole: dbConfig().APP_ROLE }, 'withSystem');
  return getDb('app_system').transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_reason', ${reason}, true)`);
    return fn(tx);
  });
}

/**
 * `withSystem()` for driver-level work (COPY streams, PATTERNS §13) on a raw `app_system` client.
 * Owns the transaction: begin, transaction-local `app.system_reason`, commit — or rollback and
 * destroy the client on error, so a connection in an unknown state (an aborted COPY) never returns
 * to the pool. `fn` must not commit, release or change session settings.
 */
export async function withSystemClient<T>(reason: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  assertSystemAllowed();
  if (reason.trim() === '') throw new TypeError('withSystemClient: a reason is required');
  dbLogger().info({ reason, appRole: dbConfig().APP_ROLE }, 'withSystem');
  const client = await getPgClient('app_system');
  try {
    await client.query('begin');
    await client.query(`select set_config('app.system_reason', $1, true)`, [reason]);
    const result = await fn(client);
    await client.query('commit');
    client.release();
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    try {
      client.release(err instanceof Error ? err : new Error(String(err)));
    } catch {
      // Already released (by a misbehaving `fn`): keep the original error.
    }
    throw err;
  }
}

/** Public read paths (feed-api, portal): `app_public`, read-only transaction, read models + PUBLIC_READ tables only. */
export async function withPublicRead<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb('app_public').transaction(fn, { accessMode: 'read only' });
}

/**
 * Anonymous auth flows (sign-up, login, verification, reset, access tokens) as `app_auth`: only the
 * identity tables (`access: 'auth'`) plus INSERT of platform outbox events. Allowed in request paths.
 */
export async function withAuth<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb('app_auth').transaction(fn);
}

export interface StaffScope {
  /** The staff member's `users.id`; `app_is_staff()` checks it against `staff_users` in every staff policy. */
  userId: string;
  /** Why (e.g. `agencies.decideVerification`): set on the transaction as `app.staff_reason` for audit triggers. */
  reason: string;
}

/**
 * Staff request paths (verification queue, staff console) as `app_staff` (S1-03, ADR 0015). RLS stays
 * on: only tables whose registry entry has `staff` predicates are reachable, and only while
 * `app.user_id` names an active staff member. No tenant is set. The caller has checked the staff role.
 */
export async function withStaff<T>(scope: StaffScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(scope.userId)) throw new TypeError('withStaff: userId must be a UUID');
  if (scope.reason.trim() === '') throw new TypeError('withStaff: a reason is required');
  return getDb('app_staff').transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${scope.userId}, true),
                                set_config('app.staff_reason', ${scope.reason}, true)`);
    return fn(tx);
  });
}

/**
 * Inside `withAuth()`: pins the rows the registry's `auth` predicates may reach to one agency and/or
 * user (`app.agency_id`, `app.user_id`, transaction-local). Sign-up sets the agency it is creating and
 * the new user; token minting sets only the user. Unset values match nothing.
 */
export async function setAuthScope(tx: Tx, scope: { agencyId?: string; userId?: string }): Promise<void> {
  if (scope.agencyId !== undefined && !UUID.test(scope.agencyId)) {
    throw new TypeError('setAuthScope: agencyId must be a UUID');
  }
  if (scope.userId !== undefined && !UUID.test(scope.userId))
    throw new TypeError('setAuthScope: userId must be a UUID');
  await tx.execute(sql`select set_config('app.agency_id', ${scope.agencyId ?? ''}, true),
                              set_config('app.user_id', ${scope.userId ?? ''}, true)`);
}
