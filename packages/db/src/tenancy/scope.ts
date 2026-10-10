import { sql } from 'drizzle-orm';
import { assertSystemAllowed, dbConfig, dbLogger, getDb, type Tx } from '../client';

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
