import type { Ctx } from './context';

/**
 * What staff impersonating a member may do (S1-09, PLAN §12, `.claude/rules/security.md`).
 *
 * Every module policy declares, for each of its actions, whether it is `allowed` or `forbidden` while
 * impersonating, in a map typed over the module's whole action union — so a new action does not compile
 * until someone decides — and `can()` asks `deniedByImpersonation` before anything else. A policy test per
 * module checks the map covers every action and that each forbidden one is refused.
 *
 * The rule of thumb: staff may look and fix the agency's own content (profile, notes); they never change
 * who has access or what the agency has agreed to — team and invites, API keys, settings (commission,
 * PIN policy), preferred partners, company details and verification, billing. 2FA and password changes
 * cannot be reached at all: they act on the web session's own user (the staff member, ADR 0004), and the
 * web refuses them while an impersonation is open.
 */
export type ImpersonationRule = 'allowed' | 'forbidden';
export type ImpersonationRules<A extends string> = { readonly [K in A]: ImpersonationRule };

/** The staff member acting as `ctx`'s user, or null for the user themselves (and non-user actors). */
export function impersonatorOf(ctx: Pick<Ctx, 'actor'>): string | null {
  return ctx.actor.kind === 'user' ? (ctx.actor.impersonatedBy ?? null) : null;
}

/** True when `ctx` is impersonated and `action` is not declared `allowed` (deny by default). */
export function deniedByImpersonation<A extends string>(
  ctx: Pick<Ctx, 'actor'>,
  rules: ImpersonationRules<A>,
  action: A,
): boolean {
  return impersonatorOf(ctx) !== null && rules[action] !== 'allowed';
}
