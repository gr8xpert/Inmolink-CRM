import { closeDb, withSystem } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { setupTestDb } from '@inmolink/db/testing';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scaleCounts } from '../../scripts/seed/profile';
import { DEFAULT_DEMO_PASSWORD, runScaleSeed } from '../../scripts/seed/run';

// The local acceptance run for S0-13. Its runtime grows with every module seeder; the budget does not.
const SEED = 914;
const AGENCIES = 1_000;
const BUDGET_SECONDS = 15 * 60;
const pattern = `%@s${SEED}.scale.inmolink.test`;
const cleanup = () => withSystem('test.seed.cleanup', (tx) => tx.delete(users).where(like(users.email, pattern)));

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
