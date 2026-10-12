import { closeDb, setAuthScope, withAuth, withStaff, withSystem, withTenant } from '@inmolink/db';
import { adminQuery, createStaffUser, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import * as compliance from '../index';

/** The audit log on the real test database (S1-08): append-only, partitioned by month, read by admins. */

beforeAll(async () => {
  await setupTestDb('worker');
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  await closeDb();
});

const APP_ROLES = ['app_user', 'app_system', 'app_public', 'app_auth', 'app_staff'] as const;

const as = <T>(
  f: { userId: string; agencyId: string },
  fn: (ctx: Ctx) => Promise<T>,
  over: { impersonatedBy?: string; requestId?: string } = {},
) =>
  withMemberCtx(
    { userId: f.userId, agencyId: f.agencyId, requestId: over.requestId ?? newId(), locale: 'en' },
    async (ctx) => fn(over.impersonatedBy ? await impersonatedCtx(ctx, over.impersonatedBy) : ctx),
  );

/** Demotes the founder to AGENT (written as an admin would, without the guard trigger). */
const demote = (f: Founder) =>
  withSystem('audit test: demote', (tx) =>
    tx.execute(sql`update agency_members set role = 'AGENT' where user_id = ${f.userId}`),
  );

/** The partition a row written at the start of month `now + months` would land in (rolled back). */
async function partitionFor(months: number): Promise<string> {
  class Rollback extends Error {}
  let partition = '';
  await withSystem('audit test: probe partition', async (tx) => {
    const r = await tx.execute<{ p: string }>(
      sql`insert into audit_logs (id, occurred_at, agency_id, type, actor_kind)
          values (${newId()}, date_trunc('month', now()) + make_interval(months => ${months}), ${PLATFORM_AGENCY_ID},
                  'compliance.partition.probe', 'system')
          returning tableoid::regclass::text as p`,
    );
    partition = r.rows[0]?.p ?? '';
    throw new Rollback();
  }).catch((err) => {
    if (err instanceof Rollback) return;
    // No partition for that month (there is no default partition): Postgres refuses the row (23514).
    if ((err as { cause?: { code?: string } }).cause?.code === '23514') partition = 'none';
    else throw err;
  });
  return partition;
}

describe('audit log', () => {
  it('[S1-08] audit rows are append-only: no app role holds UPDATE, DELETE or TRUNCATE', async () => {
    const grants = await withSystem('audit test: grants', async (tx) => {
      const r = await tx.execute<{ role: string; priv: string; held: boolean }>(
        sql`select r as role, p as priv, has_table_privilege(r, 'public.audit_logs', p) as held
              from unnest(${sql.raw(`array[${APP_ROLES.map((x) => `'${x}'`).join(', ')}]`)}) r,
                   unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) p`,
      );
      return r.rows;
    });
    expect(grants).toHaveLength(APP_ROLES.length * 3);
    expect(grants.filter((g) => g.held)).toEqual([]);

    // A tenant cannot rewrite or remove its own rows; nor can a worker (app_system bypasses RLS, not grants).
    const f = await createFounder();
    await as(f, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', { type: 'user', id: f.userId }));
    for (const statement of [
      sql`update audit_logs set type = 'identity.login.succeeded' where agency_id = ${f.agencyId}`,
      sql`delete from audit_logs where agency_id = ${f.agencyId}`,
    ]) {
      await expect(withTenant({ agencyId: f.agencyId }, (tx) => tx.execute(statement))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
      await expect(withSystem('audit test: try to change', (tx) => tx.execute(statement))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    }
    const left = await withTenant({ agencyId: f.agencyId }, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_logs where agency_id = ${f.agencyId}`),
    );
    expect(left.rows[0]?.n).toBe(1);
  });

  it('[S1-08] the owner and superusers cannot update, delete or truncate audit rows either (triggers)', async () => {
    const f = await createFounder();
    await as(f, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', { type: 'user', id: f.userId }));
    for (const statement of [
      `update audit_logs set type = 'identity.login.succeeded' where agency_id = '${f.agencyId}'`,
      `delete from audit_logs where agency_id = '${f.agencyId}'`,
      'truncate audit_logs',
    ]) {
      await expect(adminQuery(statement)).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('append-only'),
      });
    }
    const [row] = await adminQuery<{ n: number }>('select count(*)::int as n from audit_logs where agency_id = $1', [
      f.agencyId,
    ]);
    expect(row?.n).toBe(1);
  });

  it('[S1-08] retention stays off and there is no default partition (pg_partman config)', async () => {
    const [config] = await adminQuery<{ retention: string | null; premake: number; infinite: boolean; dflt: number }>(
      `select retention, premake, infinite_time_partitions as infinite,
              (select count(*)::int from pg_inherits i join pg_class c on c.oid = i.inhrelid
                where i.inhparent = 'public.audit_logs'::regclass and c.relname = 'audit_logs_default') as dflt
         from partman.part_config where parent_table = 'public.audit_logs'`,
    );
    expect(config).toEqual({ retention: null, premake: 4, infinite: true, dflt: 0 });
  });

  it('[S1-08] partitions for the current and the next 3 months exist (pg_partman, premake 4)', async () => {
    for (const months of [0, 1, 2, 3]) {
      const partition = await partitionFor(months);
      expect(partition, `month +${months}`).toMatch(/^audit_logs_p\d{8}$/);
    }
  });

  it('[S1-08] the hourly maintenance job creates missing months again, idempotently', async () => {
    expect(compliance.complianceJobs.maintainPartitions.spec.every).toBe(compliance.PARTITION_MAINTENANCE_EVERY_MS);
    const newest = async () =>
      (
        await adminQuery<{ name: string }>(
          `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
            where i.inhparent = 'public.audit_logs'::regclass
            order by c.relname desc`,
        )
      ).map((x) => x.name);
    // Start from a maintained state (the test database may have been migrated in an earlier month).
    await compliance.complianceJobs.maintainPartitions.spec.run({}, {} as never);
    const before = await newest();
    // Time passes: the months +3 and +4 do not exist yet (they are empty; dropping them loses nothing).
    const dropped = before.slice(0, 2);
    try {
      await adminQuery(dropped.map((name) => `drop table public."${name}"`).join(';'));
      // No default partition: a row for a missing month fails loudly instead of hiding in a catch-all.
      expect(await partitionFor(3)).toBe('none');
    } finally {
      await compliance.complianceJobs.maintainPartitions.spec.run({}, {} as never);
    }
    expect(await newest()).toEqual(before);
    expect(await partitionFor(3)).toMatch(/^audit_logs_p\d{8}$/);
    // A second run has nothing to do.
    await compliance.complianceJobs.maintainPartitions.spec.run({}, {} as never);
    expect(await newest()).toEqual(before);
    // Partitions are never reachable directly: no app role holds a privilege on them.
    const [direct] = await adminQuery<{ n: number }>(
      `select count(*)::int as n from pg_inherits i, unnest(array['app_user','app_system','app_public','app_auth','app_staff']) r
        where i.inhparent = 'public.audit_logs'::regclass and has_table_privilege(r, i.inhrelid, 'SELECT')`,
    );
    expect(direct?.n).toBe(0);
  });

  it('[S1-08] audit() records the agency, the user, the impersonating staff member and the request', async () => {
    const f = await createFounder();
    const staffId = newId();
    const requestId = `req-${newId()}`;
    await as(
      f,
      (ctx) => compliance.audit(ctx, 'identity.member.roleChanged', { type: 'user', id: f.userId }, { to: 'AGENT' }),
      {
        impersonatedBy: staffId,
        requestId,
      },
    );
    const row = await withSystem('audit test: read', async (tx) => {
      const r = await tx.execute(
        sql`select agency_id, type, actor_kind, actor_user_id, impersonated_by, target_type, target_id, request_id, metadata
              from audit_logs where agency_id = ${f.agencyId}`,
      );
      return r.rows;
    });
    expect(row).toEqual([
      {
        agency_id: f.agencyId,
        type: 'identity.member.roleChanged',
        actor_kind: 'user',
        actor_user_id: f.userId,
        impersonated_by: staffId,
        target_type: 'user',
        target_id: f.userId,
        request_id: requestId,
        metadata: { to: 'AGENT' },
      },
    ]);
    // Metadata is bounded (and the database enforces the same bound).
    await expect(
      as(f, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', null, { blob: 'x'.repeat(5000) })),
    ).rejects.toThrow(/max 4096/);
    // A rolled-back change leaves no audit row: the row shares the change's transaction.
    await expect(
      as(f, async (ctx) => {
        await compliance.audit(ctx, 'identity.member.deactivated', { type: 'user', id: f.userId });
        throw new Error('change failed');
      }),
    ).rejects.toThrow('change failed');
    const n = await withSystem('audit test: count', async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_logs where agency_id = ${f.agencyId}`,
      );
      return r.rows[0]?.n;
    });
    expect(n).toBe(1);
  });

  it('[S1-08] auth flows append only identity rows about the user and agency they are scoped to', async () => {
    const f = await createFounder();
    const other = newId();
    const insert = (
      tx: Parameters<Parameters<typeof withAuth>[0]>[0],
      target: string,
      type = 'identity.login.failed',
    ) =>
      tx.execute(
        sql`insert into audit_logs (id, agency_id, type, actor_kind, target_type, target_id)
            values (${newId()}, ${f.agencyId}, ${type}, 'anonymous', 'user', ${target})`,
      );
    // Another user, another module's type, or no scope at all: refused.
    for (const [scope, target, type] of [
      [{ agencyId: f.agencyId, userId: f.userId }, other, 'identity.login.failed'],
      [{ agencyId: f.agencyId, userId: f.userId }, f.userId, 'agencies.verification.decided'],
      [{ agencyId: newId(), userId: f.userId }, f.userId, 'identity.login.failed'],
      [{}, f.userId, 'identity.login.failed'],
    ] as const) {
      await expect(
        withAuth(async (tx) => {
          await setAuthScope(tx, scope);
          await insert(tx, target, type);
        }),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    // app_auth cannot read the log either.
    await expect(withAuth((tx) => tx.execute(sql`select 1 from audit_logs limit 1`))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('[S1-08] members append rows only as themselves, never as staff', async () => {
    const f = await createFounder();
    const row = (actor: string | null, kind: string) =>
      sql`insert into audit_logs (id, agency_id, type, actor_kind, actor_user_id)
          values (${newId()}, ${f.agencyId}, 'identity.member.deactivated', ${kind}, ${actor})`;
    for (const [actor, kind] of [
      [newId(), 'user'],
      [f.userId, 'staff'],
    ] as const) {
      await expect(as(f, (ctx) => ctx.tx.execute(row(actor, kind)))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    }
    await as(f, (ctx) => ctx.tx.execute(row(f.userId, 'user')));
  });

  it('[S1-08] auditAuth restores the caller’s scope, and the agency must be the user’s own membership', async () => {
    const f = await createFounder();
    const other = await createFounder();
    const scope = await withAuth(async (tx) => {
      await setAuthScope(tx, { userId: f.userId });
      await compliance.auditAuth(tx, {
        type: 'identity.twoFactor.recoveryCodeUsed',
        userId: f.userId,
        agencyId: f.agencyId,
        authenticated: true,
        requestId: 'r',
      });
      const r = await tx.execute<{ a: string; u: string }>(
        sql`select current_setting('app.agency_id', true) as a, current_setting('app.user_id', true) as u`,
      );
      return r.rows[0];
    });
    expect(scope).toEqual({ a: '', u: f.userId });
    // Another agency, or the platform for a user who has an agency: refused (not self-certified).
    for (const agencyId of [other.agencyId, null]) {
      await expect(
        withAuth((tx) =>
          compliance.auditAuth(tx, {
            type: 'identity.login.failed',
            userId: f.userId,
            agencyId,
            authenticated: false,
            requestId: 'r',
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('[S1-08] staff append only staff and agencies rows naming themselves, never impersonated', async () => {
    const f = await createFounder();
    const staff = await createStaffUser();
    const insert = (type: string, impersonatedBy: string | null) =>
      withStaff({ userId: staff.userId, reason: 'audit test' }, (tx) =>
        tx.execute(
          sql`insert into audit_logs (id, agency_id, type, actor_kind, actor_user_id, impersonated_by)
              values (${newId()}, ${f.agencyId}, ${type}, 'staff', ${staff.userId}, ${impersonatedBy})`,
        ),
      );
    await insert('staff.impersonation.started', null);
    await insert('agencies.verification.decided', null);
    await expect(insert('identity.login.succeeded', null)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(insert('staff.impersonation.started', newId())).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('[S1-08] staff rows go under the agency they concern, or the platform', async () => {
    const f = await createFounder();
    const staffId = newId();
    const fakeStaff = (tx: StaffCtx['tx']): StaffCtx => ({
      tx,
      actor: { kind: 'staff', userId: staffId, role: 'STAFF_SUPPORT' },
      locale: 'en',
      requestId: newId(),
    });
    // Written through app_system here (the staff RLS predicate is covered by the agencies verification test).
    await withSystem('audit test: staff rows', async (tx) => {
      await compliance.auditStaff(fakeStaff(tx), f.agencyId, 'staff.impersonation.started', {
        type: 'user',
        id: f.userId,
      });
      await compliance.auditStaff(fakeStaff(tx), null, 'staff.impersonation.ended', { type: 'user', id: f.userId });
    });
    const rows = await withSystem('audit test: read staff rows', async (tx) => {
      const r = await tx.execute<{ agency_id: string; actor_kind: string }>(
        sql`select agency_id, actor_kind from audit_logs where actor_user_id = ${staffId} order by occurred_at, id`,
      );
      return r.rows;
    });
    expect(rows).toEqual([
      { agency_id: f.agencyId, actor_kind: 'staff' },
      { agency_id: PLATFORM_AGENCY_ID, actor_kind: 'staff' },
    ]);
  });

  it('[S1-08] admins read their agency’s log newest first in keyset pages (max 100); staff identities stay hidden', async () => {
    const f = await createFounder();
    const g = await createFounder();
    const staffId = newId();
    for (let i = 0; i < 5; i++) {
      await as(f, (ctx) => compliance.audit(ctx, 'identity.member.roleChanged', { type: 'user', id: f.userId }, { i }));
    }
    await as(f, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', null), { impersonatedBy: staffId });
    await withSystem('audit test: staff row', (tx) =>
      compliance.auditStaff(
        { tx, actor: { kind: 'staff', userId: staffId, role: 'SUPER_ADMIN' }, locale: 'en', requestId: 'r' },
        f.agencyId,
        'agencies.verification.decided',
        null,
      ),
    );
    await as(g, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', null));

    const first = await as(f, (ctx) => compliance.listAuditLog(ctx, { limit: 3 }));
    expect(first.items.map((i) => i.type)).toEqual([
      'agencies.verification.decided',
      'identity.member.deactivated',
      'identity.member.roleChanged',
    ]);
    expect(first.items[0]?.actor).toEqual({ kind: 'staff', userId: null, impersonated: false });
    expect(first.items[1]?.actor).toEqual({ kind: 'user', userId: f.userId, impersonated: true });
    expect(JSON.stringify(first)).not.toContain(staffId);
    expect(first.nextCursor).not.toBeNull();
    const rest = await as(f, (ctx) =>
      compliance.listAuditLog(ctx, { limit: 100, cursor: first.nextCursor ?? undefined }),
    );
    expect(rest.items.map((i) => i.metadata)).toEqual([{ i: 3 }, { i: 2 }, { i: 1 }, { i: 0 }]);
    expect(rest.nextCursor).toBeNull();

    // Members who are not admins, and Client Mode, cannot read it.
    await demote(g);
    await expect(as(g, (ctx) => compliance.listAuditLog(ctx, { limit: 10 }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      as(f, (ctx) => compliance.listAuditLog({ ...ctx, clientMode: true }, { limit: 10 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('[S1-09] staff read every agency’s log with both actors, filtered and in keyset pages; each read is audited', async () => {
    const f = await createFounder();
    const g = await createFounder();
    const support = await createStaffUser('STAFF_SUPPORT');
    const staffRead = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
      withStaffCtx({ userId, requestId: newId(), reason: 'audit viewer test' }, fn);
    const impersonator = newId();
    await as(f, (ctx) => compliance.audit(ctx, 'identity.member.roleChanged', { type: 'user', id: f.userId }));
    await as(f, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', null), { impersonatedBy: impersonator });
    await as(g, (ctx) => compliance.audit(ctx, 'identity.member.deactivated', null));

    // One agency, newest first, two pages; both actors visible to staff.
    const first = await staffRead(support.userId, (ctx) =>
      compliance.listAuditLogForStaff(ctx, { agencyId: f.agencyId, limit: 1 }),
    );
    expect(first.items).toEqual([
      expect.objectContaining({
        agencyId: f.agencyId,
        type: 'identity.member.deactivated',
        actor: { kind: 'user', userId: f.userId, impersonatedBy: impersonator },
      }),
    ]);
    const second = await staffRead(support.userId, (ctx) =>
      compliance.listAuditLogForStaff(ctx, { agencyId: f.agencyId, limit: 100, cursor: first.nextCursor ?? undefined }),
    );
    expect(second.items.map((i) => i.type)).toContain('identity.member.roleChanged');
    expect(second.items.map((i) => i.type)).not.toContain('identity.member.deactivated');

    // Across agencies by type and time window: both agencies' rows, no others of that type outside the window.
    const since = new Date(Date.now() - 60_000).toISOString();
    const byType = await staffRead(support.userId, (ctx) =>
      compliance.listAuditLogForStaff(ctx, { type: 'identity.member.deactivated', from: since, limit: 100 }),
    );
    expect(byType.items.map((i) => i.agencyId)).toEqual(expect.arrayContaining([f.agencyId, g.agencyId]));
    expect(new Set(byType.items.map((i) => i.type))).toEqual(new Set(['identity.member.deactivated']));
    const empty = await staffRead(support.userId, (ctx) =>
      compliance.listAuditLogForStaff(ctx, { agencyId: f.agencyId, to: since, limit: 100 }),
    );
    expect(empty.items).toEqual([]);
    await expect(
      staffRead(support.userId, (ctx) => compliance.listAuditLogForStaff(ctx, { from: since, to: since, limit: 10 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Each served read left a staff row: under the agency read, or the platform for a cross-agency read.
    const reads = await adminQuery<{ agency_id: string; target_id: string | null; metadata: Record<string, unknown> }>(
      `select agency_id, target_id, metadata from audit_logs
        where type = 'staff.auditLog.read' and actor_user_id = $1 order by occurred_at, id`,
      [support.userId],
    );
    expect(reads.map((r) => [r.agency_id, r.target_id])).toEqual([
      [f.agencyId, f.agencyId],
      [f.agencyId, f.agencyId],
      [PLATFORM_AGENCY_ID, null],
      [f.agencyId, f.agencyId],
    ]);
    expect(reads[1]?.metadata).toMatchObject({ nextPage: true });

    // Data ops do not read audit logs.
    const ops = await createStaffUser('STAFF_DATA_OPS');
    await expect(
      staffRead(ops.userId, (ctx) => compliance.listAuditLogForStaff(ctx, { limit: 10 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
