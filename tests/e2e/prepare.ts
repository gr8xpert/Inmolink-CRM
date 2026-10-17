import { execFileSync } from 'node:child_process';
import { seedListingTaxonomy } from './seed';
import { ROOT } from './stack';

/**
 * Runs before Playwright (`pnpm test:e2e`): test stack up, roles + migrations + RLS on the test database.
 * Not in `globalSetup`: Playwright starts its `webServer`s *before* global setup, so the api and worker
 * would wait for a stack that is not up yet (CI has no stack until this runs — S1-F1). The listing taxonomy is
 * seeded here too, before any server can hold an in-process copy of the taxonomy (S5-CI).
 */
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', timeout: 300_000, shell: process.platform === 'win32' });

run('docker', ['compose', '--profile', 'test', 'up', '-d', '--wait']);
run('pnpm', ['db:migrate:test']);
run('pnpm', ['db:rls:test']);
await seedListingTaxonomy();
