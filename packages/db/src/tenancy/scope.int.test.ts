import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../test/test-db';
import { closeDb, configureDb, dbConfig, getPgClient } from '../client';
import { withPublicRead, withSystem, withTenant } from './scope';

type Row = Record<string, unknown>;
const first = (res: { rows: unknown[] }) => res.rows[0] as Row;
const port = (url: string) => new URL(url).port;

beforeAll(() => setupTestDb('http'), 120_000);
afterAll(() => closeDb());

describe('withTenant', () => {
  it('[S0-04] sets app.agency_id transaction-locally; gone in the next transaction on the same pooled connection (through PgBouncer)', async () => {
    const cfg = dbConfig();
    await configureDb(cfg, { max: 1 });
    // app_user goes through PgBouncer: the server's port differs from the one we dialled.
    const serverPort = await withTenant({ agencyId: newId() }, async (tx) =>
      first(await tx.execute(sql`select inet_server_port() as p`)),
    );
    expect(String(serverPort.p)).not.toBe(port(cfg.DATABASE_URL_APP_USER));
    expect(port(cfg.DATABASE_URL_APP_USER)).toBe(port(process.env.DATABASE_URL_ADMIN_POOLED ?? 'postgres://x:1'));

    let sameServerConnection = false;
    for (let attempt = 0; attempt < 5 && !sameServerConnection; attempt++) {
      const agencyId = newId();
      const inside = await withTenant({ agencyId }, async (tx) =>
        first(await tx.execute(sql`select current_setting('app.agency_id', true) as agency, pg_backend_pid() as pid`)),
      );
      expect(inside.agency).toBe(agencyId);

      const client = await getPgClient('app_user');
      try {
        await client.query('begin');
        const after = (
          await client.query(
            `select nullif(current_setting('app.agency_id', true), '') as agency, pg_backend_pid() as pid`,
          )
        ).rows[0] as Row;
        await client.query('commit');
        expect(after.agency).toBeNull();
        sameServerConnection = after.pid === inside.pid;
      } finally {
        client.release();
      }
    }
    expect(sameServerConnection).toBe(true);
  });

  it('[S0-04] runs as app_user without BYPASSRLS', async () => {
    const row = await withTenant({ agencyId: newId() }, async (tx) =>
      first(
        await tx.execute(
          sql`select current_user as role, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
        ),
      ),
    );
    expect(row).toEqual({ role: 'app_user', bypass: false });
  });
});

describe('withSystem', () => {
  it('[S0-04] throws when APP_ROLE=http', async () => {
    await expect(withSystem('test', async () => 1)).rejects.toThrow(/not allowed when APP_ROLE=http/);
    await expect(getPgClient('app_system')).rejects.toThrow(/not allowed/);
  });

  it('[S0-04] runs as app_system with the reason recorded when APP_ROLE=worker', async () => {
    await configureDb({ ...dbConfig(), APP_ROLE: 'worker' });
    try {
      const row = await withSystem('s0-04 test', async (tx) =>
        first(await tx.execute(sql`select current_user as role, current_setting('app.system_reason', true) as reason`)),
      );
      expect(row).toEqual({ role: 'app_system', reason: 's0-04 test' });
    } finally {
      await configureDb({ ...dbConfig(), APP_ROLE: 'http' });
    }
  });
});

describe('role statement timeouts', () => {
  it('[S0-04] a query exceeding the role timeout is cancelled', async () => {
    const started = Date.now();
    await expect(withPublicRead((tx) => tx.execute(sql`select pg_sleep(4)`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '57014' }), // query_canceled: statement timeout
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_000);
  }, 15_000);

  it('[S0-04] each role carries its timeout (feed 2 s, dashboard 5 s, worker 60 s)', async () => {
    const show = (tx: { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }) =>
      tx.execute(sql`select current_setting('statement_timeout') as t`).then((r) => first(r).t);
    expect(await withPublicRead(show)).toBe('2s');
    expect(await withTenant({ agencyId: newId() }, show)).toBe('5s');
    await configureDb({ ...dbConfig(), APP_ROLE: 'script' });
    try {
      expect(await withSystem('timeout check', show)).toBe('1min');
    } finally {
      await configureDb({ ...dbConfig(), APP_ROLE: 'http' });
    }
  });

  it('[S0-04] app_public has no write privilege even in a read-write transaction; app_user gets DML on new tables', async () => {
    const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_APP_OWNER });
    await owner.connect();
    try {
      await owner.query('drop table if exists s0_04_probe; create table s0_04_probe (x int)');
      const pub = await getPgClient('app_public');
      try {
        await pub.query('begin read write');
        await expect(pub.query('insert into s0_04_probe values (1)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pub.query('rollback');
        pub.release();
      }
      const inserted = await withTenant({ agencyId: newId() }, (tx) =>
        tx.execute(sql`insert into s0_04_probe values (1)`),
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await owner.query('drop table if exists s0_04_probe');
      await owner.end();
    }
  });

  it('[S0-04] withPublicRead cannot write', async () => {
    await expect(withPublicRead((tx) => tx.execute(sql`create temp table t (x int)`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '25006' }), // read_only_sql_transaction
    });
  });
});
