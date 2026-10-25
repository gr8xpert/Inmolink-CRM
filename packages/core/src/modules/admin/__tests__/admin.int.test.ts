import { readFileSync } from 'node:fs';
import type { StartStaffOperationBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { setFlag } from '@inmolink/platform/flags';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffCtx } from '../../../context';
import { withStaffCtx } from '../../../staff';
import { createFounder } from '../../../testing/factories';
import * as billing from '../../billing';
import * as admin from '../index';

/**
 * Staff console operations (S13-03): bulk operations run as audited jobs with progress and can be cancelled; plan
 * grants and price locks are audited in the transaction that makes them; flags, queue health and AI spend per tenant.
 */

const log = createLogger({ service: 'admin-int', level: 'silent' });
const RUN = newId().slice(-8);
const REASON = 'Ticket 4711: the index drifted after the taxonomy rename';
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('admin.int.test', fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'admin int test' }, fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

const auditRows = (type: string, targetId: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ actor_kind: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
      sql`select actor_kind, actor_user_id, metadata from audit_logs
          where type = ${type} and target_id = ${targetId}::uuid order by occurred_at`,
    );
    return r.rows;
  });

let superAdmin: string;
let dataOps: string;
let support: string;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-admin-${RUN}`, logger: log });
  const file = JSON.parse(
    readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
  ) as { items: billing.CatalogInput[] };
  await system((tx) => billing.upsertCatalog(tx, file.items, newId));
  superAdmin = (await createStaffUser('SUPER_ADMIN')).userId;
  dataOps = (await createStaffUser('STAFF_DATA_OPS')).userId;
  support = (await createStaffUser('STAFF_SUPPORT')).userId;
  // One active operation per kind and scope: end the all-agency ones of the kinds this file runs that an interrupted
  // earlier run left behind (operations.int.test.ts runs REIMPORT across agencies, concurrently).
  await system((tx) =>
    tx.execute(sql`update staff_operations set state = 'CANCELLED', finished_at = now()
      where state in ('QUEUED', 'RUNNING') and target_agency_id is null
        and kind in ('REINDEX', 'REBUILD_READ_MODELS', 'REPLAY_OUTBOX')`),
  );
}, 180_000);

afterAll(async () => {
  await closeQueues();
  await closeDb();
});

describe('bulk operations (S13-03)', () => {
  it('[S13-03] starting a bulk operation is audited, asks for its job, and is one at a time per kind and scope', async () => {
    const m = await createFounder();
    const body: StartStaffOperationBody = { kind: 'REIMPORT', agencyId: m.agencyId, reason: REASON };
    expect(await refusal(asStaff(support, (ctx) => admin.startOperation(ctx, body)))).toBe('FORBIDDEN');
    const op = await asStaff(dataOps, (ctx) => admin.startOperation(ctx, body));
    expect(op).toMatchObject({ kind: 'REIMPORT', agencyId: m.agencyId, state: 'QUEUED', done: 0, reason: REASON });
    expect(await refusal(asStaff(superAdmin, (ctx) => admin.startOperation(ctx, body)))).toBe('STAFF_OPERATION_ACTIVE');

    const [started] = await auditRows('staff.operation.started', op.id);
    expect(started).toMatchObject({ actor_kind: 'staff', actor_user_id: dataOps });
    expect(started?.metadata).toEqual({ kind: 'REIMPORT', scope: 'AGENCY' });
    expect(JSON.stringify(started?.metadata)).not.toContain('Ticket');
    const events = await system((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from outbox_events
        where type = 'admin.operation.requested' and payload->>'operationId' = ${op.id}`),
    );
    expect(events.rows[0]?.n).toBe(1);

    // The job runs it to the end with progress, and audits the end (actor: system).
    const progress: unknown[] = [];
    const result = await admin.runStaffOperation(op.id, { onProgress: (p) => progress.push(p) });
    expect(result).toMatchObject({ state: 'SUCCEEDED', done: 1, more: false });
    expect(progress).toEqual([{ done: 1, total: 1 }]);
    const after = await asStaff(support, (ctx) => admin.getOperation(ctx, op.id));
    expect(after).toMatchObject({ state: 'SUCCEEDED', done: 1, total: 1 });
    // The free-text reason is for operators (data ops, super admins) only.
    expect(after.reason).toBeNull();
    expect((await asStaff(dataOps, (ctx) => admin.getOperation(ctx, op.id))).reason).toBe(REASON);
    expect(after.finishedAt).not.toBeNull();
    const [finished] = await auditRows('staff.operation.finished', op.id);
    expect(finished).toMatchObject({ actor_kind: 'system' });
    expect(finished?.metadata).toMatchObject({ kind: 'REIMPORT', state: 'SUCCEEDED', done: 1, total: 1 });
    // Finished: a new one of the same kind and scope may start.
    const again = await asStaff(dataOps, (ctx) => admin.startOperation(ctx, body));
    await asStaff(dataOps, (ctx) => admin.cancelOperation(ctx, again.id));

    const page = await asStaff(support, (ctx) => admin.listOperations(ctx, { limit: 100 }));
    expect(page.items.map((i) => i.id)).toEqual(expect.arrayContaining([op.id, again.id]));
  });

  it('[S13-03] a re-import queues a run of each enabled, unpaused feed of the agency, announced in its step', async () => {
    const m = await createFounder();
    const [on, paused, off] = [newId(), newId(), newId()];
    await system((tx) =>
      tx.execute(sql`insert into feed_connections (id, agency_id, name, connector, url, enabled, paused_at, pause_reason) values
        (${on}::uuid, ${m.agencyId}::uuid, 'On', 'kyero', 'https://feeds.example.com/a.xml', true, null, null),
        (${paused}::uuid, ${m.agencyId}::uuid, 'Paused', 'kyero', 'https://feeds.example.com/b.xml', true, now(), 'EMPTY_FEED'),
        (${off}::uuid, ${m.agencyId}::uuid, 'Off', 'kyero', 'https://feeds.example.com/c.xml', false, null, null)`),
    );
    const op = await asStaff(dataOps, (ctx) =>
      admin.startOperation(ctx, { kind: 'REIMPORT', agencyId: m.agencyId, reason: REASON }),
    );
    expect(await admin.runStaffOperation(op.id)).toMatchObject({ state: 'SUCCEEDED', done: 1 });
    const runs = await system((tx) =>
      tx.execute<{ connection_id: string; trigger: string }>(
        sql`select connection_id, trigger from feed_runs where agency_id = ${m.agencyId}::uuid`,
      ),
    );
    expect(runs.rows).toEqual([{ connection_id: on, trigger: 'MANUAL' }]);
    const requested = await system((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from outbox_events
        where type = 'imports.run.requested' and agency_id = ${m.agencyId}::uuid`),
    );
    expect(requested.rows[0]?.n).toBe(1);
  });

  it('[S13-03] an outbox replay re-queues the window a batch at a time and reports progress', async () => {
    const type = `test.s1303${RUN.replace(/[^a-z0-9]/gi, '')}.replayed`;
    const since = new Date(Date.now() - 60_000);
    await system((tx) =>
      tx.execute(sql`insert into outbox_events (id, agency_id, type, version, payload, processed_at)
        select gen_random_uuid(), '00000000-0000-0000-0000-000000000000'::uuid, ${type}, 1, '{}'::jsonb, now()
        from generate_series(1, 3)`),
    );
    try {
      const op = await asStaff(superAdmin, (ctx) =>
        admin.startOperation(ctx, {
          kind: 'REPLAY_OUTBOX',
          reason: REASON,
          replay: {
            since: since.toISOString(),
            until: new Date(Date.now() + 60_000).toISOString(),
            type,
            deadOnly: false,
          },
        }),
      );
      const result = await admin.runStaffOperation(op.id);
      expect(result).toMatchObject({ state: 'SUCCEEDED', done: 3 });
      const view = await asStaff(support, (ctx) => admin.getOperation(ctx, op.id));
      expect(view).toMatchObject({ state: 'SUCCEEDED', done: 3, total: 3 });
      expect(view.replay).toMatchObject({ type, deadOnly: false });
      const pending = await system((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from outbox_events where type = ${type} and processed_at is null`,
        ),
      );
      expect(pending.rows[0]?.n).toBe(3);
    } finally {
      await system((tx) => tx.execute(sql`delete from outbox_events where type = ${type}`));
    }
  });

  it('[S13-03] a running operation can be cancelled: it stops before its next step; a queued one ends at once', async () => {
    const op = await asStaff(superAdmin, (ctx) => admin.startOperation(ctx, { kind: 'REINDEX', reason: REASON }));
    // The first slice counts the agencies and marks it RUNNING, then its time box is out (no step taken).
    const first = await admin.runStaffOperation(op.id, { budgetMs: 0 });
    expect(first).toMatchObject({ state: 'RUNNING', done: 0, more: true });
    const running = await asStaff(support, (ctx) => admin.getOperation(ctx, op.id));
    expect(running.state).toBe('RUNNING');
    expect(running.total).toBeGreaterThan(0);

    expect(await refusal(asStaff(support, (ctx) => admin.cancelOperation(ctx, op.id)))).toBe('FORBIDDEN');
    const asked = await asStaff(dataOps, (ctx) => admin.cancelOperation(ctx, op.id));
    expect(asked).toMatchObject({ state: 'RUNNING', cancelRequested: true });
    const next = await admin.runStaffOperation(op.id);
    expect(next).toMatchObject({ state: 'CANCELLED', done: 0, more: false });
    expect((await asStaff(support, (ctx) => admin.getOperation(ctx, op.id))).state).toBe('CANCELLED');
    expect((await auditRows('staff.operation.cancelled', op.id))[0]).toMatchObject({ actor_user_id: dataOps });
    expect((await auditRows('staff.operation.finished', op.id))[0]?.metadata).toMatchObject({ state: 'CANCELLED' });

    const queued = await asStaff(superAdmin, (ctx) =>
      admin.startOperation(ctx, { kind: 'REBUILD_READ_MODELS', reason: REASON }),
    );
    const cancelled = await asStaff(superAdmin, (ctx) => admin.cancelOperation(ctx, queued.id));
    expect(cancelled).toMatchObject({ state: 'CANCELLED', cancelRequested: true });
    expect(await admin.runStaffOperation(queued.id)).toMatchObject({ state: 'CANCELLED', more: false });
    // Cancelling a finished operation changes nothing.
    expect((await asStaff(superAdmin, (ctx) => admin.cancelOperation(ctx, queued.id))).state).toBe('CANCELLED');
    expect(await refusal(asStaff(superAdmin, (ctx) => admin.cancelOperation(ctx, newId())))).toBe(
      'STAFF_OPERATION_NOT_FOUND',
    );
  });
});

describe('plan grants and price locks (S13-03)', () => {
  it('[S13-03] grant, revoke and price lock write their audit rows (no free text); the revoke reason stays on the grant', async () => {
    const m = await createFounder();
    const endsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const body = { agencyId: m.agencyId, planCode: 'pro', endsAt, reason: 'founding pilot' };
    expect(await refusal(asStaff(support, (ctx) => admin.grantPlan(ctx, body)))).toBe('FORBIDDEN');
    const grant = await asStaff(superAdmin, (ctx) => admin.grantPlan(ctx, body));
    const [granted] = await auditRows('staff.billing.planGranted', grant.id);
    expect(granted).toMatchObject({ actor_kind: 'staff', actor_user_id: superAdmin });
    expect(granted?.metadata).toMatchObject({ planCode: 'pro' });

    const revokeReason = 'Ticket 9: the pilot ended early at the agency request';
    const revoked = await asStaff(superAdmin, (ctx) => admin.revokePlanGrant(ctx, grant.id, { reason: revokeReason }));
    expect(revoked.revokedAt).not.toBeNull();
    // The free-text reason stays on the grant (staff read it), never in the agency's audit log.
    expect((await auditRows('staff.billing.grantRevoked', grant.id))[0]?.metadata).toEqual({ planCode: 'pro' });

    const lock = await asStaff(superAdmin, (ctx) =>
      admin.setPriceLock(ctx, {
        agencyId: m.agencyId,
        planCode: 'pro',
        interval: 'YEAR',
        currency: 'EUR',
        amountCents: 9_900,
        endsAt,
        reason: 'founding price',
      }),
    );
    expect((await auditRows('staff.billing.priceLockSet', lock.id))[0]?.metadata).toMatchObject({
      planCode: 'pro',
      amountCents: 9_900,
    });

    const view = await asStaff(support, (ctx) => admin.listAgencyBilling(ctx, m.agencyId));
    expect(view.grants.find((g) => g.id === grant.id)).toMatchObject({
      kind: 'STAFF',
      reason: 'founding pilot',
      grantedBy: superAdmin,
      revokedBy: superAdmin,
      revokeReason,
    });
    expect(view.priceLocks).toEqual([expect.objectContaining({ id: lock.id, amountCents: 9_900 })]);
  });

  it('[S13-03] a refused grant writes no audit row (one transaction)', async () => {
    const m = await createFounder();
    const before = await system((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs
        where type = 'staff.billing.planGranted' and agency_id = ${m.agencyId}::uuid`),
    );
    const code = await refusal(
      asStaff(superAdmin, (ctx) =>
        admin.grantPlan(ctx, {
          agencyId: m.agencyId,
          planCode: 'platinum',
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'nope',
        }),
      ),
    );
    expect(code).toBe('BILLING_PRICE_UNAVAILABLE');
    const after = await system((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs
        where type = 'staff.billing.planGranted' and agency_id = ${m.agencyId}::uuid`),
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe('feature flags, queue health and AI spend (S13-03)', () => {
  it('[S13-03] super admins set a flag default and an agency override (audited); others read only', async () => {
    const m = await createFounder();
    const key = `test.s1303-${RUN.toLowerCase()}`;
    await system((tx) => setFlag(tx, key, { enabled: false, description: 'S13-03 test flag' }));
    const listed = await asStaff(support, (ctx) => admin.listFeatureFlags(ctx));
    expect(listed.items.find((f) => f.key === key)).toMatchObject({ enabled: false, enabledFor: [] });

    expect(await refusal(asStaff(dataOps, (ctx) => admin.setFeatureFlag(ctx, key, { enabled: true })))).toBe(
      'FORBIDDEN',
    );
    expect(
      await refusal(asStaff(superAdmin, (ctx) => admin.setFeatureFlag(ctx, `${key}-unknown`, { enabled: true }))),
    ).toBe('NOT_FOUND');
    const on = await asStaff(superAdmin, (ctx) =>
      admin.setFeatureFlag(ctx, key, { agencyId: m.agencyId, override: true }),
    );
    expect(on.items.find((f) => f.key === key)).toMatchObject({ enabled: false, enabledFor: [m.agencyId] });
    const def = await asStaff(superAdmin, (ctx) => admin.setFeatureFlag(ctx, key, { enabled: true }));
    expect(def.items.find((f) => f.key === key)).toMatchObject({ enabled: true });

    const audits = await system((tx) =>
      tx.execute<{ agency_id: string; metadata: Record<string, unknown> }>(
        sql`select agency_id, metadata from audit_logs where type = 'staff.featureFlag.changed'
            and metadata->>'key' = ${key} order by occurred_at`,
      ),
    );
    expect(audits.rows.map((r) => r.metadata)).toEqual([
      { key, override: true },
      { key, enabled: true },
    ]);
    expect(audits.rows[0]?.agency_id).toBe(m.agencyId);
    await system((tx) => tx.execute(sql`delete from feature_flags where key = ${key}`));
  });

  it('[S13-03] queue health counts jobs per pool (outbox runs no queue)', async () => {
    const health = await admin.getQueueHealth((fn) =>
      withStaffCtx({ userId: support, requestId: newId(), reason: 'admin int test' }, fn),
    );
    expect(health.reachable).toBe(true);
    expect(health.pools.map((p) => p.pool)).toContain('maintenance');
    expect(health.pools.map((p) => p.pool)).not.toContain('outbox');
    for (const p of health.pools) expect(p.waiting).toBeGreaterThanOrEqual(0);
  });

  it('[S13-03] AI spend per tenant: the month, highest spend first, with agency names and the total', async () => {
    const [a, b] = [await createFounder(), await createFounder()];
    // A month no other test writes.
    const month = `20${40 + (Number.parseInt(RUN.slice(-2), 16) % 50)}-03`;
    await system((tx) =>
      tx.execute(sql`insert into ai_usage_monthly (agency_id, month, cost_micro_usd, calls, input_tokens, output_tokens)
        values (${a.agencyId}::uuid, ${`${month}-01`}::date, 1500000, 10, 1000, 200),
               (${b.agencyId}::uuid, ${`${month}-01`}::date, 4000000, 30, 3000, 600)`),
    );
    try {
      const spend = await asStaff(support, (ctx) => admin.getAiSpend(ctx, { month }));
      expect(spend.month).toBe(month);
      expect(spend.items.map((i) => i.agencyId)).toEqual([b.agencyId, a.agencyId]);
      expect(spend.items[0]).toMatchObject({ costMicroUsd: 4_000_000, calls: 30, agencyName: expect.any(String) });
      expect(spend.totalMicroUsd).toBe(5_500_000);
    } finally {
      await system((tx) => tx.execute(sql`delete from ai_usage_monthly where month = ${`${month}-01`}::date`));
    }
  });
});
