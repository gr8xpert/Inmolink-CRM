import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateKey } from '../crypto';
import { generateAccessKeyPair } from '../jwt';
import {
  authSessionEnv,
  authSignEnv,
  authVerifyEnv,
  ConfigError,
  coreEnv,
  cryptoEnv,
  databaseEnv,
  emailEnv,
  loadConfig,
  loadConfigOrExit,
  redisEnv,
  searchEnv,
  telemetryEnv,
  turnstileEnv,
} from './index';

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

  it('[S0-06] the LISTEN URL (outbox dispatcher) is refused for APP_ROLE=http in production', () => {
    const prod = { ...validEnv, NODE_ENV: 'production', DATABASE_URL_APP_SYSTEM: undefined };
    const listen = 'postgres://app_system:pw@localhost:5432/inmolink';
    const err = problemsOf(() => loadConfig(shape, { ...prod, DATABASE_URL_LISTEN: listen }));
    expect(err.problems.map((p) => p.key)).toEqual(['DATABASE_URL_LISTEN']);
    expect(() => loadConfig(shape, { ...prod, APP_ROLE: 'worker', DATABASE_URL_LISTEN: listen })).not.toThrow();
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

  it('[S1-F5] production config with an example secret minus its dev prefix fails to load', () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    for (const file of ['.env.example', '.env.test.example']) {
      const text = readFileSync(join(root, file), 'utf8');
      const value = (key: string) => new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1]?.trim() ?? '';
      const encryptionKey = value('ENCRYPTION_KEYS').split(':')[1] ?? '';
      const env = {
        ...validEnv,
        NODE_ENV: 'production',
        APP_ROLE: 'worker',
        // The committed values with the dev markers removed: prefix dropped, key id renamed.
        ENCRYPTION_KEYS: `prod1:${encryptionKey}`,
        ENCRYPTION_ACTIVE_KEY_ID: 'prod1',
        HMAC_KEY: value('HMAC_KEY').replace(/^dev-/, ''),
        AUTH_SECRET: value('AUTH_SECRET').replace(/^dev-/, ''),
      };
      // Refused because they are the examples, not because they are malformed (a renamed key reads as '').
      for (const v of [encryptionKey, env.HMAC_KEY, env.AUTH_SECRET]) expect(v.length, file).toBeGreaterThan(30);
      const err = problemsOf(() => loadConfig({ ...shape, ...cryptoEnv, ...authSessionEnv }, env));
      expect(err.problems.map((p) => p.key).sort(), file).toEqual(['AUTH_SECRET', 'ENCRYPTION_KEYS', 'HMAC_KEY']);
      for (const p of err.problems) expect(p.message, p.key).toContain('committed example');
      // A different prefix does not help either.
      const prefixed = { ...env, HMAC_KEY: `prod-${env.HMAC_KEY}`, AUTH_SECRET: `x${env.AUTH_SECRET}` };
      const again = problemsOf(() => loadConfig({ ...shape, ...cryptoEnv, ...authSessionEnv }, prefixed));
      expect(again.problems.map((p) => p.message).every((m) => m.includes('committed example'))).toBe(true);
      expect(again.problems).toHaveLength(3);
    }
    const fresh = {
      ...validEnv,
      NODE_ENV: 'production',
      APP_ROLE: 'worker',
      ENCRYPTION_KEYS: `k1:${generateKey()}`,
      ENCRYPTION_ACTIVE_KEY_ID: 'k1',
      HMAC_KEY: 'a'.repeat(64),
      AUTH_SECRET: 'b'.repeat(43),
    };
    expect(() => loadConfig({ ...shape, ...cryptoEnv, ...authSessionEnv }, fresh)).not.toThrow();
  });

  it('[S1-F5] request apps never hold the Meilisearch admin key in production; Turnstile keys pair up', () => {
    // Shaped like api/feed-api: the master key is not even declared, yet an injected one is refused.
    const sshape = { ...coreEnv, MEILI_URL: searchEnv.MEILI_URL, MEILI_SEARCH_KEY: searchEnv.MEILI_SEARCH_KEY };
    const base = { NODE_ENV: 'production', APP_ROLE: 'http', MEILI_URL: 'http://meili:7700' };
    expect(problemsOf(() => loadConfig(sshape, { ...base, MEILI_MASTER_KEY: 'm' })).problems.map((p) => p.key)).toEqual(
      ['MEILI_MASTER_KEY'],
    );
    expect(() => loadConfig(sshape, { ...base, MEILI_SEARCH_KEY: 'search-only' })).not.toThrow();
    expect(() => loadConfig(sshape, { ...base, APP_ROLE: 'worker', MEILI_MASTER_KEY: 'm' })).not.toThrow();
    const keys = (env: Record<string, string>) => {
      try {
        loadConfig({ ...coreEnv, ...turnstileEnv }, { APP_ROLE: 'http', ...env });
        return [];
      } catch (err) {
        return (err as ConfigError).problems.map((p) => p.key);
      }
    };
    expect(keys({ NODE_ENV: 'production', TURNSTILE_SITE_KEY: '0x4AAAAAAA' })).toEqual(['TURNSTILE_SECRET_KEY']);
    const test = {
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    };
    expect(keys({ NODE_ENV: 'development', ...test })).toEqual([]);
    expect(keys({ NODE_ENV: 'production', ...test }).sort()).toEqual(['TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY']);
  });

  it('[S0-09] email driver needs its credential; JWT keys must be Ed25519 and not dev keys in production', () => {
    const emailShape = { ...coreEnv, ...emailEnv };
    const base = { NODE_ENV: 'test', APP_ROLE: 'worker', EMAIL_FROM: 'Inmolink <no-reply@inmolink.test>' };
    expect(problemsOf(() => loadConfig(emailShape, base)).problems.map((p) => p.key)).toEqual(['SMTP_URL']);
    expect(
      problemsOf(() => loadConfig(emailShape, { ...base, EMAIL_DRIVER: 'resend' })).problems.map((p) => p.key),
    ).toEqual(['RESEND_API_KEY']);
    expect(() => loadConfig(emailShape, { ...base, SMTP_URL: 'smtp://localhost:1025' })).not.toThrow();

    const pair = generateAccessKeyPair();
    const authShape = { ...coreEnv, ...authSignEnv, ...authVerifyEnv };
    const auth = {
      NODE_ENV: 'production',
      APP_ROLE: 'http',
      AUTH_JWT_PRIVATE_KEY: pair.privateKey,
      AUTH_JWT_KEY_ID: 'dev-1',
      AUTH_JWT_PUBLIC_KEYS: `dev-1:${pair.publicKey}`,
    };
    expect(problemsOf(() => loadConfig(authShape, auth)).problems.map((p) => p.key)).toEqual([
      'AUTH_JWT_KEY_ID',
      'AUTH_JWT_PUBLIC_KEYS',
    ]);
    expect(() =>
      loadConfig(authShape, { ...auth, AUTH_JWT_KEY_ID: 'k1', AUTH_JWT_PUBLIC_KEYS: `k1:${pair.publicKey}` }),
    ).not.toThrow();

    // The committed example key under a new id, and a dev session secret, are still refused.
    const example = {
      ...auth,
      AUTH_JWT_KEY_ID: 'prod-1',
      AUTH_JWT_PRIVATE_KEY: 'MC4CAQAwBQYDK2VwBCIEIIokFZlFPiG5rY8/BikaWmui4W0LMkhhDR3/KrGI9+cd',
      AUTH_JWT_PUBLIC_KEYS: 'prod-1:MCowBQYDK2VwAyEA57hG/H5HUDaL1k17CeMBqE03zTvNPgLVHoX7DKSYyqs=',
      AUTH_SECRET: `dev-${'x'.repeat(40)}`,
    };
    expect(
      problemsOf(() => loadConfig({ ...authShape, ...authSessionEnv }, example))
        .problems.map((p) => p.key)
        .sort(),
    ).toEqual(['AUTH_JWT_PRIVATE_KEY', 'AUTH_JWT_PUBLIC_KEYS', 'AUTH_SECRET']);
    const bad = { ...auth, NODE_ENV: 'test', AUTH_JWT_PRIVATE_KEY: pair.publicKey, AUTH_JWT_PUBLIC_KEYS: 'k1:abc' };
    expect(
      problemsOf(() => loadConfig(authShape, bad))
        .problems.map((p) => p.key)
        .sort(),
    ).toEqual(['AUTH_JWT_PRIVATE_KEY', 'AUTH_JWT_PUBLIC_KEYS']);
  });

  it('[S0-10] production telemetry: explicit sample ratio, a real release, private metrics bind, https DSN', () => {
    const tshape = { NODE_ENV: coreEnv.NODE_ENV, ...telemetryEnv };
    const keys = (env: Record<string, string | undefined>) => {
      try {
        loadConfig(tshape, env);
        return [];
      } catch (err) {
        return (err as ConfigError).problems.map((p) => p.key).sort();
      }
    };
    // Dev and test keep the defaults (ratio 1, release "dev", loopback).
    expect(keys({ NODE_ENV: 'development' })).toEqual([]);
    expect(keys({ NODE_ENV: 'production' })).toEqual(['OTEL_TRACES_SAMPLE_RATIO', 'RELEASE']);
    const prod = { NODE_ENV: 'production', OTEL_TRACES_SAMPLE_RATIO: '0.05', RELEASE: 'a1b2c3d' };
    expect(keys(prod)).toEqual([]);
    expect(keys({ ...prod, METRICS_HOST: '10.0.3.7' })).toEqual([]);
    expect(keys({ ...prod, METRICS_HOST: '0.0.0.0' })).toEqual(['METRICS_HOST']);
    expect(keys({ ...prod, METRICS_HOST: '0.0.0.0', METRICS_ALLOW_WILDCARD: 'true' })).toEqual([]);
    expect(keys({ ...prod, METRICS_HOST: '203.0.113.9' })).toEqual(['METRICS_HOST']);
    expect(keys({ ...prod, SENTRY_DSN: 'http://k@sentry.example.com/1' })).toEqual(['SENTRY_DSN']);
    expect(keys({ ...prod, SENTRY_DSN: 'https://k@sentry.example.com/1' })).toEqual([]);
  });
});
