/** @inmolink/db — Drizzle client, role pools, tenant scoping and migrations (PATTERNS §3). */
export { closeDb, configureDb, type Db, type DbConfig, dbEnv, getPgClient, type PoolOptions, type Tx } from './client';
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
export { type TenantScope, withPublicRead, withSystem, withTenant } from './tenancy/scope';
