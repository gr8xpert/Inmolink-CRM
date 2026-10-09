// pnpm db:rls [--test] — regenerate rls/policies.sql from the registry, apply it, run the guard.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { loadStackEnv } from '../env-file';
import { migrateEnv, runRls } from '../migrate';
import { registry } from '../tenancy/registry';
import { generateRlsSql } from '../tenancy/rls';

loadStackEnv(process.argv.includes('--test') ? 'test' : 'dev');
const log = createLogger({ service: 'db:rls', level: process.env.LOG_LEVEL });

try {
  writeFileSync(join(import.meta.dirname, '..', '..', 'rls', 'policies.sql'), generateRlsSql(registry));
  const problems = await runRls(loadConfigOrExit(migrateEnv), log);
  if (problems.length > 0) {
    log.error({ problems }, 'database does not match the tenant registry');
    process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, 'db:rls failed');
  process.exitCode = 1;
}
