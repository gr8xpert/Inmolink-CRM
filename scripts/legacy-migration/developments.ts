// pnpm legacy:developments --staging <dir> [--agency <legacy id>[=<v2 agency uuid>]]... [--report <file.json>]
//   [--dry-run] [--strict] [--test]
//
// Legacy new-build import (S4-04, PLAN §14). Reads the staging files of the legacy extract (S14-01:
// `agency-<id>/developments.ndjson`, `agency-<id>/development_units.ndjson`, `inventory.json`) and loads each agency's
// new-build projects into v2 developments and units with a `legacy_id_maps` row per loaded row. One `withSystem()`
// transaction per agency; idempotent (re-run after fixing what the report lists). The report gives per agency and
// entity the legacy, staged and loaded counts and lists every row not loaded with a reason; `--strict` exits 1 when
// any count does not match the inventory. The first run of an agency names its v2 agency (`--agency 12=<uuid>`,
// recorded in `legacy_id_maps`); later runs find it there. Run `legacy:taxonomy` first (locations, property types).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { LegacyLoadReport } from '@inmolink/contracts';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from '../ops/stack-env';
import { assertOutsideRepo } from './extract-lib';
import { legacyRowsOf, parseAgencyArg, readInventory, readStaged, stagedAgencies } from './staging';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'string' },
    agency: { type: 'string', multiple: true },
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
const log = createLogger({ service: 'legacy:developments', level: process.env.LOG_LEVEL });

const { development: DEV_FILE, unit: UNIT_FILE } = migration.LEGACY_DEVELOPMENT_ENTITIES;

try {
  if (!values.staging) throw new TypeError('--staging <dir> is required (the legacy extract output)');
  const staging = values.staging;
  // The report names legacy ids: it stays outside the repository, like the staging files.
  const reportFile = values.report ? assertOutsideRepo(values.report) : undefined;
  const inventory = readInventory(staging);
  const given = new Map((values.agency ?? []).map(parseAgencyArg).map((a) => [a.legacyAgencyId, a.agencyId]));
  const agencies = given.size > 0 ? [...given.keys()] : stagedAgencies(staging, inventory);
  if (agencies.length === 0) throw new Error(`no staged agency under ${staging}`);
  await configureDb(loadConfigOrExit(dbEnv));
  const dryRun = values['dry-run'];

  const reports: LegacyLoadReport[] = [];
  const failed: { legacyAgencyId: string; error: string }[] = [];
  for (const legacyAgencyId of agencies) {
    try {
      const developments = await readStaged(staging, legacyAgencyId, DEV_FILE);
      const units = await readStaged(staging, legacyAgencyId, UNIT_FILE);
      const reason = `legacy-migration.developments${dryRun ? '.dry-run' : ''}`;
      // A dry run rolls back the agency map too: it leaves nothing behind.
      const report = await withSystem(reason, (outer) =>
        migration.inSavepoint(outer, dryRun, async (tx) => {
          const agencyId = await migration.resolveLegacyAgency(tx, legacyAgencyId, given.get(legacyAgencyId));
          return migration.loadLegacyDevelopments(
            tx,
            {
              legacyAgencyId,
              agencyId,
              developments,
              units,
              legacyRows: {
                development: legacyRowsOf(inventory, legacyAgencyId, DEV_FILE),
                unit: legacyRowsOf(inventory, legacyAgencyId, UNIT_FILE),
              },
            },
            { dryRun },
          );
        }),
      );
      reports.push(report);
      log.info({ legacyAgencyId, counts: report.counts, issues: report.issues.length, dryRun }, 'agency loaded');
    } catch (err) {
      failed.push({ legacyAgencyId, error: err instanceof Error ? err.message : String(err) });
      log.error({ legacyAgencyId, err }, 'agency not loaded');
    }
  }

  const matches = failed.length === 0 && reports.every((r) => r.matches);
  if (reportFile) writeFileSync(reportFile, `${JSON.stringify({ matches, failed, agencies: reports }, null, 2)}\n`);
  const mismatched = reports.filter((r) => !r.matches).map((r) => r.legacyAgencyId);
  log.info({ agencies: reports.length, failed: failed.length, mismatched, dryRun }, 'done');
  if (!matches) {
    log.warn({ report: reportFile ?? '(use --report)' }, 'counts do not match the legacy inventory');
    if (values.strict || failed.length > 0) process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, 'legacy developments import failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
