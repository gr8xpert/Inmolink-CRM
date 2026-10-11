import { type Tx, withAuth, withTenant } from '@inmolink/db';

/** Locale code from `packages/i18n` config (S0-11 narrows this). */
export type Locale = string;
/** Plan key from the plan catalog — plans are data, not constants (STATUS decision). */
export type PlanTier = string;
/** Role key; the identity module (S1) defines the set. */
export type Role = string;

export type Actor =
  | { kind: 'user'; userId: string; role: Role; impersonatedBy?: string }
  | { kind: 'apiKey'; keyId: string; siteId: string; scopes: string[] }
  | { kind: 'system'; reason: string };

/** Every service function takes this (PATTERNS §4). Never read tenant or user from globals. */
export interface Ctx {
  tx: Tx;
  tenant: { agencyId: string; verified: boolean; plan: PlanTier; locales: Locale[] };
  actor: Actor;
  locale: Locale;
  requestId: string;
  clientMode: boolean;
}

/** What an app knows about the caller before the transaction opens. */
export type RequestCtx = Omit<Ctx, 'tx'>;

/**
 * Context for anonymous auth flows (sign-up, login, email links, access tokens — S0-09): no tenant
 * and no actor yet. It carries a transaction runner (`withAuth`, role `app_auth`) instead of an open
 * `tx`, so services hash and verify passwords (tens of ms of CPU) before opening a transaction.
 */
export interface AuthCtx {
  requestId: string;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function authCtx(requestId: string): AuthCtx {
  return { requestId, transaction: withAuth };
}

/**
 * Opens `withTenant` for an already-known caller (RLS applies) and runs `fn` with a full `ctx`.
 * Request paths use `withMemberCtx` (member.ts), which reads role and status from the database.
 */
export function withRequestCtx<T>(init: RequestCtx, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const userId = init.actor.kind === 'user' ? init.actor.userId : undefined;
  return withTenant({ agencyId: init.tenant.agencyId, userId }, (tx) => fn({ ...init, tx }));
}
