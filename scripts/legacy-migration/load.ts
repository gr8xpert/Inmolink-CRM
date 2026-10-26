// pnpm legacy:load --staging <dir> [--agency <legacy id>[=<v2 agency uuid>]]... [--report <file.json>]
//   [--email-domain <domain>]... [--dry-run] [--restart] [--strict] [--target <db host> | --test]
//
// Legacy transform and load (S14-02, PLAN §14 Path A step 3, ADR 0006). Reads the staging files of the legacy extract
// (S14-01: `agency-<id>/<entity>.ndjson`, `inventory.json`) and loads each agency — users → members (they sign in
// through a password reset), listings (+ images queued for the media pipeline), developments and units, contacts,
// leads — in checkpointed batches (`migration_batches`): a re-run skips the batches already done and resumes at the
// first failed one; `--restart` runs every batch again (idempotent: maps and natural keys, never a duplicate).
// The load mails nobody: the members it created get their password-reset e-mail once, from the cutover's ENABLE_ACCESS
// step (`legacy:cutover run`). `--email-domain` names the agency's e-mail domains (besides its existing members'): a
// migrated user outside them is a report warning (`email_domain`; the dump's e-mail is taken as verified). The report
// (outside the repo) gives per agency and entity the legacy, staged and loaded counts and lists every row not loaded
// with a reason; `--strict` exits 1 when a count does not match. Run `legacy:taxonomy` first. The first run of an agency names its v2 agency.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { closeCache } from '@inmolink/platform/cache';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues } from '@inmolink/platform/queue';
import { stagedAgencyArgs } from './args';
import { assertOutsideRepo } from './extract-lib';
import { prepareLegacyScriptEnv } from './guard';
import { legacyRowsOf, readInventory, stagedSource } from './staging';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    target: { type: 'string' },
    staging: { type: 'string' },
    agency: { type: 'string', multiple: true },
    report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    restart: { type: 'boolean', default: false },
    'email-domain': { type: 'string', multiple: true },
    strict: { type: 'boolean', default: false },
  },
});

// S14 review: `--test` only on the local test stack; any other run names its database host (`--target`).
prepareLegacyScriptEnv({ test: values.test, target: values.target, script: 'legacy:load' });
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'legacy:load', level: process.env.LOG_LEVEL });

/** Report entity of each staging file (the inventory counts rows per staging file). */
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
  const inventory = readInventory(staging);
  const { given, agencies } = stagedAgencyArgs(values.agency, staging, inventory);
  await configureDb(loadConfigOrExit(dbEnv));
  const dryRun = values['dry-run'];

  const results: (migration.MigrateLegacyAgencyResult & { legacyAgencyId: string })[] = [];
  const failed: { legacyAgencyId: string; error: string }[] = [];
  for (const legacyAgencyId of agencies) {
    try {
      const agencyId = await withSystem('legacy-migration.agency', (tx) =>
        // a dry run leaves no agency map behind either
        migration.inSavepoint(tx, dryRun, (sp) =>
          migration.resolveLegacyAgency(sp, legacyAgencyId, given.get(legacyAgencyId)),
        ),
      );
      // Streamed: each file is read line by line, one batch in memory at a time.
      const staged: Partial<Record<migration.LegacyStagingEntity, migration.StagedSource>> = {};
      const legacyRows: Record<string, number> = {};
      for (const [key, file] of Object.entries(migration.LEGACY_STAGING) as [migration.LegacyStagingEntity, string][]) {
        staged[key] = stagedSource(staging, legacyAgencyId, file);
        const n = legacyRowsOf(inventory, legacyAgencyId, file);
        if (n !== undefined) legacyRows[REPORT_ENTITY[key]] = n;
      }
      const result = await migration.migrateLegacyAgency({
        legacyAgencyId,
        agencyId,
        staged,
        legacyRows,
        dryRun,
        restart: values.restart,
        emailDomains: values['email-domain'] ?? [],
      });
      results.push({ legacyAgencyId, ...result });
      log.info(
        { legacyAgencyId, counts: result.report.counts, stoppedAt: result.stoppedAt, dryRun },
        result.stoppedAt ? 'agency stopped at a failed batch (re-run resumes there)' : 'agency loaded',
      );
    } catch (err) {
      // Code, constraint and ids only: a database message may quote the row's personal data.
      const error = migration.failureOf(err, null);
      failed.push({ legacyAgencyId, error });
      log.error({ legacyAgencyId, error }, 'agency not loaded');
    }
  }

  const stopped = results.filter((r) => r.stoppedAt).map((r) => r.legacyAgencyId);
  const matches = failed.length === 0 && stopped.length === 0 && results.every((r) => r.report.matches);
  if (reportFile) {
    writeFileSync(
      reportFile,
      `${JSON.stringify(
        {
          matches,
          failed,
          agencies: results.map((r) => ({
            ...r.report,
            steps: r.steps,
            stoppedAt: r.stoppedAt,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  log.info({ agencies: results.length, failed: failed.length, stopped, dryRun }, 'done');
  if (!matches) {
    log.warn({ report: reportFile ?? '(use --report)' }, 'counts do not match the legacy inventory, or a batch failed');
    if (values.strict || failed.length > 0 || stopped.length > 0) process.exitCode = 1;
  }
} catch (err) {
  log.error(
    // usage errors are ours to print; anything else is a code only (a database message may quote personal data)
    { error: err instanceof TypeError ? err.message : migration.failureOf(err, null) },
    'legacy load failed',
  );
  process.exitCode = 1;
} finally {
  // The queue (image downloads) and cache (agency settings) connect on first use: REDIS_QUEUE_URL, REDIS_CACHE_URL.
  await closeQueues();
  await closeCache();
  await closeDb();
}
