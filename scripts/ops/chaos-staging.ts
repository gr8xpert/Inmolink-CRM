// Chaos drills against staging (S16-02; needs H4: the staging hosts, a real standby, the CDN and a fresh server).
// Each drill injects its fault on the real hosts over SSH (DOCKER_HOST=ssh://…), probes what users see over HTTP,
// and reports through the same DrillRecorder as the local drills. Runbooks: failover.md, pitr-restore.md, search.md,
// cdn.md, queues.md. Every drill that stops, kills or restarts something refuses to run without `confirm`.
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import {
  DrillRecorder,
  type DrillResult,
  type EdgeSample,
  evaluateEdgeOutage,
  killContainer,
  lsnBytes,
  percentile,
  secondsSince,
  sleep,
  startContainer,
  startWriteTicker,
  stopContainer,
  until,
  writesLost,
} from './chaos';
import { markerJobs } from './chaos-markers';
import { DrillError, docker, restoreDrill } from './pitr';

export interface StagingConfig {
  /** Website API through the CDN, e.g. https://feed.staging.example (warmed URLs carry the SDK's `_k`). */
  edgeUrls: string[];
  /** Website API at the origin (no CDN): `/v2/listings?…` for the search drill. */
  originListingsUrl?: string;
  /** `/v2/search/ai?q=…` at the origin (AI drill). */
  originAiSearchUrl?: string;
  /** Secret key of the staging drill site (env CHAOS_API_KEY, never a flag). */
  apiKey?: string;
  /** Dashboard API `/readyz` (Postgres drill: back once the apps point at the promoted standby). */
  dashboardHealthUrl?: string;
  /** Worker `/readyz` (redis-queue drill). */
  workerHealthUrl?: string;
  /**
   * redis-queue drill: the staging redis-queue as this machine reaches it (an SSH tunnel), env CHAOS_REDIS_QUEUE_URL.
   * Marker jobs go under the drill-only key prefix `inl-chaos`, so the staging workers never see them.
   */
  redisQueueUrl?: string;
  hosts: Partial<Record<'search' | 'feedApi' | 'dbPrimary' | 'dbStandby' | 'redis', string>>;
  containers: { meilisearch: string; postgres: string; redisQueue: string; feedApiService: string };
  pitr?: { image: string; walgEnvFile: string; dockerHost?: string; network?: string };
  /** Seconds the fault lasts where the drill chooses (search, CDN). */
  outageSeconds: number;
  /** Required for every drill that stops, kills or restarts a staging service. */
  confirm: boolean;
}

export const STAGING_DEFAULTS: Pick<StagingConfig, 'containers' | 'outageSeconds'> = {
  containers: {
    meilisearch: 'meilisearch',
    postgres: 'postgres',
    redisQueue: 'redis-queue',
    feedApiService: 'feed-api',
  },
  // Longer than the listings TTL (60 s), so the CDN must serve stale, not fresh.
  outageSeconds: 90,
};

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined || value === '') throw new DrillError(`staging drill needs ${what}`);
  return value;
};

interface Probe {
  status: number;
  ms: number;
  headers: Headers;
  json: unknown;
}

async function probe(url: string, apiKey?: string): Promise<Probe> {
  const t = performance.now();
  try {
    const res = await fetch(url, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, ms: performance.now() - t, headers: res.headers, json };
  } catch {
    return { status: 0, ms: performance.now() - t, headers: new Headers(), json: null };
  }
}

const field = (json: unknown, key: string): unknown =>
  json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;

/**
 * psql in a container on a staging host. Values go in as psql variables (`:'name'` in the SQL) with the SQL on
 * stdin — never into the SQL text (`-c` does not interpolate variables; a script on stdin does).
 */
async function psqlAt(
  dockerHost: string,
  container: string,
  q: string,
  vars: Record<string, string> = {},
): Promise<string> {
  const names = Object.keys(vars);
  for (const k of names) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new DrillError(`bad psql variable name ${k}`);
  const flags = names.map((k, i) => `-v ${k}="$${i + 2}"`).join(' ');
  const script = `printf '%s' "$1" | psql -d inmolink -XtAq -v ON_ERROR_STOP=1 ${flags}`;
  return docker(
    ['exec', '-u', 'postgres', container, 'bash', '-c', script, '_', q, ...names.map((k) => vars[k] as string)],
    { dockerHost },
    60_000,
  );
}

/** Probes `urls` once a second until `stop()`; every status seen. */
function probeUntilStopped(urls: readonly string[], apiKey: string | undefined) {
  const statuses: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running && urls.length > 0) {
      for (const url of urls) statuses.push((await probe(url, apiKey)).status);
      await sleep(1_000);
    }
  })();
  return {
    statuses,
    async stop() {
      running = false;
      await loop;
    },
  };
}

export async function stagingSearch(c: StagingConfig): Promise<DrillResult> {
  if (!c.confirm) throw new DrillError('search stops the staging Meilisearch: pass --confirm');
  const url = need(c.originListingsUrl, '--origin-listings-url');
  const host = need(c.hosts.search, '--search-host');
  const r = new DrillRecorder('search', 'staging');
  const before = await probe(url, c.apiKey);
  if (before.status !== 200 || field(before.json, 'degraded') !== false) {
    throw new DrillError(
      `baseline search is not healthy (${before.status}, degraded=${String(field(before.json, 'degraded'))})`,
    );
  }
  const ms: number[] = [];
  let errors = 0;
  let firstDegraded: number | null = null;
  const t0 = Date.now();
  const done = r.disrupt(`${host} ${c.containers.meilisearch}`, 'docker stop');
  try {
    await stopContainer(c.containers.meilisearch, { dockerHost: host });
    while (Date.now() - t0 < c.outageSeconds * 1_000) {
      const p = await probe(url, c.apiKey);
      ms.push(p.ms);
      if (p.status !== 200) errors += 1;
      else if (field(p.json, 'degraded') === true) firstDegraded ??= Date.now();
      await sleep(250);
    }
  } finally {
    await startContainer(c.containers.meilisearch, { dockerHost: host });
    done();
  }
  const started = Date.now();
  const back = await until(
    'engine answering again',
    async () => {
      const p = await probe(url, c.apiKey);
      return p.status === 200 && field(p.json, 'degraded') === false ? Date.now() : undefined;
    },
    180_000,
    1_000,
  );
  r.check('every search answered while the engine was down', errors === 0, `${errors} non-200`);
  r.check('the fallback answered (degraded: true)', firstDegraded !== null);
  r.check('engine back in use without a restart', back >= started);
  r.rtoSeconds = firstDegraded === null ? null : secondsSince(t0, firstDegraded);
  r.measure('outageP95Ms', percentile(ms, 95));
  r.measure('recoverySecondsAfterStart', secondsSince(started, back));
  r.note('Also run the k6 degraded profile (tests/load, S7-F9) while the engine is down for the p95 at 1,000 rps.');
  return r.result();
}

async function feedApiContainers(c: StagingConfig, host: string): Promise<string[]> {
  const out = await docker(['ps', '-q', '--filter', `label=service=${c.containers.feedApiService}`], {
    dockerHost: host,
  });
  return out.split(/\r?\n/).filter(Boolean);
}

export async function stagingFeedOrigin(c: StagingConfig): Promise<DrillResult> {
  if (!c.confirm) throw new DrillError('feed-origin stops every feed-api container on staging: pass --confirm');
  if (c.edgeUrls.length === 0) throw new DrillError('feed-origin needs --edge-url (warmed through the CDN, with _k)');
  const host = need(c.hosts.feedApi, '--feed-api-host');
  const r = new DrillRecorder('feed-origin', 'staging');
  for (const url of c.edgeUrls) await probe(url, c.apiKey); // warm
  const warmed = await Promise.all(c.edgeUrls.map((u) => probe(u, c.apiKey)));
  r.check(
    'warmed URLs are edge HITs before the outage',
    warmed.every((p) => p.headers.get('cf-cache-status')?.toUpperCase() === 'HIT'),
    warmed.map((p) => p.headers.get('cf-cache-status') ?? '-').join(','),
  );
  const ids = await feedApiContainers(c, host);
  if (ids.length === 0) {
    throw new DrillError(`no running container labelled service=${c.containers.feedApiService} on ${host}`);
  }
  const samples: EdgeSample[] = [];
  const t0 = Date.now();
  const done = r.disrupt(`${host} feed-api (${ids.length} containers)`, 'docker stop');
  try {
    for (const id of ids) await stopContainer(id, { dockerHost: host });
    while (Date.now() - t0 < c.outageSeconds * 1_000) {
      for (const url of c.edgeUrls) {
        const p = await probe(url, c.apiKey);
        samples.push({
          atMs: Date.now() - t0,
          status: p.status,
          cacheStatus: p.headers.get('cf-cache-status') ?? '',
          warmed: true,
        });
      }
      await sleep(5_000);
    }
  } finally {
    // Every container, also after a stop that failed half-way (`docker start` of a running one is a no-op).
    for (const id of ids) await startContainer(id, { dockerHost: host }).catch(() => undefined);
    done();
  }
  const problems = evaluateEdgeOutage(samples);
  for (const problem of problems) r.check(problem, false);
  r.check('edge served every warmed URL while the origin was down', problems.length === 0);
  r.rtoSeconds = 0;
  r.measure('outageSeconds', secondsSince(t0));
  r.measure('staleAnswers', samples.filter((s) => /STALE|UPDATING/i.test(s.cacheStatus)).length);
  r.note('Then run runbook cdn.md "Staging acceptance" steps 3–5 (edit visible, revocation, no override rule).');
  return r.result();
}

/** The drill's write-load table on staging (created and dropped by the drill). */
const TICKS = 'chaos_drill_ticks';

export async function stagingPostgresPrimary(c: StagingConfig): Promise<DrillResult> {
  if (!c.confirm) {
    throw new DrillError('postgres-primary kills the staging primary and promotes the standby: pass --confirm');
  }
  const primary = need(c.hosts.dbPrimary, '--db-primary-host');
  const standby = need(c.hosts.dbStandby, '--db-standby-host');
  const pg = c.containers.postgres;
  const r = new DrillRecorder('postgres-primary', 'staging');
  if ((await psqlAt(standby, pg, 'select pg_is_in_recovery()')) !== 't') {
    throw new DrillError('standby is not in recovery');
  }
  // A write load up to the kill: every acknowledged write with its commit time and WAL position (the loss window).
  await psqlAt(primary, pg, `create table if not exists ${TICKS} (n int primary key, at timestamptz not null)`);
  await psqlAt(primary, pg, `truncate ${TICKS}`);
  const ticker = startWriteTicker(pg, TICKS, { dockerHost: primary });
  await until('the write load running', async () => (ticker.acked.size >= 50 ? true : undefined), 120_000, 500);
  // Websites must keep answering (CDN) from the kill until the standby takes writes.
  const edge = probeUntilStopped(c.edgeUrls, c.apiKey);
  const t0 = Date.now();
  r.disrupt(`${primary} ${pg}`, 'docker kill (fenced; rebuild as standby per failover.md step 6)');
  let received = 0n;
  let writable = 0;
  try {
    await killContainer(pg, { dockerHost: primary });
    await ticker.exited;
    received = lsnBytes(await psqlAt(standby, pg, 'select pg_last_wal_receive_lsn()'));
    // failover.md step 2; PGDATA from the container's own environment.
    await docker(['exec', '-u', 'postgres', pg, 'bash', '-c', 'pg_ctl promote -D "$PGDATA"'], {
      dockerHost: standby,
    });
    await until(
      'standby promoted',
      async () => ((await psqlAt(standby, pg, 'select pg_is_in_recovery()')) === 'f' ? true : undefined),
      300_000,
      500,
    );
    await psqlAt(
      standby,
      pg,
      'create temporary table chaos_write_check (x int); insert into chaos_write_check values (1)',
    );
    writable = Date.now();
  } finally {
    ticker.stop();
    await edge.stop();
  }
  const [maxN, maxAt, count] = (
    await psqlAt(
      standby,
      pg,
      `select coalesce(max(n), 0), coalesce(extract(epoch from max(at)), 0), count(*) from ${TICKS}`,
    )
  ).split('|');
  const loss = writesLost(ticker, Number(maxN), Number(maxAt));
  const lastLsn = ticker.acked.get(ticker.last())?.lsn;
  const lastBytes = lastLsn ? lsnBytes(lastLsn) : 0n;
  r.check('promoted standby accepts writes', true);
  r.check(
    'the standby holds a gap-free prefix of the writes',
    Number(count) === Number(maxN),
    `max ${maxN}, count ${count}`,
  );
  if (c.edgeUrls.length > 0) {
    r.check(
      'websites answered (CDN) from the kill until the standby took writes',
      edge.statuses.length > 0 && edge.statuses.every((s) => s === 200),
      `${edge.statuses.filter((s) => s !== 200).length} of ${edge.statuses.length} not 200`,
    );
  }
  r.rpoSeconds = loss.rpoSeconds;
  r.measure('ackedWrites', ticker.acked.size);
  r.measure('ackedWritesLost', loss.lost);
  r.measure('walBytesNotReceived', Number(lastBytes > received ? lastBytes - received : 0n));
  r.measure('standbyWritableSeconds', secondsSince(t0, writable));
  await psqlAt(standby, pg, `drop table if exists ${TICKS}`).catch(() => undefined);
  if (c.dashboardHealthUrl) {
    // Runbook steps 3–4 (inventory, DATABASE_URL_*, redeploy) are the operator's; the clock keeps running.
    const url = c.dashboardHealthUrl;
    const back = await until(
      'dashboard API ready on the promoted standby',
      async () => ((await probe(url)).status === 200 ? Date.now() : undefined),
      1_800_000,
      5_000,
    );
    r.rtoSeconds = secondsSince(t0, back);
  } else {
    r.rtoSeconds = secondsSince(t0, writable);
    r.note('No --dashboard-health-url: RTO stops at the first write on the standby, not at the apps repointed.');
  }
  return r.result();
}

export async function stagingRedisQueue(c: StagingConfig): Promise<DrillResult> {
  if (!c.confirm) throw new DrillError('redis-queue restarts the staging redis-queue: pass --confirm');
  const host = need(c.hosts.redis, '--redis-host');
  const db = need(c.hosts.dbPrimary, '--db-primary-host');
  const url = need(c.redisQueueUrl, 'CHAOS_REDIS_QUEUE_URL (a tunnel to the staging redis-queue)');
  const r = new DrillRecorder('redis-queue', 'staging');
  await configureQueue({ url, prefix: 'inl-chaos' });
  const markers = markerJobs(`s${Date.now().toString(36)}`, 50);
  const before = Array.from({ length: 200 }, (_, i) => `b${i}`);
  const after = Array.from({ length: 50 }, (_, i) => `a${i}`);
  const all = [...before, ...after];
  try {
    const since = await psqlAt(db, c.containers.postgres, 'select now()');
    await markers.enqueue(before);
    markers.startWorker(1); // slow on purpose: most markers are still queued when Redis restarts
    const t0 = Date.now();
    const notYetRun = before.length - markers.ran.size;
    const done = r.disrupt(`${host} ${c.containers.redisQueue}`, 'docker restart');
    try {
      await docker(['restart', c.containers.redisQueue], { dockerHost: host }, 120_000);
    } finally {
      done();
    }
    const restarted = Date.now();
    await until(
      'redis-queue accepting jobs again',
      async () => {
        await markers.enqueue(after);
        return true;
      },
      120_000,
      1_000,
    );
    if (c.workerHealthUrl) {
      const health = c.workerHealthUrl;
      await until(
        'worker ready',
        async () => ((await probe(health)).status === 200 ? true : undefined),
        300_000,
        1_000,
      );
    }
    const drained = await until(
      'marker jobs ran and the outbox backlog of the window drained',
      async () => {
        if (markers.lost(all).length > 0) return undefined;
        const backlog = await psqlAt(
          db,
          c.containers.postgres,
          `select count(*) from outbox_events where processed_at is null and dead_at is null
             and created_at >= :'since'::timestamptz - interval '10 minutes'
             and created_at <= now() - interval '5 seconds'`,
          { since },
        );
        return Number(backlog) === 0 ? Date.now() : undefined;
      },
      900_000,
      2_000,
    );
    const deadEvents = Number(
      await psqlAt(
        db,
        c.containers.postgres,
        `select count(*) from outbox_events where dead_at >= :'since'::timestamptz`,
        { since },
      ),
    );
    const lost = markers.lost(all).length;
    r.check('the restart hit queued marker jobs', notYetRun > 0, `${notYetRun} not yet run`);
    r.check('zero lost marker jobs', lost === 0, `${lost} lost`);
    r.check('no marker job dead-lettered', (await markers.deadLetters()) === 0);
    r.check('no outbox event dead-lettered during the drill', deadEvents === 0, `${deadEvents}`);
    r.rtoSeconds = secondsSince(t0, drained);
    r.measure('redisRestartSeconds', secondsSince(t0, restarted));
    r.measure('markerJobs', all.length);
    r.measure('jobsLost', lost);
    r.measure('deadOutboxEvents', deadEvents);
    r.measure('duplicateRuns', markers.duplicates());
  } finally {
    await markers.close().catch(() => undefined);
    await closeQueues();
  }
  return r.result();
}

export async function stagingAiProvider(c: StagingConfig): Promise<DrillResult> {
  if (!c.confirm) {
    throw new DrillError(
      'ai-provider expects the staging AI provider failing (an invalid AI key on feed-api and worker): pass --confirm once it is',
    );
  }
  const listingsUrl = need(c.originListingsUrl, '--origin-listings-url');
  const aiUrl = need(c.originAiSearchUrl, '--origin-ai-search-url');
  const r = new DrillRecorder('ai-provider', 'staging');
  const coreMs: number[] = [];
  let coreErrors = 0;
  const sources: string[] = [];
  for (let i = 0; i < 20; i++) {
    const p = await probe(listingsUrl, c.apiKey);
    coreMs.push(p.ms);
    if (p.status !== 200) coreErrors += 1;
    const sep = aiUrl.includes('?') ? '&' : '?';
    const ai = await probe(`${aiUrl}${sep}x=${Date.now()}${i}`, c.apiKey);
    sources.push(ai.status === 200 ? String(field(field(ai.json, 'understood'), 'source')) : String(ai.status));
  }
  if (c.dashboardHealthUrl) r.check('dashboard API ready', (await probe(c.dashboardHealthUrl)).status === 200);
  r.check('website search unaffected', coreErrors === 0, `${coreErrors} non-200`);
  r.check(
    'AI search answers a keyword search',
    sources.every((s) => s === 'KEYWORD'),
    sources.join(','),
  );
  r.rtoSeconds = 0;
  r.measure('listingsP95Ms', percentile(coreMs, 95));
  r.note('Restore the AI key afterwards; the AI alerts (infra/monitoring/rules) should have fired and cleared.');
  r.note('Queued AI jobs retrying with backoff: not covered by this drill.');
  return r.result();
}

export async function stagingPitr(c: StagingConfig): Promise<DrillResult> {
  const p = need(c.pitr, '--image and --walg-env');
  const r = new DrillRecorder('pitr', 'staging');
  const t0 = Date.now();
  const report = await restoreDrill({
    image: p.image,
    walgEnvFile: p.walgEnvFile,
    dockerHost: p.dockerHost,
    network: p.network,
    verifySql: 'select count(*) from agencies',
  });
  r.check('restored, promoted, writable, not archiving', report.archiveMode === 'off');
  r.rtoSeconds = report.rtoSeconds;
  // Upper bound: had the primary died at drill start, everything after the last replayed commit was lost.
  r.rpoSeconds = report.lastReplayedCommit
    ? Math.max(0, secondsSince(new Date(report.lastReplayedCommit).getTime(), t0))
    : null;
  r.measure('backup', report.backup);
  r.measure('fetchBaseSeconds', report.phasesSeconds.fetchBase);
  r.measure('replayAndPromoteSeconds', report.phasesSeconds.replayAndPromote);
  r.measure('agencies', report.verifyOutput ?? '');
  return r.result();
}
