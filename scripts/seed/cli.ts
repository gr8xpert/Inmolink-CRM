// pnpm db:seed [--test]
// pnpm db:seed:scale --agencies=N [--seed=1] [--chunk=100] [--test] [--staging]
//
// Dev seed: 5 demo agencies with known logins (printed at the end). Scale seed: PLAN §4.1 ratios ×
// N agencies, COPY-based and deterministic per --seed (docs/runbooks/scale-seed.md). Both are
// idempotent: deterministic IDs, existing rows are skipped. Run `pnpm db:migrate && pnpm db:rls` first.
import { parseArgs } from 'node:util';
import { closeDb, configureDb, dbEnv } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from '../ops/stack-env';
import { scaleCounts } from './profile';
import { DEFAULT_DEMO_PASSWORD, runDevSeed, runScaleSeed, type SeedReport } from './run';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    agencies: { type: 'string' },
    seed: { type: 'string', default: '1' },
    chunk: { type: 'string', default: '100' },
  },
});
const mode = positionals[0];
if (mode !== 'dev' && mode !== 'scale') throw new TypeError('usage: cli.ts dev|scale [options]');

function int(name: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0) throw new TypeError(`--${name} must be a whole number`);
  return n;
}

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: `seed:${mode}`, level: process.env.LOG_LEVEL ?? 'warn' });

function printSummary(report: SeedReport): void {
  for (const [name, r] of Object.entries(report.results)) {
    console.log(
      `  ${name.padEnd(24)} inserted ${String(r.inserted).padStart(9)}   total ${String(r.total).padStart(9)}`,
    );
  }
  console.log(`done in ${report.seconds.toFixed(1)} s`);
}

try {
  await configureDb(loadConfigOrExit(dbEnv), { logger: log });
  if (mode === 'dev') {
    const demoPassword = process.env.SEED_DEMO_PASSWORD ?? DEFAULT_DEMO_PASSWORD;
    const report = await runDevSeed({ demoPassword });
    printSummary(report);
    console.log(`\nDemo logins (password: ${demoPassword})`);
    for (const l of report.logins) console.log(`  ${l.agency.padEnd(22)} ${l.role.padEnd(10)} ${l.email}`);
  } else {
    const agencies = int('agencies', values.agencies);
    const seed = int('seed', values.seed);
    const chunk = int('chunk', values.chunk);
    console.log(`scale seed: seed ${seed}, target ${JSON.stringify(scaleCounts(agencies))}`);
    const report = await runScaleSeed(
      {
        agencies,
        seed,
        chunk,
        scalePassword: process.env.SEED_SCALE_PASSWORD ?? DEFAULT_DEMO_PASSWORD,
        onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} agencies`),
      },
      { allowStaging: values.staging, onSeeder: (name) => process.stdout.write(`\n${name}\n`) },
    );
    console.log();
    printSummary(report);
    console.log(`\nSynthetic logins: a<agency>-u<n>@s${seed}.scale.inmolink.test (a0-u0 … a${agencies - 1}-u4)`);
  }
} catch (err) {
  log.error({ err }, 'seed failed');
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
