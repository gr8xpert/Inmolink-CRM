// pnpm ci:migrations [--from=<git ref>] [--test]
//
// Applies every migration to an empty database, then the current migrations on top of the previous
// release's schema (default ref: newest `v*` tag, else the fork point from origin/main, else HEAD~1),
// and runs the RLS guard after each. Uses throwaway databases on the stack's Postgres (dev, or the
// test stack with --test) and drops them afterwards. Exit code 1 on any failure or guard problem.
import { parseArgs } from 'node:util';
import { migrateEnv } from '@inmolink/db/migrate';
import { loadConfigOrExit } from '@inmolink/platform/config';
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

try {
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
