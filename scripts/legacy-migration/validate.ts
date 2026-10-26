// pnpm legacy:validate --staging <dir> [--agency <legacy id>]... [--sample <n>] [--report <file.json>] [--dry-run]
//   [--strict] [--test]
//
// Validation reports of the legacy migration (S14-03, PLAN §14 Path A step 6). Run after `legacy:load` against the same
// staging directory (S14-01: `agency-<id>/<entity>.ndjson`, `inventory.json`): per agency, legacy / staged / loaded
// counts per entity (what the load listed with a reason is explained), image counts (legacy, queued, on the listing,
// still downloading), a deterministic sample of listings, contacts and leads compared field by field, and URL checks
// of the sampled listings (the legacy id lookup the v1 shim and redirects use; their image URLs). PASS when every
// unexplained rate is under 0.5 %. Each report is stored as the agency's latest (staff console: Migration) unless
// `--dry-run`; `--report` also writes them to a file outside the repo (ids, counts and field names only). `--strict`
// exits 1 when an agency fails. An agency without a v2 agency (never loaded) is listed as not validated.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { readStackEnv } from '../ops/stack-env';
import { assertOutsideRepo } from './extract-lib';
import { legacyRowsOf, parseAgencyArg, readInventory, stagedAgencies, stagedSource } from './staging';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    staging: { type: 'string' },
    agency: { type: 'string', multiple: true },
    sample: { type: 'string' },
    report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});

if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'legacy:validate', level: process.env.LOG_LEVEL });

/** Report entity of each staging file; `image` is the inventory's `property_images`. */
const REPORT_ENTITY: Record<migration.LegacyStagingEntity, string> = {
  users: 'user',
  listings: 'listing',
  developments: 'development',
  units: 'unit',
  contacts: 'contact',
  leads: 'lead',
};

try {
  if (!values.staging) throw new TypeError('--staging <dir> is required (the legacy extract output)');
  const staging = values.staging;
  const reportFile = values.report ? assertOutsideRepo(values.report) : undefined;
  const sampleSize = values.sample === undefined ? undefined : Number(values.sample);
  if (sampleSize !== undefined && !(Number.isInteger(sampleSize) && sampleSize > 0)) {
    throw new TypeError('--sample must be a positive whole number');
  }
  const inventory = readInventory(staging);
  const agencies =
    values.agency && values.agency.length > 0
      ? values.agency.map((a) => parseAgencyArg(a).legacyAgencyId)
      : stagedAgencies(staging, inventory);
  if (agencies.length === 0) throw new TypeError(`no staged agency under ${staging}`);
  await configureDb(loadConfigOrExit(dbEnv));

  const reports: unknown[] = [];
  const notValidated: { legacyAgencyId: string; error: string }[] = [];
  let failed = 0;
  for (const legacyAgencyId of agencies) {
    try {
      // The agency map the load recorded (never created here: an agency never loaded is not validated).
      const agencyId = await withSystem('legacy-migration.validate', (tx) =>
        migration.agencyOfLegacy(tx, legacyAgencyId),
      );
      if (!agencyId) {
        notValidated.push({ legacyAgencyId, error: 'code=NOT_LOADED' });
        log.warn({ legacyAgencyId }, 'legacy agency has no v2 agency: run legacy:load first');
        continue;
      }
      const staged: migration.ValidateLegacyAgencyInput['staged'] = {};
      const legacyRows: Record<string, number> = {};
      for (const [key, file] of Object.entries(migration.LEGACY_STAGING) as [migration.LegacyStagingEntity, string][]) {
        staged[key] = stagedSource(staging, legacyAgencyId, file);
        const n = legacyRowsOf(inventory, legacyAgencyId, file);
        if (n !== undefined) legacyRows[REPORT_ENTITY[key]] = n;
      }
      const images = legacyRowsOf(inventory, legacyAgencyId, 'property_images');
      if (images !== undefined) legacyRows.image = images;
      const report = await migration.validateLegacyAgency({ legacyAgencyId, agencyId, staged, legacyRows, sampleSize });
      const id = values['dry-run']
        ? null
        : await withSystem('legacy-migration.validate', (tx) => migration.recordValidationReport(tx, report));
      if (report.status === 'FAIL') failed += 1;
      reports.push({ id, ...report });
      log.info(
        {
          legacyAgencyId,
          status: report.status,
          rate: report.totals.rate,
          sampleDiffs: report.sample.differing,
          urlFailures: report.urls.failed,
          id,
        },
        'agency validated',
      );
    } catch (err) {
      const error = migration.failureOf(err, null);
      notValidated.push({ legacyAgencyId, error });
      log.error({ legacyAgencyId, error }, 'agency not validated');
    }
  }
  if (reportFile) {
    writeFileSync(reportFile, `${JSON.stringify({ failed, notValidated, agencies: reports }, null, 2)}\n`);
  }
  log.info({ agencies: reports.length, failed, notValidated: notValidated.length }, 'done');
  if (notValidated.length > 0 || (values.strict && failed > 0)) process.exitCode = 1;
} catch (err) {
  log.error(
    { error: err instanceof TypeError ? err.message : migration.failureOf(err, null) },
    'legacy validation failed',
  );
  process.exitCode = 1;
} finally {
  await closeDb();
}
