// pnpm ops:replay-outbox [--test] [--type <t>] [--since <iso>] [--until <iso>] [--agency <uuid>] [--id <uuid> …] [--dead] [--dry-run]
//
// Re-queues processed or dead-lettered outbox events for delivery (PLAN §5.3 #6: consumers are
// idempotent and replayable). Use after fixing a consumer bug, or after redis-queue lost data.
// At least one of --type, --since with --until, --id or --dead is required.
import { parseArgs } from 'node:util';
import { closeDb, configureDb, dbEnv, withSystem } from '@inmolink/db';
import { loadConfigOrExit } from '@inmolink/platform/config';
import { createLogger } from '@inmolink/platform/logger';
import { countReplayable, type ReplayFilter, replayOutboxBatch } from '@inmolink/platform/outbox';
import { readStackEnv } from './stack-env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { values } = parseArgs({
  options: {
    test: { type: 'boolean', default: false },
    type: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    agency: { type: 'string' },
    id: { type: 'string', multiple: true },
    dead: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

function date(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`--${name} must be an ISO date`);
  return d;
}

// Locally, read the stack's env file (dev or --test) unless real credentials are already set.
if (process.env.NODE_ENV !== 'production' && !Object.keys(process.env).some((k) => k.startsWith('DATABASE_URL_'))) {
  for (const [k, v] of Object.entries(readStackEnv(values.test ? 'test' : 'dev'))) process.env[k] ??= v;
}
process.env.APP_ROLE = 'script';
const log = createLogger({ service: 'ops:replay-outbox', level: process.env.LOG_LEVEL });

try {
  for (const id of values.id ?? []) if (!UUID.test(id)) throw new TypeError(`--id ${id} is not a UUID`);
  if (values.agency && !UUID.test(values.agency)) throw new TypeError('--agency must be a UUID');
  const filter: ReplayFilter = {
    ids: values.id,
    type: values.type,
    since: date('since', values.since),
    until: date('until', values.until),
    agencyId: values.agency,
    deadOnly: values.dead,
  };
  await configureDb(loadConfigOrExit(dbEnv));
  const matching = await withSystem('ops.replay-outbox.count', (tx) => countReplayable(tx, filter));
  log.info({ filter, matching }, values['dry-run'] ? 'dry run: events that would be replayed' : 'replaying');
  if (!values['dry-run']) {
    let total = 0;
    let afterId: string | undefined;
    for (;;) {
      const batch = await withSystem('ops.replay-outbox', (tx) => replayOutboxBatch(tx, filter, { afterId }));
      if (batch.replayed === 0) break;
      total += batch.replayed;
      afterId = batch.lastId;
    }
    log.info({ replayed: total }, 'replay queued; the dispatcher delivers them now');
  }
} catch (err) {
  log.error({ err }, 'replay failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
