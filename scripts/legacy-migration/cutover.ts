// pnpm legacy:cutover <command> [options] [--test]
//
// Per-agency cutover checklists (S14-06, PLAN §14 Path A step 7 and Path B; runbook docs/runbooks/cutover.md).
// Every step is recorded and audited (`migration.cutover.*`), idempotent and resumable: a run stops at the first step
// it cannot complete (reason code) and the next run resumes there; `rollback` undoes the reversible steps in reverse.
//
//   plan      --agency <uuid> --path A --legacy <legacy agency id> [--scheduled YYYY-MM-DD]
//   plan      --agency <uuid> --path B [--provider <name>] [--renewal YYYY-MM-DD] [--scheduled YYYY-MM-DD]
//             [--area <location uuid>]... [--old-area-listings <n>]
//   run       --agency <uuid> [--url <legacy postgres url> | LEGACY_DATABASE_URL] [--map <entities.json>]
//             [--confirm FREEZE|SWITCH_FEED|PARITY]...
//   rollback  --agency <uuid> [--confirm FREEZE|SWITCH_FEED]... [--force]
//   status    --agency <uuid>
//   parity    --agency <uuid>                         (Path B: v2 network listings in the area vs the old provider's)
//   due       [--days <n>]                            (renewal tracking: checklists scheduled within n days, default 30)
//   dns-check                                         (legacy API hostname: migrated agencies without a PASS report)
//
// `--confirm` records a manual step the operator did outside v2: FREEZE (legacy set read-only by hand — or, on
// rollback, writable again), SWITCH_FEED (the managed website switched to v2 — or back to both inventories), PARITY
// (accept the area without the count). The legacy database is only opened read-only (the final delta).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as migration from '@inmolink/core/modules/migration';
import { closeDb, configureDb, dbEnv } from '@inmolink/db';
import { closeCache } from '@inmolink/platform/cache';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues } from '@inmolink/platform/queue';
import { readStackEnv } from '../ops/stack-env';
import { openLegacyDeltaReader } from './delta-lib';
import type { EntitySpec } from './extract-lib';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    test: { type: 'boolean', default: false },
    agency: { type: 'string' },
    path: { type: 'string' },
    legacy: { type: 'string' },
    provider: { type: 'string' },
    renewal: { type: 'string' },
    scheduled: { type: 'string' },
    area: { type: 'string', multiple: true },
    'old-area-listings': { type: 'string' },
    url: { type: 'string' },
    map: { type: 'string' },
    confirm: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    days: { type: 'string' },
  },
});

if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'legacy:cutover', level: process.env.LOG_LEVEL });

const CONFIRMATIONS: readonly migration.CutoverConfirmation[] = ['FREEZE', 'SWITCH_FEED', 'PARITY'];

function agency(): string {
  if (!values.agency) throw new TypeError('--agency <v2 agency uuid> is required');
  return values.agency;
}

function confirmations(): migration.CutoverConfirmation[] {
  return (values.confirm ?? []).map((c) => {
    const v = c.toUpperCase() as migration.CutoverConfirmation;
    if (!CONFIRMATIONS.includes(v)) throw new TypeError(`--confirm ${c}: one of ${CONFIRMATIONS.join(', ')}`);
    return v;
  });
}

function whole(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`--${name} must be a whole number`);
  return n;
}

/** The checklist without its step records' noise, for the operator's log. */
const summary = (c: migration.CutoverDto | null) =>
  c && {
    id: c.id,
    path: c.path,
    legacyAgencyId: c.legacyAgencyId,
    state: c.state,
    scheduledFor: c.scheduledFor,
    renewalDate: c.renewalDate,
    inventoryMode: c.inventoryMode,
    lastError: c.lastError,
    steps: Object.fromEntries(Object.entries(c.steps).map(([k, s]) => [k, s.status])),
  };

try {
  const [command] = positionals;
  await configureDb(loadConfigOrExit(dbEnv));
  switch (command) {
    case 'plan': {
      const c = await migration.planCutover({
        agencyId: agency(),
        // Validated by `CutoverPlanInput` (A or B).
        path: values.path as 'A' | 'B',
        legacyAgencyId: values.legacy,
        provider: values.provider,
        renewalDate: values.renewal,
        scheduledFor: values.scheduled,
        areaLocationIds: values.area ?? [],
        oldAreaListings: whole('old-area-listings', values['old-area-listings']),
      });
      log.info(summary(c), 'cutover planned');
      break;
    }
    case 'run': {
      const agencyId = agency();
      const url = values.url ?? process.env.LEGACY_DATABASE_URL;
      const entities: EntitySpec[] | undefined = values.map ? JSON.parse(readFileSync(values.map, 'utf8')) : undefined;
      const r = await migration.runCutover({
        agencyId,
        confirm: confirmations(),
        // The final delta's snapshot, opened only when that step is due.
        openSource: url ? (legacyAgencyId) => openLegacyDeltaReader({ url, legacyAgencyId, entities }) : undefined,
      });
      const c = await migration.getCutover(agencyId);
      if (r.stoppedAt) {
        log.warn({ ...r, cutover: summary(c) }, 'cutover stopped: fix the reason and run again (it resumes there)');
        process.exitCode = 1;
      } else log.info({ ...r, cutover: summary(c) }, 'cutover complete');
      break;
    }
    case 'rollback': {
      const agencyId = agency();
      const r = await migration.rollbackCutover({ agencyId, confirm: confirmations(), force: values.force });
      const c = await migration.getCutover(agencyId);
      if (r.stoppedAt) {
        log.warn({ ...r, cutover: summary(c) }, 'rollback stopped: confirm the manual step and run again');
        process.exitCode = 1;
      } else log.info({ ...r, cutover: summary(c) }, 'cutover rolled back');
      break;
    }
    case 'status':
      log.info({ cutover: await migration.getCutover(agency()) }, 'cutover status');
      break;
    case 'parity':
      log.info(await migration.areaParity(agency()), 'area parity');
      break;
    case 'due': {
      const days = whole('days', values.days) ?? 30;
      const due = await migration.dueCutovers({ days });
      log.info({ days, due: due.map(summary) }, `${due.length} cutover(s) scheduled within ${days} days`);
      break;
    }
    case 'dns-check': {
      const r = await migration.legacyDnsReadiness();
      if (!r.ready) {
        log.warn(r, 'legacy hostname NOT ready: every migrated agency needs a PASS validation report');
        process.exitCode = 1;
      } else log.info(r, 'legacy hostname ready for the DNS switch');
      break;
    }
    default:
      throw new TypeError('command: plan | run | rollback | status | parity | due | dns-check');
  }
} catch (err) {
  const error =
    err instanceof migration.CutoverError
      ? err.code
      : err instanceof TypeError
        ? err.message
        : err instanceof Error && err.name === 'ZodError'
          ? `invalid ${(err as unknown as { issues: { path: unknown[] }[] }).issues.map((i) => i.path.join('.')).join(', ')}`
          : migration.failureOf(err, null);
  log.error({ error }, 'legacy cutover failed');
  process.exitCode = 1;
} finally {
  await closeQueues();
  await closeCache();
  await closeDb();
}
