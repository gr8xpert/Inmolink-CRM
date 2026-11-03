import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { newToken } from '@inmolink/platform/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The command DevOps runs (S17-F14): real process, `DATABASE_URL_*` from the environment as through their tunnel, so
// it reads no local env file. Same arguments as the root package.json script.
const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function run(...args: string[]) {
  const r = spawnSync(
    process.execPath,
    [TSX, '--conditions=@inmolink/source', 'scripts/ops/staff.ts', 'bootstrap', ...args],
    { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'info' }, encoding: 'utf8', timeout: 90_000 },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

beforeAll(async () => {
  await setupTestDb('script');
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('pnpm staff:bootstrap', () => {
  it('[S17-F14] the root package.json script runs this command', () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['staff:bootstrap']).toBe('tsx --conditions=@inmolink/source scripts/ops/staff.ts bootstrap');
  });

  it('[S17-F14] creates, then changes nothing, and prints no secret or address', () => {
    const email = `boot-cli-${newToken(6).toLowerCase()}@staff.inmolink.test`;
    const args = ['--email', email, '--role', 'SUPER_ADMIN', '--reason', 'first login of test'];
    const first = run(...args);
    expect(first.output).toContain('"outcome":"created"');
    expect(first.output).toContain('"addressDomain":"staff.inmolink.test"');
    expect(first.status).toBe(0);
    const second = run(...args);
    expect(second.output).toContain('"outcome":"unchanged"');
    expect(second.status).toBe(0);
    for (const { output } of [first, second]) {
      expect(output).not.toContain(email);
      expect(output).not.toMatch(/argon2|token|password/i);
    }
  });

  it('[S17-F14] a bad role fails with a non-zero exit', () => {
    const r = run('--email', 'boot-bad-role@staff.inmolink.test', '--role', 'ADMIN', '--reason', 'first login');
    expect(r.status).toBe(1);
    expect(r.output).toContain('--role must be one of');
  });

  it('[S17-F14] takes no password', () => {
    const secret = 'hunter2-not-a-real-password';
    const r = run(
      '--email',
      'boot-pw@staff.inmolink.test',
      '--role',
      'SUPER_ADMIN',
      '--reason',
      'first login',
      '--password',
      secret,
    );
    expect(r.status).not.toBe(0);
    expect(r.output).not.toContain(secret);
  });
});
