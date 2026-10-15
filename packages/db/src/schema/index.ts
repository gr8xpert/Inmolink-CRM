/**
 * Drizzle schema barrel. One file per owning module (`schema/<module>.ts`), re-exported here so
 * the client gets typed relational queries. drizzle-kit reads `src/schema/*.ts` directly.
 */

export * from './agencies';
export * from './billing';
export * from './compliance';
export * from './flags';
export * from './identity';
export * from './media';
export * from './migration';
export * from './outbox';
export * from './properties';
export * from './taxonomy';
