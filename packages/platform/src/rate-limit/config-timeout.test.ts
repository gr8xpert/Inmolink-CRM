import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeRateLimit, configureRateLimit, rateLimitConnection } from './index';

/** S15-F5: the limit check's cut-off comes from the environment when the app does not name one. */
describe('limits command timeout', () => {
  afterEach(async () => {
    await closeRateLimit();
    vi.unstubAllEnvs();
  });

  // lazyConnect is off on the real connection: a closed port keeps the test offline (it never sends a command).
  const url = 'redis://127.0.0.1:1';

  it('[S15-F5] defaults to 200 ms', async () => {
    vi.stubEnv('REDIS_LIMITS_COMMAND_TIMEOUT_MS', '');
    await configureRateLimit({ url });
    expect(rateLimitConnection().options.commandTimeout).toBe(200);
  });

  it('[S15-F5] REDIS_LIMITS_COMMAND_TIMEOUT_MS raises it (the e2e stack); an explicit value wins', async () => {
    vi.stubEnv('REDIS_LIMITS_COMMAND_TIMEOUT_MS', '2000');
    await configureRateLimit({ url });
    expect(rateLimitConnection().options.commandTimeout).toBe(2_000);
    await configureRateLimit({ url, commandTimeoutMs: 500 });
    expect(rateLimitConnection().options.commandTimeout).toBe(500);
  });

  it('[S15-F5] refuses a value outside 50…10000 ms', async () => {
    vi.stubEnv('REDIS_LIMITS_COMMAND_TIMEOUT_MS', '10');
    await expect(configureRateLimit({ url })).rejects.toThrow(/REDIS_LIMITS_COMMAND_TIMEOUT_MS/);
  });
});
