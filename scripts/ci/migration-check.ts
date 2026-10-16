// pnpm ci:migrations [--from=<git ref>] [--test]
//
// Applies every migration to an empty database, then the current migrations on top of the previous
// release's schema (default ref: newest `v*` tag, else the fork point from origin/main, else HEAD~1),
// and runs the RLS guard after each. Uses throwaway databases on the stack's Postgres (dev, or the
// test stack with --test) and drops them afterwards. Exit code 1 on any failure or guard problem.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { migrateEnv } from '@inmolink/db/migrate';
import { loadConfigOrExit } from '@inmolink/platform/config';
import pg from 'pg';
import { readStackEnv } from '../ops/stack-env';
import { checkMigrations, migrationsAt, previousReleaseRef } from './migrations';

const { values } = parseArgs({
  options: { from: { type: 'string' }, test: { type: 'boolean', default: false } },
});

// --test always targets the test stack, overriding any DATABASE_URL_* already in the shell.
if (values.test) {
  for (const [k, v] of Object.entries(readStackEnv('test'))) if (v !== undefined) process.env[k] = v;
} else if (
  process.env.NODE_ENV !== 'production' &&
  !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))
) {
  for (const [k, v] of Object.entries(readStackEnv('dev'))) process.env[k] ??= v;
}
const cfg = loadConfigOrExit(migrateEnv);

// It bootstraps the cluster's shared roles and creates/drops databases: local stacks and CI only.
const adminHost = cfg.DATABASE_URL_ADMIN ? new URL(cfg.DATABASE_URL_ADMIN).hostname : '';
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(adminHost) && process.env.CI !== 'true') {
  console.error(`migration check refused: admin host "${adminHost}" is not local (and CI is not set)`);
  process.exit(1);
}

const ref = values.from ?? previousReleaseRef();
const previous = migrationsAt(ref);
if (!previous) console.log(`migration check: ${ref} has no migrations — upgrade scenario skipped`);

/**
 * A fresh Postgres container reports healthy while its first-boot init still restarts the server once: CI's
 * check then died on "Connection terminated unexpectedly" (S3-06, S3-09, S3-F4 runs). Wait until three
 * connections in a row succeed, up to 60 s.
 */
async function waitForStableServer(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let streak = 0;
  while (streak < 3) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
      streak++;
    } catch (err) {
      streak = 0;
      if (Date.now() > deadline) throw err;
    } finally {
      await client.end().catch(() => {});
    }
    await sleep(500);
  }
}

try {
  if (cfg.DATABASE_URL_ADMIN) await waitForStableServer(cfg.DATABASE_URL_ADMIN);
  const scenarios = await checkMigrations(cfg, {
    previous: previous && { ref, folder: previous.folder },
    log: { info: (msg) => console.log(msg) },
  });
  let failed = false;
  for (const s of scenarios) {
    console.log(`  ${s.problems.length ? 'FAIL' : 'ok  '} ${s.name}: ${s.steps.join(' → ')}`);
    for (const p of s.problems) console.log(`       ${p}`);
    failed ||= s.problems.length > 0;
  }
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error('migration check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  previous?.cleanup();
}
