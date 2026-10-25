import { closeDb, withSystem } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { setupTestDb } from '@inmolink/db/testing';
import { like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { identityUsers } from '../../scripts/seed/identity';
import { scaleCounts } from '../../scripts/seed/profile';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../../scripts/seed/run';
import { removeSeededTaxonomy } from '../../scripts/seed/taxonomy';

// The local acceptance run for S0-13. Its runtime grows with every module seeder; the budget does not.
const SEED = 914;
const AGENCIES = 1_000;
const BUDGET_SECONDS = 15 * 60;
/** S1-F6: the S0 review measured the users phase at 25k users in 15.2 s; the task asks for ≥ 5× faster. */
const USERS_SEED = 916;
const USERS_BUDGET_SECONDS = 15.2 / 5;
/**
 * Seeded users, and first the listings they own (S3-F6: a listing's owner must stay a member). The listings are found
 * through the members' `(agency_id, owner_user_id)` (index `properties_agency_owner_raw_idx`, not a scan of every listing)
 * and deleted in batches, each in its own transaction under the worker statement timeout (S10-F10: one statement
 * over the whole table timed out in CI after the 1,000-agency delete left it bloated).
 */
const CLEANUP_BATCH = 5_000;
const cleanupSeed = async (seed: number) => {
  const pattern = `%@s${seed}.scale.inmolink.test`;
  for (;;) {
    const deleted = await withSystem('test.seed.cleanup', async (tx) => {
      const { rows } = await tx.execute(sql`
        with doomed as (
          select p.id from agency_members m
          join users u on u.id = m.user_id and u.email like ${pattern}
          join properties p on p.agency_id = m.agency_id and p.owner_user_id = m.user_id
          limit ${CLEANUP_BATCH}
        )
        delete from properties where id in (select id from doomed) returning 1`);
      return rows.length;
    });
    if (deleted < CLEANUP_BATCH) break;
  }
  await withSystem('test.seed.cleanup', (tx) => tx.delete(users).where(like(users.email, pattern)));
};
const cleanup = async () => {
  const started = performance.now();
  await cleanupSeed(SEED);
  await cleanupSeed(USERS_SEED);
  // its Spain-sized tree would double what other tests load (the taxonomy reload measures the whole table)
  await removeSeededTaxonomy(SEED);
  console.log(`[S10-F10] scale seed cleanup: ${((performance.now() - started) / 1000).toFixed(1)} s`);
};

/** Removing a 1,000-agency seed (listings and their cascades) takes minutes; each statement stays short. */
const CLEANUP_TIMEOUT_MS = 600_000;
beforeAll(async () => {
  await setupTestDb('script');
  await cleanup();
}, CLEANUP_TIMEOUT_MS);
afterAll(async () => {
  await cleanup();
  await closeDb();
}, CLEANUP_TIMEOUT_MS);

it(
  '[S0-13] --agencies=1000 completes locally in < 15 min',
  async () => {
    const report = await runScaleSeed({
      agencies: AGENCIES,
      seed: SEED,
      chunk: 100,
      scalePassword: DEFAULT_DEMO_PASSWORD,
    });
    console.log(`[S0-13] scale seed --agencies=${AGENCIES}: ${report.seconds.toFixed(1)} s`, report.results);
    expect(report.seconds).toBeLessThan(BUDGET_SECONDS);
    expect(report.results['identity.users']?.total).toBe(scaleCounts(AGENCIES).users);
  },
  BUDGET_SECONDS * 1000 + 60_000,
);

it('[S1-F6] --agencies=5000 users phase runs ≥ 5× faster (25k users in < 3.04 s)', async () => {
  const started = performance.now();
  const result = await identityUsers.scale({
    agencies: 5_000,
    seed: USERS_SEED,
    chunk: 100,
    scalePassword: DEFAULT_DEMO_PASSWORD,
  });
  const seconds = (performance.now() - started) / 1000;
  console.log(`[S1-F6] users phase --agencies=5000: ${seconds.toFixed(2)} s`);
  expect(result).toEqual({ inserted: 25_000, total: 25_000 });
  expect(seconds).toBeLessThan(USERS_BUDGET_SECONDS);
}, 60_000);
