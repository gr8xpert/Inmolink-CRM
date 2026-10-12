import { type Tx, withAuth, withTenant } from '@inmolink/db';
import type { UiLocale } from '@inmolink/i18n';

/** A UI locale code from `packages/i18n` (`locales.json`); validate input with `isUiLocale`. */
export type Locale = UiLocale;
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

/** Inmolink staff roles (PLAN §3 #2); `identity.STAFF_ROLES` is the runtime list. */
export type StaffRole = 'SUPER_ADMIN' | 'STAFF_SUPPORT' | 'STAFF_DATA_OPS';

/**
 * Context for staff work (S1-03, ADR 0015): no tenant — staff act across agencies — and a `withStaff`
 * transaction (`app_staff`, RLS on, staff predicates only). Staff use cases take this instead of `Ctx`;
 * a tenant `ctx` can never reach them, nor a staff `ctx` a tenant use case.
 */
export interface StaffCtx {
  tx: Tx;
  actor: { kind: 'staff'; userId: string; role: StaffRole };
  locale: Locale;
  requestId: string;
}

/**
 * Opens a fresh request transaction with a full `ctx` per call (an app passes `(fn) => withCtx(req, fn)`).
 * For use cases with network I/O between two short transactions (uploads: check, then store the file
 * outside any transaction, then record it) — like `AuthCtx.transaction` (CLAUDE.md rule 6).
 */
export type CtxRunner = <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>;

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
