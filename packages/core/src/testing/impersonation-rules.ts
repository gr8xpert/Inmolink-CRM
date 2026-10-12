import { expect } from 'vitest';
import type { Ctx } from '../context';
import type { ImpersonationRules } from '../impersonation';

/**
 * Checks a module's impersonation map (S1-09): it names exactly the module's actions, every `forbidden`
 * action is refused to an impersonated admin, and every `allowed` one gets the same answer as the admin
 * acting themselves. Fails when an action is added to the list without a decision.
 */
export function expectImpersonationRules<A extends string>(opts: {
  actions: readonly A[];
  rules: ImpersonationRules<A>;
  can: (ctx: Ctx, action: A) => boolean;
  admin: Ctx;
  staffUserId: string;
}): void {
  const { actions, rules, can, admin } = opts;
  expect(Object.keys(rules).sort()).toEqual([...actions].sort());
  if (admin.actor.kind !== 'user') throw new Error('expectImpersonationRules: admin must be a user');
  const impersonated: Ctx = { ...admin, actor: { ...admin.actor, impersonatedBy: opts.staffUserId } };
  for (const action of actions) {
    expect(['allowed', 'forbidden'], action).toContain(rules[action]);
    if (rules[action] === 'forbidden') expect(can(impersonated, action), action).toBe(false);
    else expect(can(impersonated, action), action).toBe(can(admin, action));
  }
}
