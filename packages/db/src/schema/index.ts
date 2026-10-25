/**
 * Drizzle schema barrel. One file per owning module (`schema/<module>.ts`), re-exported here so
 * the client gets typed relational queries. drizzle-kit reads `src/schema/*.ts` directly.
 */

export * from './agencies';
export * from './ai';
export * from './ai-features';
export * from './billing';
export * from './chat';
export * from './compliance';
export * from './crm';
export * from './developments';
export * from './exports';
export * from './flags';
export * from './identity';
export * from './imports';
export * from './jobs';
export * from './matching';
export * from './media';
export * from './migration';
export * from './mls';
export * from './network';
export * from './notifications';
export * from './outbox';
export * from './properties';
export * from './quality';
export * from './search';
export * from './taxonomy';
export * from './websites';
