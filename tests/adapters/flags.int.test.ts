import { closeDb, type Tx, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { createFakeClock } from '@inmolink/platform/clock';
import { configureFlags, flag, invalidateFlags, setFlag, setFlagOverride } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import type { SqlExecutor } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const KEY = `test.pilot-${run}`;
const agencyA = newId();
const agencyB = newId();
const agencyC = newId();
const clock = createFakeClock(Date.UTC(2026, 9, 10));

// Flags are written by staff through withSystem (a script role here); requests read as app_user.
const asTenant = (agencyId: string) => withTenant({ agencyId }, (tx: Tx) => flag({ tx, tenant: { agencyId } }, KEY));

/** Staff write: withSystem, then drop this process's copy once committed. */
async function staff(fn: (tx: SqlExecutor) => Promise<void>): Promise<void> {
  await withSystem('test.flags', (tx: Tx) => fn(tx));
  invalidateFlags();
}

beforeAll(async () => {
  await setupTestDb('script');
  configureFlags({ clock });
  await staff((tx) => setFlag(tx, KEY, { enabled: false, description: 'S0-07 test' }));
});

afterAll(async () => {
  await withSystem('test.flags.cleanup', (tx) =>
    tx.execute(sql`delete from feature_flags where key like ${`test.%-${run}`}`),
  );
  configureFlags();
  await closeDb();
});

describe('feature flags', () => {
  it('[S0-07] flag override for one agency does not affect others', async () => {
    await staff((tx) => setFlagOverride(tx, KEY, agencyA, true));
    expect(await asTenant(agencyA)).toBe(true);
    expect(await asTenant(agencyB)).toBe(false);

    // Default on, one agency opted out.
    await staff(async (tx) => {
      await setFlag(tx, KEY, { enabled: true });
      await setFlagOverride(tx, KEY, agencyB, false);
    });
    expect(await asTenant(agencyA)).toBe(true);
    expect(await asTenant(agencyB)).toBe(false);
    expect(await asTenant(agencyC)).toBe(true);

    // Clearing the override returns the agency to the default.
    await staff((tx) => setFlagOverride(tx, KEY, agencyB, null));
    expect(await asTenant(agencyB)).toBe(true);
  });

  it('[S0-07] flags are cached for 60 s, then reloaded', async () => {
    await staff((tx) => setFlag(tx, KEY, { enabled: false }));
    await staff((tx) => setFlagOverride(tx, KEY, agencyA, null));
    expect(await asTenant(agencyC)).toBe(false);

    // Another process changes the flag directly: this process keeps its copy for 60 s.
    await withSystem('test.flags', (tx) => tx.execute(sql`update feature_flags set enabled = true where key = ${KEY}`));
    clock.advance(59_000);
    expect(await asTenant(agencyC)).toBe(false);
    clock.advance(1_000);
    expect(await asTenant(agencyC)).toBe(true);
  });

  it('[S0-07] an override on an unknown flag is NOT_FOUND', async () => {
    await expect(
      withSystem('test.flags', (tx: Tx) => setFlagOverride(tx, `test.missing-${run}`, agencyA, true)),
    ).rejects.toMatchObject({ name: 'AppError', code: 'NOT_FOUND' });
  });

  it('[S0-07] unknown flags are off', async () => {
    invalidateFlags();
    expect(
      await withTenant({ agencyId: agencyA }, (tx: Tx) =>
        flag({ tx, tenant: { agencyId: agencyA } }, `test.missing-${run}`),
      ),
    ).toBe(false);
  });

  it('[S0-07] agencies cannot write flags (app_user is read-only on feature_flags)', async () => {
    const err = await withTenant({ agencyId: agencyA }, (tx: Tx) => setFlagOverride(tx, KEY, agencyA, true)).then(
      () => undefined,
      (e: unknown) => e as { cause?: { code?: string } },
    );
    expect(err?.cause?.code).toBe('42501'); // insufficient_privilege
  });
});
