import type { RegisterInput } from '@inmolink/contracts';
import { setAuthScope, withAuth, withSystem } from '@inmolink/db';
import { newToken } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { authCtx, type Ctx } from '../context';
import * as identity from '../modules/identity';

/** Query budget checks (PATTERNS §20); `withSystem` for app tests' fixtures (worker-built read models, S7-03). */
export { countQueries, withSystem } from '@inmolink/db';
/**
 * The S6-08 fair-share model of the imports queue: the imports load test runs it at production scale, the S7-F2 perf
 * test against the real queue.
 */
export { rng, type SimFeed, type SimOptions, type SimResult, type SimRun, simulate } from './fair-share-sim';

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

/** Statements of `purgeReferenceFixtures`, each with the LIKE pattern as `$1`. Deepest locations first. */
const PURGE_REFERENCE_SQL = [
  'delete from location_groups where key like $1',
  ...[4, 3, 2, 1].map(
    (depth) => `delete from locations where depth = ${depth} and id in (
      with recursive t as (
        select location_id as id from location_translations where slug like $1
        union select l.id from locations l join t on l.parent_id = t.id
      ) select id from t)`,
  ),
  'delete from property_types where key like $1',
  'delete from property_type_groups where key like $1',
  'delete from features where key like $1',
  'delete from feature_groups where key like $1',
];

/**
 * Removes global reference fixtures (taxonomy) whose keys or slugs start with `prefix` (S3-F3). Call it in
 * `beforeAll` with the file's own prefix (`tree-`, `cat-`, …) to clear what earlier runs left behind: a fork that
 * crashed (0xC0000409 on Windows) never reached `afterAll`, and rows with fixed names then break later runs; and
 * in `afterAll` for this run's rows. A prefix must be specific to one test file, since files run in parallel.
 * `run` executes one statement — default `withSystem`; HTTP-role suites (no `withSystem`) pass `adminQuery`.
 */
export async function purgeReferenceFixtures(
  prefix: string,
  run?: (text: string, params: unknown[]) => Promise<unknown>,
): Promise<void> {
  if (!/^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(prefix)) throw new TypeError('purgeReferenceFixtures: prefix like "tree-"');
  const params = [`${prefix}%`];
  if (run) {
    for (const text of PURGE_REFERENCE_SQL) await run(text, params);
    return;
  }
  await withSystem('test.purge-fixtures', async (tx) => {
    for (const text of PURGE_REFERENCE_SQL) await tx.execute(sql.raw(text.replaceAll('$1', `'${params[0]}'`)));
  });
}

/** The white-label check (S7-02), shared with app tests (S7-F8 embed detail page). */
export { stringsOf, type WhiteLabelOwner, whiteLabelLeaks } from './white-label';
