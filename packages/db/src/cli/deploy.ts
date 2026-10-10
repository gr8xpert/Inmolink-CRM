// node packages/db/dist/cli/deploy.js — what a deploy runs against the database (S0-15, scripts/ops/deploy.sh):
// role bootstrap (only with DATABASE_URL_ADMIN) + pending migrations, then RLS from the tenant registry and
// the guard. Exit 1 on any problem, so a release never runs against looser policies than its code expects.
// Unlike `pnpm db:rls` it does not rewrite rls/policies.sql (the image is read-only); the SQL comes from
// the registry compiled into this build, the same source the committed file is generated from.
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { loadStackEnv } from '../env-file';
import { migrateEnv, runMigrations, runRls } from '../migrate';

loadStackEnv(process.argv.includes('--test') ? 'test' : 'dev');
const log = createLogger({ service: 'db:deploy', level: process.env.LOG_LEVEL });

try {
  const cfg = loadConfigOrExit(migrateEnv);
  await runMigrations(cfg, log);
  const problems = await runRls(cfg, log);
  if (problems.length > 0) {
    log.error({ problems }, 'database does not match the tenant registry after RLS apply');
    process.exitCode = 1;
  } else {
    log.info('database deploy complete: migrations, RLS and guard');
  }
} catch (err) {
  log.error({ err }, 'database deploy failed');
  process.exitCode = 1;
}
