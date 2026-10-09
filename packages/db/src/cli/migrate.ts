// pnpm db:migrate [--test] — role bootstrap + pending migrations. `--test` targets the test stack.
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { loadStackEnv } from '../env-file';
import { migrateEnv, runMigrations } from '../migrate';

loadStackEnv(process.argv.includes('--test') ? 'test' : 'dev');
const log = createLogger({ service: 'db:migrate', level: process.env.LOG_LEVEL });

try {
  await runMigrations(loadConfigOrExit(migrateEnv), log);
} catch (err) {
  log.error({ err }, 'migration failed');
  process.exitCode = 1;
}
