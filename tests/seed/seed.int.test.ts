import { closeDb, withSystem } from '@inmolink/db';
import { users } from '@inmolink/db/schema/identity';
import { setupTestDb } from '@inmolink/db/testing';
import { verifyPassword } from '@inmolink/platform/crypto/password';
import { isUuidV7 } from '@inmolink/platform/ids';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_DOMAIN, demoEmail } from '../../scripts/seed/identity';
import { scaleCounts } from '../../scripts/seed/profile';
import { seededId } from '../../scripts/seed/rng';
import { assertSeedTarget, DEFAULT_DEMO_PASSWORD, runDevSeed, runScaleSeed } from '../../scripts/seed/run';

// A seed no other suite uses, so its rows are this file's alone.
const SEED = 913;
const scaleDomain = `%@s${SEED}.scale.inmolink.test`;
const demoDomain = `%.${DEMO_DOMAIN}`;

const removeUsers = (pattern: string) =>
  withSystem('test.seed.cleanup', (tx) => tx.delete(users).where(like(users.email, pattern)));

const snapshot = (pattern: string) =>
  withSystem('test.seed.snapshot', (tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name, locale: users.locale })
      .from(users)
      .where(like(users.email, pattern))
      .orderBy(asc(users.id)),
  );

const scale = (agencies: number, chunk: number) =>
  runScaleSeed({ agencies, seed: SEED, chunk, scalePassword: DEFAULT_DEMO_PASSWORD });

beforeAll(async () => {
  await setupTestDb('script');
  await removeUsers(scaleDomain);
  await removeUsers(demoDomain); // the timing check must measure a seed that writes every row
}, 180_000);
afterAll(async () => {
  await removeUsers(scaleDomain);
  await removeUsers(demoDomain);
  await closeDb();
});

describe('generator', () => {
  it('[S0-13] seeded IDs are deterministic UUIDv7s, distinct per seed and namespace', () => {
    const id = seededId(1, 'identity.users', 42);
    expect(isUuidV7(id)).toBe(true);
    expect(seededId(1, 'identity.users', 42)).toBe(id);
    expect(seededId(2, 'identity.users', 42)).not.toBe(id);
    expect(seededId(1, 'contacts.contacts', 42)).not.toBe(id);
    expect(seededId(1, 'identity.users', 41) < id).toBe(true);
  });

  it('[S0-13] scale profile follows the PLAN §4.1 ratios', () => {
    expect(scaleCounts(5_000)).toEqual({
      agencies: 5_000,
      users: 25_000,
      listings: 900_000,
      media: 27_000_000,
      contacts: 10_000_000,
      clientProfiles: 1_000_000,
      feedConnections: 5_000,
    });
  });

  it('[S0-13] with NODE_ENV=production only the scale seed runs: --staging, DEPLOY_ENV=staging and a non-default password', async () => {
    const prev = { NODE_ENV: process.env.NODE_ENV, DEPLOY_ENV: process.env.DEPLOY_ENV };
    process.env.NODE_ENV = 'production';
    const staging = (allowStaging: boolean, scalePassword: string) => () =>
      assertSeedTarget({ allowStaging, scalePassword });
    try {
      delete process.env.DEPLOY_ENV;
      expect(() => assertSeedTarget()).toThrow(/NODE_ENV=production/);
      await expect(runDevSeed({ demoPassword: 'x' })).rejects.toThrow(/refusing to seed/);
      expect(staging(false, 'a-real-secret')).toThrow(/pass --staging/);
      expect(staging(true, 'a-real-secret')).toThrow(/DEPLOY_ENV/);
      process.env.DEPLOY_ENV = 'production';
      expect(staging(true, 'a-real-secret')).toThrow(/DEPLOY_ENV/);
      process.env.DEPLOY_ENV = 'staging';
      expect(staging(true, DEFAULT_DEMO_PASSWORD)).toThrow(/SEED_SCALE_PASSWORD/);
      expect(() => assertSeedTarget()).toThrow(/NODE_ENV=production/); // dev seed never
      expect(staging(true, 'a-real-secret')).not.toThrow();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('dev seed', () => {
  it('[S0-13] dev seed completes in < 30 s and prints working demo logins', async () => {
    const report = await runDevSeed({ demoPassword: DEFAULT_DEMO_PASSWORD });
    expect(report.seconds).toBeLessThan(30);
    expect(report.logins).toHaveLength(25);
    expect(new Set(report.logins.map((l) => l.agency)).size).toBe(5);
    expect(report.results['identity.users']).toEqual({ inserted: 25, total: 25, logins: report.logins });

    const [admin] = await withSystem('test.seed.login', (tx) =>
      tx
        .select({ hash: users.passwordHash, verified: users.emailVerifiedAt, status: users.status })
        .from(users)
        .where(eq(users.email, demoEmail(0, 'admin'))),
    );
    expect(admin?.status).toBe('ACTIVE');
    expect(admin?.verified).not.toBeNull();
    expect(await verifyPassword(admin?.hash ?? '', DEFAULT_DEMO_PASSWORD)).toBe(true);
  }, 60_000);

  it('[S0-13] re-running the dev seed is idempotent', async () => {
    await runDevSeed({ demoPassword: DEFAULT_DEMO_PASSWORD });
    const before = await snapshot(demoDomain);
    const again = await runDevSeed({ demoPassword: DEFAULT_DEMO_PASSWORD });
    expect(again.results['identity.users']).toMatchObject({ inserted: 0, total: 25 });
    expect(await snapshot(demoDomain)).toEqual(before);
  }, 60_000);
});

describe('scale seed', () => {
  it('[S0-13] scale seed writes §4.1 ratios via COPY and re-running it is idempotent', async () => {
    const first = await scale(40, 7);
    expect(first.results['identity.users']).toEqual({ inserted: 200, total: 200 });
    const before = await snapshot(scaleDomain);

    const again = await scale(40, 7);
    expect(again.results['identity.users']).toEqual({ inserted: 0, total: 200 });
    expect(await snapshot(scaleDomain)).toEqual(before);

    // A partial earlier run is completed, not duplicated: agencies a3 and a30–a39 (11 × 5 users) are missing.
    await withSystem('test.seed.partial', (tx) => tx.delete(users).where(like(users.email, `a3%-u%@s${SEED}.%`)));
    const resumed = await scale(40, 7);
    expect(resumed.results['identity.users']).toEqual({ inserted: 55, total: 200 });
    expect(await snapshot(scaleDomain)).toEqual(before);
  }, 120_000);

  it('[S0-13] scale seed is deterministic with a seed, whatever the chunk size', async () => {
    await scale(40, 7);
    const before = await snapshot(scaleDomain);
    await removeUsers(scaleDomain);
    await scale(40, 100);
    expect(await snapshot(scaleDomain)).toEqual(before);
  }, 120_000);
});
