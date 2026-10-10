import { type Tx, withTenant } from '@inmolink/db';

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
 * Opens `withTenant` for the caller's agency (RLS applies) and runs `fn` with a full `ctx`.
 * Apps call it once per request through `app.withCtx` (PATTERNS §10).
 */
export function withRequestCtx<T>(init: RequestCtx, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const userId = init.actor.kind === 'user' ? init.actor.userId : undefined;
  return withTenant({ agencyId: init.tenant.agencyId, userId }, (tx) => fn({ ...init, tx }));
}
