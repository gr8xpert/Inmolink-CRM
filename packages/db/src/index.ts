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
export { type CountQueriesOptions, countQueries } from './query-count';
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
  SAMPLE_USER,
  type SampleRow,
  type StaffAccess,
  staffRoleSql,
  type TenantRegistry,
  type TenantTable,
} from './tenancy/registry';
export {
  applyRls,
  expectedPolicies,
  generateRlsSql,
  helperSql,
  publicHiddenColumnsOf,
  tablesSql,
} from './tenancy/rls';
export {
  type PublicReadOptions,
  type StaffScope,
  type SystemOptions,
  setAuthScope,
  type TenantScope,
  withAuth,
  withGlobalRead,
  withIntake,
  withMedia,
  withPublicRead,
  withStaff,
  withSystem,
  withSystemClient,
  withTenant,
} from './tenancy/scope';
