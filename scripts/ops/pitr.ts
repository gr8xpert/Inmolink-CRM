// Point-in-time restore drill (S0-15, PLAN §3 #36). Restores the WAL-G store onto a fresh Docker host
// using the Postgres image's own `inmolink-pitr-prepare`, waits for WAL replay to reach the target and
// promote, runs a verification query and measures RTO. CLI: `scripts/ops/restore-drill.ts`.
//
// The Docker host is local by default; `dockerHost: 'ssh://deploy@fresh-1'` drives a fresh server over
// SSH (DOCKER_HOST), so the drill runs against real hardware without anything installed but Docker.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface DockerOptions {
  /** DOCKER_HOST for every docker call (e.g. ssh://deploy@203.0.113.20); unset = local engine. */
  dockerHost?: string;
}

export interface DrillOptions extends DockerOptions {
  /** Postgres image with WAL-G and the inmolink-* ops scripts (infra/docker/postgres). */
  image: string;
  /** Env file with WALG_S3_PREFIX, AWS_* and WALG_LIBSODIUM_KEY; read by the docker CLI, never logged. */
  walgEnvFile: string;
  /** Recover up to (excluding) this instant. Unset = replay every archived WAL segment. */
  targetTime?: Date;
  /** Docker network for the drill containers (needed when the store is another container, e.g. MinIO). */
  network?: string;
  /** Runs after promotion as the postgres superuser, in `database`; its output goes into the report. */
  verifySql?: string;
  /** Database for the write check and verifySql (default `inmolink`, the app database). */
  database?: string;
  /** Leave the restored server running (for inspection or to promote it into service). */
  keep?: boolean;
  /** Max wait for WAL replay, ms (default 1 h). */
  replayTimeoutMs?: number;
}

export interface WalgBackup {
  backup_name: string;
  start_time: string;
  finish_time: string;
}

export interface DrillReport {
  startedAt: string;
  finishedAt: string;
  targetTime: string | null;
  backup: string;
  backupFinishedAt: string;
  /** Last commit replayed from WAL: at or before targetTime when one is set. */
  lastReplayedCommit: string | null;
  verifyOutput: string | null;
  /** Must be `off`: a restored cluster never archives into the store it came from. */
  archiveMode: string;
  /** Wall-clock seconds from drill start until the restored server accepted writes and passed verification. */
  rtoSeconds: number;
  phasesSeconds: { listBackups: number; fetchBase: number; replayAndPromote: number; verify: number };
  container: string | null;
}

export class DrillError extends Error {}

/** On every container and volume a drill creates, so a cancelled run can be cleaned up (`cleanupDrills`). */
export const DRILL_LABEL = 'inmolink.restore-drill=1';

/** Removes every drill container and volume on the Docker host (after a cancelled or timed-out run). */
export async function cleanupDrills(o: DockerOptions = {}): Promise<number> {
  const lines = (out: string) => out.split(/\r?\n/).filter(Boolean);
  const ids = lines(await docker(['ps', '-aq', '--filter', `label=${DRILL_LABEL}`], o));
  if (ids.length > 0) await docker(['rm', '-f', '-v', ...ids], o);
  const volumes = lines(await docker(['volume', 'ls', '-q', '--filter', `label=${DRILL_LABEL}`], o));
  if (volumes.length > 0) await docker(['volume', 'rm', '-f', ...volumes], o);
  return ids.length + volumes.length;
}

export function docker(
  args: string[],
  opts: DockerOptions = {},
  timeoutMs = 600_000,
  withStderr = false,
): Promise<string> {
  const env = { ...process.env };
  if (opts.dockerHost) env.DOCKER_HOST = opts.dockerHost;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new DrillError(`docker ${args[0]} failed: ${(stderr || err.message).trim().slice(-2000)}`));
        else resolve((withStderr ? `${stdout}\n${stderr}` : stdout).trim());
      },
    );
    child.stdin?.end();
  });
}

/** Newest base backup that finished before the target (any backup when there is no target). */
export function chooseBackup(backups: readonly WalgBackup[], target?: Date): WalgBackup {
  const eligible = backups
    .filter((b) => !target || new Date(b.finish_time).getTime() < target.getTime())
    .sort((a, b) => new Date(b.finish_time).getTime() - new Date(a.finish_time).getTime());
  const chosen = eligible[0];
  if (!chosen) {
    throw new DrillError(
      target
        ? `no base backup finished before ${target.toISOString()} (${backups.length} in the store)`
        : 'the WAL-G store has no base backups',
    );
  }
  return chosen;
}

/** recovery_target_time rejects ISO 8601's `T…Z` form; Postgres wants `2026-10-11 10:00:00.000+00`. */
export const pgTimestamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '+00');

const seconds = (from: number, to: number) => Math.round((to - from) / 10) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storeArgs(o: DrillOptions): string[] {
  return ['--env-file', o.walgEnvFile, ...(o.network ? ['--network', o.network] : [])];
}

export async function listBackups(o: DrillOptions): Promise<WalgBackup[]> {
  const out = await docker(['run', '--rm', ...storeArgs(o), o.image, 'wal-g', 'backup-list', '--json', '--detail'], o);
  if (!out) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new DrillError(`wal-g backup-list printed something that is not JSON: ${out.slice(0, 200)}`);
  }
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new DrillError('wal-g backup-list did not return a list');
  return parsed as WalgBackup[];
}

async function psql(o: DockerOptions, container: string, sql: string, database = 'postgres'): Promise<string> {
  return docker(
    [
      'exec',
      '-u',
      'postgres',
      container,
      'psql',
      '-h',
      '/var/run/postgresql',
      '-d',
      database,
      '-XtAq',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    o,
  );
}

async function waitForPromotion(o: DrillOptions, container: string): Promise<void> {
  const deadline = Date.now() + (o.replayTimeoutMs ?? 3_600_000);
  while (Date.now() < deadline) {
    const state = await docker(['inspect', '-f', '{{.State.Status}}', container], o);
    if (state !== 'running') {
      const logs = await docker(['logs', '--tail', '40', container], o, 30_000, true).catch(() => '');
      throw new DrillError(`restored server stopped during recovery (${state}):\n${logs}`);
    }
    const inRecovery = await psql(o, container, 'select pg_is_in_recovery()').catch(() => 'starting');
    if (inRecovery === 'f') return;
    await sleep(500);
  }
  throw new DrillError(`WAL replay did not finish within ${o.replayTimeoutMs ?? 3_600_000} ms`);
}

/** Runs one drill end to end. Throws DrillError on any failure; always removes what it created unless `keep`. */
export async function restoreDrill(o: DrillOptions): Promise<DrillReport> {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const volume = `inmolink-restore-${id}`;
  const container = `inmolink-restore-${id}`;
  const t0 = Date.now();
  let created = false;
  try {
    const backup = chooseBackup(await listBackups(o), o.targetTime);
    const t1 = Date.now();

    await docker(['volume', 'create', '--label', DRILL_LABEL, volume], o);
    created = true;
    await docker(
      [
        'run',
        '--rm',
        '-u',
        'postgres',
        '-v',
        `${volume}:/var/lib/postgresql`,
        ...storeArgs(o),
        '-e',
        `BACKUP_NAME=${backup.backup_name}`,
        ...(o.targetTime ? ['-e', `TARGET_TIME=${pgTimestamp(o.targetTime)}`] : []),
        o.image,
        'inmolink-pitr-prepare',
      ],
      o,
      o.replayTimeoutMs ?? 3_600_000,
    );
    const t2 = Date.now();

    // hot_standby=off: the backup's own config has default limits (max_connections = 100); with hot standby
    // on, recovery pauses when they are below the primary's (production: 300). Nobody reads during replay.
    await docker(
      [
        'run',
        '-d',
        '--label',
        DRILL_LABEL,
        '--name',
        container,
        '-v',
        `${volume}:/var/lib/postgresql`,
        ...storeArgs(o),
        o.image,
        'postgres',
        '-c',
        'hot_standby=off',
      ],
      o,
    );
    await waitForPromotion(o, container);
    const t3 = Date.now();

    const lastReplayed = await psql(
      o,
      container,
      `select to_char(pg_last_xact_replay_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    );
    // The restored server must accept writes: that is what "restored" means for RTO.
    const database = o.database ?? 'inmolink';
    await psql(
      o,
      container,
      'create temporary table inmolink_drill_write_check (x int); insert into inmolink_drill_write_check values (1)',
      database,
    );
    const verifyOutput = o.verifySql ? await psql(o, container, o.verifySql, database) : null;
    const archiveMode = await psql(o, container, 'show archive_mode');
    if (archiveMode !== 'off') throw new DrillError(`restored cluster has archive_mode=${archiveMode}; expected off`);
    const t4 = Date.now();

    return {
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date(t4).toISOString(),
      targetTime: o.targetTime?.toISOString() ?? null,
      backup: backup.backup_name,
      backupFinishedAt: backup.finish_time,
      lastReplayedCommit: lastReplayed ? new Date(lastReplayed).toISOString() : null,
      verifyOutput,
      archiveMode,
      rtoSeconds: seconds(t0, t4),
      phasesSeconds: {
        listBackups: seconds(t0, t1),
        fetchBase: seconds(t1, t2),
        replayAndPromote: seconds(t2, t3),
        verify: seconds(t3, t4),
      },
      container: o.keep ? container : null,
    };
  } finally {
    if (created && !o.keep) {
      await docker(['rm', '-f', '-v', container], o).catch(() => undefined);
      await docker(['volume', 'rm', '-f', volume], o).catch(() => undefined);
    }
  }
}
