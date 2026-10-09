/** @inmolink/db — Drizzle client, role pools, tenant scoping and migrations (PATTERNS §3). */
export { closeDb, configureDb, type Db, type DbConfig, dbEnv, getPgClient, type PoolOptions, type Tx } from './client';
export { DB_ROLES, type DbRoleName, type RuntimeRole } from './roles';
export { type TenantScope, withPublicRead, withSystem, withTenant } from './tenancy/scope';
