import { describe, expect, it, vi } from 'vitest';
import { generateKey } from '../crypto';
import { ConfigError, coreEnv, cryptoEnv, databaseEnv, loadConfig, loadConfigOrExit, redisEnv } from './index';

const validEnv = {
  NODE_ENV: 'test',
  APP_ROLE: 'http',
  DATABASE_URL_APP_USER: 'postgres://app_user:pw@localhost:6432/inmolink',
  DATABASE_URL_APP_SYSTEM: 'postgres://app_system:pw@localhost:6432/inmolink',
  DATABASE_URL_APP_PUBLIC: 'postgres://app_public:pw@localhost:6432/inmolink',
  REDIS_QUEUE_URL: 'redis://localhost:6379',
  REDIS_CACHE_URL: 'redis://localhost:6380',
};
const shape = { ...coreEnv, ...databaseEnv, ...redisEnv };

describe('loadConfig', () => {
  it('[S0-03] returns typed, frozen config with defaults applied', () => {
    const config = loadConfig(shape, validEnv);
    expect(config.APP_ROLE).toBe('http');
    expect(config.LOG_LEVEL).toBe('info');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('[S0-03] missing/invalid env var stops boot with a clear message', () => {
    const env = {
      ...validEnv,
      APP_ROLE: 'superuser',
      REDIS_CACHE_URL: 'http://localhost:6380',
      DATABASE_URL_APP_USER: undefined,
      DATABASE_URL_APP_PUBLIC: '',
    };

    let thrown: unknown;
    try {
      loadConfig(shape, env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const err = thrown as ConfigError;
    expect(err.problems.map((p) => p.key).sort()).toEqual([
      'APP_ROLE',
      'DATABASE_URL_APP_PUBLIC',
      'DATABASE_URL_APP_USER',
      'REDIS_CACHE_URL',
    ]);
    expect(err.message).toContain('DATABASE_URL_APP_USER: is required but not set');
    expect(err.message).toContain('DATABASE_URL_APP_PUBLIC: is required but not set');
    expect(err.message).toContain('REDIS_CACHE_URL: must start with redis:// or rediss://');
    expect(err.message).toContain('APP_ROLE:');

    // The process stops with exit code 1 and the message on stderr.
    const io = {
      error: vi.fn(),
      exit: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    };
    expect(() => loadConfigOrExit(shape, env, io)).toThrow('exit 1');
    expect(io.error).toHaveBeenCalledWith(err.message);
  });

  function problemsOf(fn: () => unknown): ConfigError {
    try {
      fn();
    } catch (err) {
      if (err instanceof ConfigError) return err;
      throw err;
    }
    throw new Error('expected a ConfigError');
  }

  it('[S0-03] never echoes secret values in the error', () => {
    const env = {
      ...validEnv,
      ENCRYPTION_KEYS: 'k1:abc',
      ENCRYPTION_ACTIVE_KEY_ID: 'k1',
      HMAC_KEY: 'short-secret-value',
    };
    const err = problemsOf(() => loadConfig({ ...shape, ...cryptoEnv }, env));
    expect(err.message).toContain('HMAC_KEY: must be at least 32 characters');
    expect(err.message).not.toContain('short-secret-value');
  });

  it('[S0-03] invalid encryption keys stop boot with the variable named', () => {
    const hmac = 'x'.repeat(40);
    const key = generateKey();
    const shortKey = problemsOf(() =>
      loadConfig(cryptoEnv, { ENCRYPTION_KEYS: 'k1:c2hvcnQ=', ENCRYPTION_ACTIVE_KEY_ID: 'k1', HMAC_KEY: hmac }),
    );
    expect(shortKey.message).toContain('ENCRYPTION_KEYS: Encryption key "k1" must be 32 bytes');
    expect(shortKey.message).not.toContain('c2hvcnQ=');

    const unknownActive = problemsOf(() =>
      loadConfig(cryptoEnv, { ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_ACTIVE_KEY_ID: 'k2', HMAC_KEY: hmac }),
    );
    expect(unknownActive.problems.map((p) => p.key)).toEqual(['ENCRYPTION_ACTIVE_KEY_ID']);

    expect(
      loadConfig(cryptoEnv, { ENCRYPTION_KEYS: `k1:${key}`, ENCRYPTION_ACTIVE_KEY_ID: 'k1', HMAC_KEY: hmac })
        .ENCRYPTION_ACTIVE_KEY_ID,
    ).toBe('k1');
  });

  it('[S0-04] the BYPASSRLS URL is refused for APP_ROLE=http in production, optional elsewhere', () => {
    const prod = { ...validEnv, NODE_ENV: 'production' };
    const err = problemsOf(() => loadConfig(shape, prod));
    expect(err.problems.map((p) => p.key)).toEqual(['DATABASE_URL_APP_SYSTEM']);
    expect(err.message).not.toContain('app_system:pw');
    expect(() => loadConfig(shape, { ...prod, DATABASE_URL_APP_SYSTEM: undefined })).not.toThrow();
    expect(() => loadConfig(shape, { ...prod, APP_ROLE: 'worker' })).not.toThrow();
  });

  it('[S0-03] dev keys are refused in production', () => {
    const env = {
      ...validEnv,
      NODE_ENV: 'production',
      APP_ROLE: 'worker',
      ENCRYPTION_KEYS: `dev1:${generateKey()}`,
      ENCRYPTION_ACTIVE_KEY_ID: 'dev1',
      HMAC_KEY: `dev-${'0'.repeat(64)}`,
    };
    const err = problemsOf(() => loadConfig({ ...shape, ...cryptoEnv }, env));
    expect(err.problems.map((p) => p.key).sort()).toEqual(['ENCRYPTION_KEYS', 'HMAC_KEY']);
    expect(() => loadConfig({ ...shape, ...cryptoEnv }, { ...env, NODE_ENV: 'development' })).not.toThrow();
  });
});
