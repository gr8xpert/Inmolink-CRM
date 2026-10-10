import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker, restoreDrill } from '../../scripts/ops/pitr';

// Production commands against fixtures (S0-15, H3/H4 pending): the Postgres image's own ops scripts, a
// WAL-G store on the test stack's MinIO (R2 stand-in), and fresh containers as the "fresh server".
const ROOT = join(import.meta.dirname, '..', '..');
const IMAGE = 'inmolink/postgres:18-3.6-walg3.0.9';
const NETWORK = 'inmolink_default';
const id = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const PRIMARY = `drill-primary-${id}`;
const REPLICA = `drill-replica-${id}`;
const REPLICA_VOLUME = `drill-replica-${id}`;
const REPL_PASSWORD = randomBytes(12).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'inmolink-drill-'));
const walgEnv = join(dir, 'walg.env');

// postgres_exporter v0.20.1 `replication` collector query: Grafana and the lag alert read these values.
const EXPORTER_REPLICATION_QUERY = `SELECT
  CASE WHEN NOT pg_is_in_recovery() THEN 0
       WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
       ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))) END AS lag,
  CASE WHEN pg_is_in_recovery() THEN 1 ELSE 0 END AS is_replica`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const psql = (container: string, sql: string, host = '/var/run/postgresql') =>
  docker([
    'exec',
    '-u',
    'postgres',
    container,
    'psql',
    '-h',
    host,
    '-d',
    'inmolink', // the app database, as in production (POSTGRES_DB below)
    '-XtAq',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// The entrypoint's temporary init server listens on the socket only; TCP answers once the real server is up.
const ready = (container: string) =>
  until(`${container} ready`, async () =>
    (await psql(container, 'select 1', '127.0.0.1')) === '1' ? true : undefined,
  );

beforeAll(async () => {
  writeFileSync(
    walgEnv,
    [
      `WALG_S3_PREFIX=s3://inmolink-backups/drill-${id}`,
      'AWS_ACCESS_KEY_ID=inmolink',
      'AWS_SECRET_ACCESS_KEY=inmolink-local-secret',
      'AWS_ENDPOINT=http://minio-test:9000',
      'AWS_REGION=us-east-1',
      'AWS_S3_FORCE_PATH_STYLE=true',
      'WALG_COMPRESSION_METHOD=zstd',
      `WALG_LIBSODIUM_KEY=${randomBytes(32).toString('hex')}`,
      'WALG_LIBSODIUM_KEY_TRANSFORM=hex',
      'PGHOST=/var/run/postgresql',
      `POSTGRES_PASSWORD=${randomBytes(12).toString('hex')}`,
      'POSTGRES_DB=inmolink',
      '',
    ].join('\n'),
  );
  // Same archiving settings as the db-1 template (infra/ansible/roles/postgres/templates/postgresql.conf.j2).
  await docker([
    'run',
    '-d',
    '--name',
    PRIMARY,
    '--network',
    NETWORK,
    '--env-file',
    walgEnv,
    IMAGE,
    'postgres',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    'archive_command=wal-g wal-push %p',
    '-c',
    'archive_timeout=60',
    '-c',
    'max_wal_senders=5',
    '-c',
    'max_replication_slots=5',
    // Production's limit: the drill must still recover with the backup's default config (100).
    '-c',
    'max_connections=300',
    '-c',
    'shared_preload_libraries=pg_stat_statements',
  ]);
  await ready(PRIMARY);
  await docker([
    'exec',
    PRIMARY,
    'bash',
    '-c',
    'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"',
  ]);
  await psql(
    PRIMARY,
    `create role replicator with login replication password '${REPL_PASSWORD}'; select pg_reload_conf()`,
  );
  await psql(PRIMARY, 'create table drill_marker (label text primary key)');
}, 180_000);

afterAll(async () => {
  await docker([
    'run',
    '--rm',
    '--network',
    NETWORK,
    '--env-file',
    walgEnv,
    IMAGE,
    'wal-g',
    'delete',
    'everything',
    'FORCE',
    '--confirm',
  ]).catch(() => undefined);
  await docker(['rm', '-f', '-v', PRIMARY, REPLICA]).catch(() => undefined);
  await docker(['volume', 'rm', '-f', REPLICA_VOLUME]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('backups and point-in-time restore', () => {
  it('[S0-15] PITR restore to a chosen timestamp on a fresh server succeeds; measured RTO recorded', async () => {
    await docker(['exec', '-u', 'postgres', PRIMARY, 'inmolink-walg-backup']);
    await psql(PRIMARY, "insert into drill_marker values ('before-target')");
    // The database clock, not the test runner's, defines the target.
    const target = new Date(
      await psql(PRIMARY, `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`),
    );
    await sleep(1_100);
    await psql(PRIMARY, "insert into drill_marker values ('after-target')");
    const segment = await psql(PRIMARY, 'select pg_walfile_name(pg_switch_wal())');
    await until('WAL segment archived', async () =>
      (await psql(PRIMARY, 'select last_archived_wal from pg_stat_archiver')) >= segment ? true : undefined,
    );

    const report = await restoreDrill({
      image: IMAGE,
      walgEnvFile: walgEnv,
      network: NETWORK,
      targetTime: target,
      verifySql: "select string_agg(label, ',' order by label) from drill_marker",
      replayTimeoutMs: 120_000,
    });

    expect(report.verifyOutput).toBe('before-target');
    expect(report.archiveMode).toBe('off'); // never archives into the production store
    expect(report.lastReplayedCommit).not.toBeNull();
    expect(new Date(report.lastReplayedCommit as string).getTime()).toBeLessThanOrEqual(target.getTime());
    expect(report.backup).toMatch(/^base_[0-9A-F]+/);
    expect(report.rtoSeconds).toBeGreaterThan(0);
    expect(report.rtoSeconds).toBeGreaterThanOrEqual(
      report.phasesSeconds.fetchBase + report.phasesSeconds.replayAndPromote - 0.05,
    );
    console.info(`[S0-15] restore drill RTO ${report.rtoSeconds} s`, report.phasesSeconds);
    // Nothing left behind on the "fresh server".
    expect(await docker(['ps', '-a', '--filter', 'name=inmolink-restore-', '--format', '{{.Names}}'])).toBe('');
  }, 300_000);

  it('[S0-15] a target before the oldest base backup fails clearly instead of restoring the wrong state', async () => {
    await expect(
      restoreDrill({
        image: IMAGE,
        walgEnvFile: walgEnv,
        network: NETWORK,
        targetTime: new Date('2001-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/no base backup finished before 2001-01-01/);
  }, 120_000);
});

describe('streaming replica', () => {
  it('[S0-15] hot standby streams from the primary through a slot; exporter reports it as a replica with zero lag', async () => {
    await docker(['volume', 'create', REPLICA_VOLUME]);
    await docker([
      'run',
      '--rm',
      '-u',
      'postgres',
      '--network',
      NETWORK,
      '-v',
      `${REPLICA_VOLUME}:/var/lib/postgresql`,
      '-e',
      `PRIMARY_HOST=${PRIMARY}`,
      '-e',
      `REPLICATION_PASSWORD=${REPL_PASSWORD}`,
      '-e',
      'REPLICATION_SLOT=db_2',
      IMAGE,
      'inmolink-replica-init',
    ]);
    await docker([
      'run',
      '-d',
      '--name',
      REPLICA,
      '--network',
      NETWORK,
      '-v',
      `${REPLICA_VOLUME}:/var/lib/postgresql`,
      IMAGE,
      'postgres',
      // A hot standby needs at least the primary's limits (production: one postgresql.conf for both).
      '-c',
      'max_connections=300',
    ]);
    await ready(REPLICA);

    await psql(PRIMARY, "insert into drill_marker values ('replicated')");
    await until('row replicated', async () =>
      (await psql(REPLICA, "select count(*) from drill_marker where label = 'replicated'")) === '1' ? true : undefined,
    );
    expect(await psql(PRIMARY, "select active from pg_replication_slots where slot_name = 'db_2'")).toBe('t');
    const [lag, isReplica] = (
      await until('replay caught up', async () => {
        const row = await psql(REPLICA, EXPORTER_REPLICATION_QUERY);
        return row.startsWith('0|') ? row : undefined;
      })
    ).split('|');
    expect(Number(lag)).toBe(0);
    expect(isReplica).toBe('1');
    await expect(psql(REPLICA, "insert into drill_marker values ('x')")).rejects.toThrow(/read-only transaction/);
    // The replication password lives in ~/.pgpass, outside $PGDATA (so never inside a base backup).
    const autoConf = await docker(['exec', REPLICA, 'sh', '-c', 'cat "$PGDATA/postgresql.auto.conf"']);
    expect(autoConf).toContain('primary_conninfo');
    expect(autoConf).not.toContain('password=');
  }, 240_000);

  it('[S0-15] base backups refuse to run on the standby', async () => {
    await expect(docker(['exec', '-u', 'postgres', REPLICA, 'inmolink-walg-backup'])).rejects.toThrow(/standby/);
  }, 60_000);
});

describe('cluster bootstrap (Ansible role postgres)', () => {
  it('[S0-15] PgBouncer auth role sees only app_* roles; maintenance databases are closed to PUBLIC', async () => {
    const vars: Record<string, string> = {
      ansible_managed: 'Ansible managed (test)',
      vault_replication_password: REPL_PASSWORD, // unchanged: the standby above keeps streaming
      vault_pgbouncer_auth_password: randomBytes(12).toString('hex'),
      vault_postgres_exporter_password: randomBytes(12).toString('hex'),
      postgres_db: 'inmolink',
    };
    const template = readFileSync(
      join(ROOT, 'infra', 'ansible', 'roles', 'postgres', 'templates', 'bootstrap.sql.j2'),
      'utf8',
    );
    const sql = template.replace(/\{\{ (\w+) \}\}/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`bootstrap.sql.j2 uses ${name}: add it to this test`);
      return value;
    });
    const file = join(dir, 'bootstrap.sql');
    writeFileSync(file, sql);
    await docker(['cp', file, `${PRIMARY}:/tmp/bootstrap.sql`]);
    const apply = () =>
      docker([
        'exec',
        '-u',
        'postgres',
        PRIMARY,
        'psql',
        '-h',
        '/var/run/postgresql',
        '-d',
        'inmolink',
        '-Xq',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        '/tmp/bootstrap.sql',
      ]);
    await apply();
    await apply(); // idempotent: every Ansible run re-applies it

    await psql(PRIMARY, "create role app_user login password 'x'; create role app_owner login password 'y'");
    const asAuth = (q: string) => psql(PRIMARY, `set role pgbouncer_auth; ${q}`);
    expect(await asAuth("select usename from pgbouncer.get_auth('app_user')")).toBe('app_user');
    expect(await asAuth("select count(*) from pgbouncer.get_auth('postgres')")).toBe('0');
    expect(await asAuth("select count(*) from pgbouncer.get_auth('replicator')")).toBe('0');
    // The owner role is never reachable through PgBouncer (migrations connect directly on the db host).
    expect(await asAuth("select count(*) from pgbouncer.get_auth('app_owner')")).toBe('0');
    // The bootstrap's role passwords never land in pg_stat_statements (readable by pg_monitor). Utility
    // statements are stored verbatim, so without the template's `track_utility = off` this would find them.
    expect(await psql(PRIMARY, 'select count(*) > 0 from pg_stat_statements')).toBe('t'); // tracking is on
    expect(
      await psql(
        PRIMARY,
        `select count(*) from pg_stat_statements where query like '%${vars.vault_pgbouncer_auth_password}%'`,
      ),
    ).toBe('0');
    await expect(asAuth('select count(*) from pg_shadow')).rejects.toThrow(/permission denied/);
    expect(await psql(PRIMARY, "select has_database_privilege('app_user', 'postgres', 'connect')")).toBe('f');
    expect(await psql(PRIMARY, "select pg_has_role('postgres_exporter', 'pg_monitor', 'member')")).toBe('t');
    // The standby is still streaming after the re-applied replicator password.
    expect(await psql(PRIMARY, "select active from pg_replication_slots where slot_name = 'db_2'")).toBe('t');
  }, 120_000);
});
