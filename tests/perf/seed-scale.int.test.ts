import { closeDb, withSystem } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { setupTestDb } from '@inmolink/db/testing';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { identityUsers } from '../../scripts/seed/identity';
import { scaleCounts } from '../../scripts/seed/profile';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../../scripts/seed/run';

// The local acceptance run for S0-13. Its runtime grows with every module seeder; the budget does not.
const SEED = 914;
const AGENCIES = 1_000;
const BUDGET_SECONDS = 15 * 60;
/** S1-F6: the S0 review measured the users phase at 25k users in 15.2 s; the task asks for ≥ 5× faster. */
const USERS_SEED = 916;
const USERS_BUDGET_SECONDS = 15.2 / 5;
const cleanupSeed = (seed: number) =>
  withSystem('test.seed.cleanup', (tx) => tx.delete(users).where(like(users.email, `%@s${seed}.scale.inmolink.test`)));
const cleanup = async () => {
  await cleanupSeed(SEED);
  await cleanupSeed(USERS_SEED);
};

beforeAll(async () => {
  await setupTestDb('script');
  await cleanup();
}, 180_000);
afterAll(async () => {
  await cleanup();
  await closeDb();
});

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
