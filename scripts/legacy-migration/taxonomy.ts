// pnpm legacy:taxonomy --input <extract.json> [--report <report.json>] [--dry-run] [--strict] [--test]
//
// Legacy taxonomy import (S2-06, PLAN §14, ADR 0006). Reads the taxonomy extract of the legacy dump (shape:
// `LegacyTaxonomyExtract`; the dump itself stays outside the repo, H1), maps every legacy location, property
// type and feature onto the v2 taxonomy, writes an alias for each legacy spelling and a `legacy_id_maps`
// row per mapped ID. Idempotent: re-run it after staff mapped what the report lists. Legacy IDs without a
// confident match are listed in the report with a reason (never guessed, never dropped); `--strict` exits
// 1 when any remain, `--dry-run` writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LegacyTaxonomyExtract } from '@inmolink/contracts';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from '../ops/stack-env';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    input: { type: 'string' },
    report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'legacy:taxonomy', level: process.env.LOG_LEVEL });

try {
  if (!values.input) throw new TypeError('--input <extract.json> is required');
  const extract = LegacyTaxonomyExtract.parse(JSON.parse(readFileSync(values.input, 'utf8')));
  await configureDb(loadConfigOrExit(dbEnv));
  const dryRun = values['dry-run'];
  const report = await withSystem(`legacy-migration.taxonomy${dryRun ? '.dry-run' : ''}`, (tx) =>
    migration.importLegacyTaxonomy(tx, extract, { dryRun }),
  );
  if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  log.info({ counts: report.counts, aliasesAdded: report.aliasesAdded, remapped: report.remapped, dryRun }, 'done');
  if (report.unmapped.length > 0) {
    log.warn({ unmapped: report.unmapped.length, report: values.report ?? '(use --report)' }, 'unmapped legacy IDs');
    if (values.strict) process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, 'legacy taxonomy import failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
