import { expect } from 'vitest';
import type { Ctx } from '../context';

/**
 * Pins a module's Client Mode allow-list (S13-F4, PLAN §3 #56): `allowed` must be exactly `pinned`, and a member in
 * Client Mode may do exactly those actions — every other action of the module is refused, whatever the role. Adding
 * an action to the allow-list (or a policy branch that lets a Client Mode session through) fails this until the pin
 * is changed on purpose, in review.
 */
export function expectClientModePinned<A extends string>(opts: {
  actions: readonly A[];
  allowed: ReadonlySet<A>;
  pinned: readonly A[];
  can: (ctx: Ctx, action: A) => boolean;
  /** The most privileged member of the module (an admin): Client Mode must still refuse it everything else. */
  admin: Ctx;
}): void {
  const { actions, allowed, pinned, can, admin } = opts;
  expect([...allowed].sort()).toEqual([...pinned].sort());
  for (const action of pinned) expect(actions, action).toContain(action);
  const inClientMode: Ctx = { ...admin, clientMode: true };
  expect(actions.filter((action) => can(inClientMode, action)).sort()).toEqual([...pinned].sort());
}
