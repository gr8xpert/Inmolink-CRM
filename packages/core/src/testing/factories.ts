import type { RegisterInput } from '@inmolink/contracts';
import { setAuthScope, withAuth } from '@inmolink/db';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { authCtx, type Ctx } from '../context';
import * as identity from '../modules/identity';

/**
 * `ctx` as if staff member `staffUserId` impersonated its user (S1-09), without a session row: sets
 * `app.impersonated_by` on the transaction like `withMemberCtx` does for a live session, so audit rows
 * may (and must) name the staff member. For unit-level tests of what an impersonated actor may do; the
 * real path is covered in `identity/__tests__/impersonation.int.test.ts`.
 */
export async function impersonatedCtx(ctx: Ctx, staffUserId: string): Promise<Ctx> {
  if (ctx.actor.kind !== 'user') throw new Error('impersonatedCtx: only a user can be impersonated');
  await ctx.tx.execute(sql`select set_config('app.impersonated_by', ${staffUserId}, true)`);
  return { ...ctx, actor: { ...ctx.actor, impersonatedBy: staffUserId } };
}

/**
 * Test factories (`@inmolink/core/test`, source-only: never shipped). They go through the real
 * services and the request roles (`app_auth`), so they work in `http` tests where `withSystem` is refused.
 */

export interface Founder {
  userId: string;
  agencyId: string;
  email: string;
  password: string;
}

/** Signs up a founder (user + PENDING agency-of-one) and confirms the email. */
export async function createFounder(over: Partial<RegisterInput> = {}): Promise<Founder> {
  const input: RegisterInput = {
    email: `founder-${newToken(6).toLowerCase()}@example.com`,
    password: 'correct horse battery',
    name: 'Ana',
    locale: 'es',
    accountKind: 'AGENCY',
    companyName: 'Costa Homes S.L.',
    ...over,
  };
  await identity.register(authCtx(newId()), input);
  return withAuth(async (tx) => {
    const user = await tx.execute<{ id: string }>(
      sql`update users set email_verified_at = now() where email = ${input.email} returning id`,
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('createFounder: sign-up created no user');
    await setAuthScope(tx, { userId });
    const member = await tx.execute<{ agency_id: string }>(
      sql`select agency_id from agency_members where user_id = ${userId}`,
    );
    const agencyId = member.rows[0]?.agency_id;
    if (!agencyId) throw new Error('createFounder: sign-up created no agency');
    return { userId, agencyId, email: input.email, password: input.password };
  });
}
