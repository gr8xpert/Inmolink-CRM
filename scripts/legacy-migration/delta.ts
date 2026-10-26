// pnpm legacy:delta [--url <postgres url> | LEGACY_DATABASE_URL] [--agency <legacy id>]... [--map <entities.json>]
//   [--dry-run] [--cutover | --reopen] [--target <db host> | --test]
//
// Legacy → v2 delta sync, a manual run (S14-04, PLAN §14 Path A step 5; the worker runs it hourly once a legacy reader
// is registered). For each legacy agency already loaded (`legacy:load`) and not cut over — every one, or the given
// `--agency` ids — reads the legacy rows changed since the agency's watermark in one read-only snapshot and loads them
// through the S14-02 load paths; migrated listings whose legacy row is gone are withdrawn (never deleted; guarded).
// `--cutover` marks the given agencies cut over (their delta stops: agents now work in v2); `--reopen` undoes it
// within the cutover window (rollback). The legacy database is only ever opened read-only.
import { parseArgs } from 'node:util';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { closeCache } from '@inmolink/platform/cache';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues } from '@inmolink/platform/queue';
import { readEntityMap } from './args';
import { openLegacyDeltaReader } from './delta-lib';
import { prepareLegacyScriptEnv } from './guard';

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    target: { type: 'string' },
    url: { type: 'string' },
    agency: { type: 'string', multiple: true },
    map: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    cutover: { type: 'boolean', default: false },
    reopen: { type: 'boolean', default: false },
  },
});

// S14 review: `--test` only on the local test stack; any other run names its database host (`--target`).
prepareLegacyScriptEnv({ test: values.test, target: values.target, script: 'legacy:delta' });
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'legacy:delta', level: process.env.LOG_LEVEL });

const agencyOf = async (legacyAgencyId: string) => {
  const agencyId = await withSystem('legacy-migration.delta', (tx) => migration.agencyOfLegacy(tx, legacyAgencyId));
  if (!agencyId) throw new TypeError(`legacy agency ${legacyAgencyId} is not loaded (run legacy:load first)`);
  return agencyId;
};

try {
  if (values.cutover && values.reopen) throw new TypeError('--cutover and --reopen exclude each other');
  await configureDb(loadConfigOrExit(dbEnv));

  if (values.cutover || values.reopen) {
    if (!values.agency?.length) throw new TypeError('--cutover / --reopen need --agency <legacy id>');
    for (const legacyAgencyId of values.agency) {
      const agencyId = await agencyOf(legacyAgencyId);
      await migration.markLegacyAgencyCutOver({ legacyAgencyId, agencyId, cutOver: values.cutover });
      log.info(
        { legacyAgencyId, cutOver: values.cutover },
        values.cutover ? 'delta stopped (cut over)' : 'delta re-opened',
      );
    }
  } else {
    const url = values.url ?? process.env.LEGACY_DATABASE_URL;
    if (!url) throw new TypeError('--url or LEGACY_DATABASE_URL is required (read-only legacy access)');
    const entities = readEntityMap(values.map);
    const agencies: { legacyAgencyId: string; agencyId: string }[] = [];
    if (values.agency?.length) {
      for (const legacyAgencyId of values.agency)
        agencies.push({ legacyAgencyId, agencyId: await agencyOf(legacyAgencyId) });
    } else {
      for await (const page of migration.deltaAgencies()) agencies.push(...page);
    }
    let attention = 0;
    for (const a of agencies) {
      try {
        const reader = await openLegacyDeltaReader({ url, legacyAgencyId: a.legacyAgencyId, entities });
        try {
          const r = await migration.syncLegacyDelta({ ...a, source: reader, dryRun: values['dry-run'] });
          const summary = {
            legacyAgencyId: a.legacyAgencyId,
            modes: reader.modes,
            skipped: r.skipped,
            since: r.since,
            watermark: r.watermark,
            counts: r.load?.report.counts,
            stoppedAt: r.load?.stoppedAt ?? null,
            withdrawn: r.withdrawn,
            withdrawGuard: r.withdrawGuard,
          };
          if (summary.stoppedAt || r.withdrawGuard) {
            attention += 1;
            log.warn(summary, 'delta needs attention (a re-run resumes from the same watermark)');
          } else log.info(summary, 'delta done');
        } finally {
          await reader.close();
        }
      } catch (err) {
        attention += 1;
        // Code, constraint and ids only: a database message may quote personal data.
        log.error({ legacyAgencyId: a.legacyAgencyId, error: migration.failureOf(err, null) }, 'delta failed');
      }
    }
    log.info({ agencies: agencies.length, attention, dryRun: values['dry-run'] }, 'done');
    if (attention > 0) process.exitCode = 1;
  }
} catch (err) {
  log.error({ error: err instanceof TypeError ? err.message : migration.failureOf(err, null) }, 'legacy delta failed');
  process.exitCode = 1;
} finally {
  await closeQueues();
  await closeCache();
  await closeDb();
}
