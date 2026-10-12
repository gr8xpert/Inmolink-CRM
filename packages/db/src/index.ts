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
  type AuthAccess,
  type GlobalTable,
  mergeRegistries,
  type PolicyKind,
  type PredicateSamples,
  registry,
  SAMPLE_READER,
  type SampleRow,
  type StaffAccess,
  type TenantRegistry,
  type TenantTable,
} from './tenancy/registry';
export { applyRls, expectedPolicies, generateRlsSql, helperSql, tablesSql } from './tenancy/rls';
export {
  type StaffScope,
  type SystemOptions,
  setAuthScope,
  type TenantScope,
  withAuth,
  withPublicRead,
  withStaff,
  withSystem,
  withSystemClient,
  withTenant,
} from './tenancy/scope';
