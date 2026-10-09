import { newId } from '@inmolink/platform/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, configureDb } from '../client';
import { withSystem, withTenant } from './scope';

// Unreachable URLs: every case here must fail before any connection is attempted.
const url = (role: string) => `postgres://${role}:pw@127.0.0.1:1/none`;
const config = {
  APP_ROLE: 'http' as const,
  DATABASE_URL_APP_USER: url('app_user'),
  DATABASE_URL_APP_SYSTEM: url('app_system'),
  DATABASE_URL_APP_PUBLIC: url('app_public'),
};

beforeAll(() => configureDb(config));
afterAll(() => closeDb());

describe('scope guards', () => {
  it('[S0-04] withSystem throws when APP_ROLE=http', async () => {
    await expect(withSystem('nightly job', async () => 1)).rejects.toThrow(/not allowed when APP_ROLE=http/);
  });

  it('[S0-04] withSystem requires a reason', async () => {
    await configureDb({ ...config, APP_ROLE: 'worker' });
    try {
      await expect(withSystem('  ', async () => 1)).rejects.toThrow(/reason is required/);
    } finally {
      await configureDb(config);
    }
  });

  it('[S0-04] app_system is unavailable when its URL is not configured', async () => {
    await configureDb({ ...config, APP_ROLE: 'worker', DATABASE_URL_APP_SYSTEM: undefined });
    try {
      await expect(withSystem('nightly job', async () => 1)).rejects.toThrow(/DATABASE_URL_APP_SYSTEM is not set/);
    } finally {
      await configureDb(config);
    }
  });

  it('[S0-04] withTenant rejects a non-UUID agency or user id', async () => {
    await expect(withTenant({ agencyId: "x' or 1=1" }, async () => 1)).rejects.toThrow(/agencyId must be a UUID/);
    await expect(withTenant({ agencyId: newId(), userId: '' }, async () => 1)).rejects.toThrow(/userId/);
  });
});
