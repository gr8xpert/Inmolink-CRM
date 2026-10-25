import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, queueFor, stableJobId } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { withStaffCtx } from '../../../staff';
import { createFounder } from '../../../testing/factories';
import * as admin from '../index';

/**
 * Staff bulk operations, S13-03 review: the replay policy and cap, RLS on staff writes, bounded resumable steps,
 * continuations, the final-attempt failure, cancelling mid-run, idempotent steps and the lost-job sweep.
 */

const log = createLogger({ service: 'admin-ops-int', level: 'silent' });
const RUN = newId().slice(-8);
const REASON = 'Ticket 4712: rebuild after the builder change';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('admin.ops.int.test', fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'admin ops int test' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    return /row-level security|permission denied/.test(cause) ? 'RLS' : `unexpected: ${cause}`;
  }
  return 'accepted';
}

const jobCtx = (attempt = 1) => ({
  log,
  jobId: newId(),
  attempt,
  progress: async () => {},
  signal: new AbortController().signal,
});

const window = () => ({
  since: new Date(Date.now() - 60_000).toISOString(),
  until: new Date(Date.now() + 60_000).toISOString(),
});

const opRow = (id: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ state: string; cursor: string | null; done: number; error_code: string | null }>(
      sql`select state, cursor, done, error_code from staff_operations where id = ${id}::uuid`,
    );
    return r.rows[0];
  });

let superAdmin: string;
let dataOps: string;
let support: string;

/** Ends this file's active operations (admin.int.test.ts runs concurrently: never touch its rows). */
const endActive = () =>
  system((tx) =>
    tx.execute(sql`update staff_operations set state = 'CANCELLED', finished_at = now()
      where state in ('QUEUED', 'RUNNING')
        and requested_by = any(${`{${[superAdmin, dataOps, support].join(',')}}`}::uuid[])`),
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-admin-ops-${RUN}`, logger: log });
  admin.configureAdmin({ replayPaceMs: 0 });
  superAdmin = (await createStaffUser('SUPER_ADMIN')).userId;
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  // Leftovers of an interrupted earlier run of this file's all-agency kind.
  await system((tx) =>
    tx.execute(sql`update staff_operations set state = 'CANCELLED', finished_at = now()
      where state in ('QUEUED', 'RUNNING') and target_agency_id is null and kind = 'REIMPORT'`),
  );
}, 180_000);

afterEach(async () => {
  admin.configureAdmin({ replayPaceMs: 0 });
  await endActive();
});

afterAll(async () => {
  admin.configureAdmin();
  await closeQueues();
  await closeDb();
});

describe('outbox replay policy (S13-03 review)', () => {
  it('[S13-03] data ops replay projection-only events; other types need a super admin; mail, billing and identity never', async () => {
    const m = await createFounder();
    const start = (userId: string, type: string) =>
      refusal(
        asStaff(userId, (ctx) =>
          admin.startOperation(ctx, {
            kind: 'REPLAY_OUTBOX',
            agencyId: m.agencyId,
            reason: REASON,
            replay: { ...window(), type, deadOnly: false },
          }),
        ),
      );
    expect(await start(dataOps, 'properties.listing.updated')).toBe('accepted');
    await endActive();
    expect(await start(dataOps, 'agencies.status.changed')).toBe('OUTBOX_REPLAY_TYPE_REFUSED');
    expect(await start(superAdmin, 'agencies.status.changed')).toBe('accepted');
    await endActive();
    for (const type of [
      'identity.passwordReset.requested',
      'billing.plan.changed',
      'notifications.notification.created',
      'crm.lead.created',
      'search.listings.changed',
      'websites.lead.received',
    ]) {
      expect(await start(superAdmin, type), type).toBe('OUTBOX_REPLAY_TYPE_REFUSED');
    }
    expect(admin.replayClass('properties.listing.updated')).toBe('SAFE');
  });

  it('[S13-03] a replay window over the configured cap ends FAILED (REPLAY_TOO_LARGE) without re-queueing anything', async () => {
    const m = await createFounder();
    const type = `test.s1303cap${RUN.replace(/[^a-z0-9]/gi, '')}.done`;
    await system((tx) =>
      tx.execute(sql`insert into outbox_events (id, agency_id, type, version, payload, processed_at)
        select gen_random_uuid(), ${m.agencyId}::uuid, ${type}, 1, '{}'::jsonb, now()
        from generate_series(1, 3)`),
    );
    try {
      admin.configureAdmin({ replayPaceMs: 0, replayMaxEvents: 2 });
      const op = await asStaff(superAdmin, (ctx) =>
        admin.startOperation(ctx, {
          kind: 'REPLAY_OUTBOX',
          agencyId: m.agencyId,
          reason: REASON,
          replay: { ...window(), type, deadOnly: false },
        }),
      );
      expect(await admin.runStaffOperation(op.id)).toMatchObject({ state: 'FAILED', more: false });
      expect((await opRow(op.id))?.error_code).toBe('REPLAY_TOO_LARGE');
      const pending = await system((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from outbox_events where type = ${type} and processed_at is null`,
        ),
      );
      expect(pending.rows[0]?.n).toBe(0);
    } finally {
      await system((tx) => tx.execute(sql`delete from outbox_events where type = ${type}`));
    }
  });
});

describe('RLS on staff writes (S13-03 review)', () => {
  it('[S13-03] support cannot insert operations, flags or the operation event directly; data ops cannot write flags', async () => {
    const insertOp = (userId: string) =>
      refusal(
        asStaff(userId, (ctx) =>
          ctx.tx.execute(sql`insert into staff_operations (id, kind, reason, requested_by)
            values (${newId()}::uuid, 'REINDEX', 'direct', ${userId}::uuid)`),
        ),
      );
    expect(await insertOp(support)).toBe('RLS');
    const key = `test.rls-${RUN.toLowerCase()}`;
    expect(
      await refusal(
        asStaff(dataOps, (ctx) => ctx.tx.execute(sql`insert into feature_flags (key, enabled) values (${key}, true)`)),
      ),
    ).toBe('RLS');
    const updated = await asStaff(dataOps, (ctx) =>
      ctx.tx.execute(sql`update feature_flags set enabled = not enabled`),
    );
    expect(updated.rowCount).toBe(0);
    expect(
      await refusal(
        asStaff(support, (ctx) =>
          ctx.tx.execute(sql`insert into outbox_events (id, agency_id, type, version, payload)
            values (${newId()}::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'admin.operation.requested', 1,
              ${JSON.stringify({ operationId: newId() })}::jsonb)`),
        ),
      ),
    ).toBe('RLS');
    // Nobody on staff deletes an operation (no DELETE grant).
    expect(
      await refusal(asStaff(superAdmin, (ctx) => ctx.tx.execute(sql`delete from staff_operations where false`))),
    ).toBe('RLS');
  });
});

describe('bounded, resumable steps (S13-03 review)', () => {
  it('[S13-03] a rebuild queues one page per step; the cursor carries the position inside the agency', async () => {
    const m = await createFounder();
    const targets = [newId(), newId(), newId()].sort();
    await system((tx) =>
      tx.execute(sql`insert into listing_read_models (target_id, locale, kind, agency_id, public, status, version, card, detail, etag)
        select t, 'en', 'LISTING', ${m.agencyId}::uuid, false, 'ACTIVE', 1, '{}'::jsonb, '{}'::jsonb, 'e-' || t
        from unnest(${`{${targets.join(',')}}`}::uuid[]) t`),
    );
    try {
      admin.configureAdmin({ replayPaceMs: 0, targetPage: 2 });
      const op = await asStaff(dataOps, (ctx) =>
        admin.startOperation(ctx, { kind: 'REINDEX', agencyId: m.agencyId, reason: REASON }),
      );
      const first = await admin.runStaffOperation(op.id, { maxSteps: 1 });
      expect(first).toMatchObject({ state: 'RUNNING', more: true, done: 0 });
      expect(JSON.parse((await opRow(op.id))?.cursor ?? '{}')).toEqual({
        last: null,
        cur: { agencyId: m.agencyId, kind: 'LISTING', after: targets[1] },
      });
      const rest = await admin.runStaffOperation(op.id);
      expect(rest).toMatchObject({ state: 'SUCCEEDED', done: 1 });
      const queued = await system((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from search_index_queue where target_id = any(${`{${targets.join(',')}}`}::uuid[])`,
        ),
      );
      expect(queued.rows[0]?.n).toBe(3);
    } finally {
      await system((tx) => tx.execute(sql`delete from listing_read_models where agency_id = ${m.agencyId}::uuid`));
    }
  });

  it('[S13-03] an agency-wide operation resumes after its last agency; cancelling mid-run stops before the next step', async () => {
    const op = await asStaff(dataOps, (ctx) => admin.startOperation(ctx, { kind: 'REIMPORT', reason: REASON }));
    const firstTwo = await admin.runStaffOperation(op.id, { maxSteps: 2 });
    expect(firstTwo).toMatchObject({ state: 'RUNNING', done: 2, more: true });
    const afterTwo = JSON.parse((await opRow(op.id))?.cursor ?? '{}') as { last: string };
    // Resumes after the second agency: the third step finishes the next one in id order.
    const third = await admin.runStaffOperation(op.id, { maxSteps: 1 });
    expect(third.done).toBe(3);
    const afterThree = JSON.parse((await opRow(op.id))?.cursor ?? '{}') as { last: string };
    expect(afterThree.last > afterTwo.last).toBe(true);

    // A cancel arriving while it runs: the job stops before its next step.
    const stopped = await admin.runStaffOperation(op.id, {
      onProgress: () => asStaff(dataOps, (ctx) => admin.cancelOperation(ctx, op.id)),
    });
    expect(stopped).toMatchObject({ state: 'CANCELLED', done: 4, more: false });
  });

  it('[S13-03] steps are idempotent: re-importing an agency twice leaves one active run per feed', async () => {
    const m = await createFounder();
    const conn = newId();
    await system((tx) =>
      tx.execute(sql`insert into feed_connections (id, agency_id, name, connector, url, enabled)
        values (${conn}::uuid, ${m.agencyId}::uuid, 'Twice', 'kyero', 'https://feeds.example.com/t.xml', true)`),
    );
    for (let i = 0; i < 2; i++) {
      const op = await asStaff(dataOps, (ctx) =>
        admin.startOperation(ctx, { kind: 'REIMPORT', agencyId: m.agencyId, reason: REASON }),
      );
      expect(await admin.runStaffOperation(op.id)).toMatchObject({ state: 'SUCCEEDED', done: 1 });
    }
    const runs = await system((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from feed_runs where connection_id = ${conn}::uuid`),
    );
    expect(runs.rows[0]?.n).toBe(1);
  });
});

describe('jobs: continuation, final attempt, lost jobs (S13-03 review)', () => {
  const jobOf = (id: string, slice: number) =>
    queueFor('maintenance').getJob(stableJobId('admin.runStaffOperation', `${id}:${slice}`));

  it('[S13-03] a slice that runs out of time queues its continuation under a new job ID', async () => {
    const m = await createFounder();
    const op = await asStaff(dataOps, (ctx) =>
      admin.startOperation(ctx, { kind: 'REINDEX', agencyId: m.agencyId, reason: REASON }),
    );
    admin.configureAdmin({ replayPaceMs: 0, sliceMs: 0 });
    const result = await admin.adminJobs.runStaffOperation.spec.run({ operationId: op.id }, jobCtx());
    expect(result).toMatchObject({ more: true });
    expect(await jobOf(op.id, 1)).toBeTruthy();
  });

  it('[S13-03] the last failed attempt ends the operation FAILED (audited)', async () => {
    // A replay row without its window: the first step throws.
    const id = newId();
    await system((tx) =>
      tx.execute(sql`insert into staff_operations (id, kind, reason, requested_by)
        values (${id}::uuid, 'REPLAY_OUTBOX', 'broken', ${superAdmin}::uuid)`),
    );
    const run = (attempt: number) =>
      admin.adminJobs.runStaffOperation.spec.run({ operationId: id }, jobCtx(attempt)).catch((e: Error) => e);
    expect(await run(1)).toBeInstanceOf(Error);
    expect((await opRow(id))?.state).toBe('QUEUED');
    expect(await run(3)).toBeInstanceOf(Error);
    expect(await opRow(id)).toMatchObject({ state: 'FAILED', error_code: 'INTERNAL' });
    const audit = await system((tx) =>
      tx.execute<{ metadata: Record<string, unknown> }>(
        sql`select metadata from audit_logs where type = 'staff.operation.finished' and target_id = ${id}::uuid`,
      ),
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ state: 'FAILED', errorCode: 'INTERNAL' });
  });

  it('[S13-03] the sweep re-queues an operation whose job was lost, and fails it after the recovery limit', async () => {
    const m = await createFounder();
    const op = await asStaff(dataOps, (ctx) =>
      admin.startOperation(ctx, { kind: 'REIMPORT', agencyId: m.agencyId, reason: REASON }),
    );
    const stale = (recoveries: number) =>
      system((tx) =>
        tx.execute(sql`update staff_operations set state = 'RUNNING', recoveries = ${recoveries},
          updated_at = now() - interval '1 hour' where id = ${op.id}::uuid`),
      );
    await stale(0);
    const sweep = () => admin.adminJobs.sweepStaffOperations.spec.run({}, jobCtx());
    expect(await sweep()).toMatchObject({ requeued: 1, ended: 0 });
    expect(await jobOf(op.id, 1)).toBeTruthy();
    expect((await opRow(op.id))?.state).toBe('RUNNING');

    await stale(admin.MAX_RECOVERIES);
    expect(await sweep()).toMatchObject({ requeued: 0, ended: 1 });
    expect(await opRow(op.id)).toMatchObject({ state: 'FAILED', error_code: 'STALLED' });
  });
});
