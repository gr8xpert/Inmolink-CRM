import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { ROOT, testStackEnv } from './stack';

/**
 * Test stack up, roles + migrations + RLS on the test database, and fresh rate-limit counters (runs
 * from the same IP would otherwise add up across runs).
 */
export default async function globalSetup(): Promise<void> {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', timeout: 300_000, shell: process.platform === 'win32' });
  run('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait']);
  run('pnpm', ['db:migrate:test']);
  run('pnpm', ['db:rls:test']);
  const redis = new Redis(testStackEnv().REDIS_CACHE_URL ?? 'redis://localhost:56380', { lazyConnect: true });
  try {
    await redis.connect();
    const keys = await redis.keys('inl:rl:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
