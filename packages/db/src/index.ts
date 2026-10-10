/** @inmolink/db — Drizzle client, role pools, tenant scoping and migrations (PATTERNS §3). */
export {
  closeDb,
  configureDb,
  type Db,
  type DbConfig,
  dbEnv,
  getPgClient,
  type PoolOptions,
  pingDb,
  type Tx,
} from './client';
export { loadStackEnv } from './env-file';
export { type Listener, type ListenOptions, listen } from './listen';
export { DB_ROLES, type DbRoleName, type RuntimeRole } from './roles';
export { checkRls } from './tenancy/guard';
export {
  type GlobalTable,
  mergeRegistries,
  type PolicyKind,
  type PredicateSamples,
  registry,
  type SampleRow,
  type TenantRegistry,
  type TenantTable,
} from './tenancy/registry';
export { applyRls, expectedPolicies, generateRlsSql, helperSql, tablesSql } from './tenancy/rls';
export { type TenantScope, withAuth, withPublicRead, withSystem, withTenant } from './tenancy/scope';
