// Chaos drills (S16-02, PLAN §15, degradation matrix §5.4). The drill catalog, the guarded fault injectors and the
// recorder every drill reports through. Local drills run in `tests/ops/chaos.int.test.ts` against the docker `test`
// stack (and throwaway containers for Postgres); staging drills in `chaos-staging.ts`. CLI: `scripts/ops/drill.ts`.
import { spawn } from 'node:child_process';
import { type DockerOptions, DrillError, docker } from './pitr';

export type DrillId = 'search' | 'feed-origin' | 'postgres-primary' | 'redis-queue' | 'ai-provider' | 'pitr';
export type DrillMode = 'local' | 'staging';

export interface DrillSpec {
  id: DrillId;
  /** The §15 drill. */
  drill: string;
  /** The §5.4 row it exercises. */
  matrix: { failure: string; usersSee: string; behaviour: string };
  /** Targets the drill fails on (PLAN §3 #36 / NFR: RPO ≤ 5 min, RTO ≤ 30 min in R1; failover runbook 15 min). */
  targets: { rtoSeconds?: number; rpoSeconds?: number };
  /** What the local drill really does. */
  local: string;
  /** What only staging (H4: real standby, CDN, fresh server, real provider) can show. */
  stagingOnly: string;
}

export const DRILLS: Record<DrillId, DrillSpec> = {
  search: {
    id: 'search',
    drill: 'Kill search → Postgres fallback serves',
    matrix: {
      failure: 'Search engine down',
      usersSee: 'Slightly simpler website search',
      behaviour: 'Postgres fallback for basic filters; cached pages keep serving',
    },
    targets: { rtoSeconds: 60 },
    local:
      'Stops inmolink-meilisearch-test-1; website search (websiteApi.searchListings) keeps answering, degraded, with the same basic-filter results; restarts it and measures the breaker closing on its own.',
    stagingOnly:
      'feed-api processes at real traffic (breaker per process), the SearchFallbackActive alert firing, p95 of the degraded k6 profile (S7-F9) at 1,000 rps.',
  },
  'feed-origin': {
    id: 'feed-origin',
    drill: 'Kill feed-api origin → CDN stale serves',
    matrix: {
      failure: 'feed-api origin down',
      usersSee: 'Nothing (mostly)',
      behaviour: 'CDN serves stale up to 24 h; WP plugin serves its local cache',
    },
    targets: {},
    local:
      'Every public /v2 answer carries stale-if-error = 24 h (the edge-cache table); the S7-06 Cloudflare-model test serves cached answers STALE with the origin stopped.',
    stagingOnly:
      'Cloudflare itself serving STALE (cf-cache-status) with the feed-api containers stopped (runbook cdn.md).',
  },
  'postgres-primary': {
    id: 'postgres-primary',
    drill: 'Kill Postgres primary → promote standby within RTO',
    matrix: {
      failure: 'Postgres primary down',
      usersSee: 'Dashboard read-only for minutes',
      behaviour: 'Promote standby (runbook in R1); websites unaffected via cache',
    },
    targets: { rtoSeconds: 900, rpoSeconds: 300 },
    local:
      'Throwaway primary + streaming hot standby (the production image, slot, settings) under a write load; primary SIGKILLed, standby promoted with the runbook command; RTO to the first write, RPO = acknowledged writes missing.',
    stagingOnly:
      'Two datacenters over WireGuard, fencing db-1, repointing DATABASE_URL_* and redeploying (runbook failover.md steps 3–4: most of the real RTO).',
  },
  'redis-queue': {
    id: 'redis-queue',
    drill: 'Restart redis-queue → zero lost jobs',
    matrix: {
      failure: 'redis-queue down',
      usersSee: 'Background work delayed',
      behaviour: 'AOF persistence; outbox in Postgres replays missed events',
    },
    // Zero lost jobs is a check of its own (a count, not seconds).
    targets: {},
    local:
      'Restarts inmolink-redis-queue-test-1 (graceful) and, separately, docker-kills it (crash, AOF everysec), with marker jobs queued before and outbox events emitted across the outage; every job and event runs (after an outbox replay for the crash window if one was lost), none dead-lettered.',
    stagingOnly:
      'The Ansible redis_queue role (AOF everysec, noeviction) on the real host, marker jobs under a drill-only prefix across the restart, and the real outbox backlog draining.',
  },
  'ai-provider': {
    id: 'ai-provider',
    drill: 'AI provider returning 100 % errors → core flows unaffected',
    matrix: {
      failure: 'AI provider down / slow',
      usersSee: 'AI buttons show "try later"',
      behaviour: 'Jobs queue and retry; core flows never wait on AI',
    },
    targets: {},
    local:
      'The real AI gateway over a provider failing every call (529): listing create → publish → website search and detail work; AI search answers a keyword search; the gateway breaker opens and later AI calls fail fast. Not covered: worker-side AI jobs retrying with backoff.',
    stagingOnly:
      'The real provider SDK and its retries/timeouts against a failing endpoint (an invalid key on staging).',
  },
  pitr: {
    id: 'pitr',
    drill: 'Full restore from PITR to a fresh server → measured RTO',
    matrix: {
      failure: 'Postgres primary lost (with its standby)',
      usersSee: 'Dashboard down until restored',
      behaviour: 'WAL-G PITR from R2 (RPO ≤ 5 min), automated weekly restore drill',
    },
    targets: { rtoSeconds: 1_800, rpoSeconds: 300 },
    local:
      'The primary above is killed mid-load; the WAL-G store on MinIO is restored onto a fresh container (restoreDrill); RTO measured, RPO = last acknowledged commit − last replayed commit.',
    stagingOnly:
      'R2 over the internet, a production-sized base backup, a really fresh server (the weekly restore-drill workflow).',
  },
};

export const DRILL_IDS = Object.keys(DRILLS) as DrillId[];

export interface DrillCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DrillResult {
  drill: DrillId;
  mode: DrillMode;
  startedAt: string;
  finishedAt: string;
  /** Fault injected → service back (as the matrix defines "back" for this failure), seconds. */
  rtoSeconds: number | null;
  /** Data lost: seconds of acknowledged writes; null where the drill counts losses instead (see measurements). */
  rpoSeconds: number | null;
  measurements: Record<string, number | string>;
  checks: DrillCheck[];
  /** What was disrupted, from when to when (ISO), so other users of the stack can correlate. */
  disrupted: { target: string; action: string; from: string; to: string | null }[];
  notes: string[];
  passed: boolean;
}

const round = (s: number) => Math.round(s * 100) / 100;
export const secondsSince = (fromMs: number, toMs = Date.now()) => round((toMs - fromMs) / 1_000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects one drill's checks, measurements and disruptions; `result()` applies the spec's targets. */
export class DrillRecorder {
  readonly t0 = Date.now();
  private readonly checks: DrillCheck[] = [];
  private readonly measurements: Record<string, number | string> = {};
  private readonly disrupted: DrillResult['disrupted'] = [];
  private readonly notes: string[] = [];
  rtoSeconds: number | null = null;
  rpoSeconds: number | null = null;

  constructor(
    readonly drill: DrillId,
    readonly mode: DrillMode,
  ) {}

  check(name: string, ok: boolean, detail?: string): boolean {
    this.checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  }

  measure(name: string, value: number | string): void {
    this.measurements[name] = typeof value === 'number' ? round(value) : value;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** Marks a disruption's start (now, or `atMs`); call the returned function when it ends. */
  disrupt(target: string, action: string, atMs = Date.now()): (endMs?: number) => void {
    const entry = { target, action, from: new Date(atMs).toISOString(), to: null as string | null };
    this.disrupted.push(entry);
    return (endMs = Date.now()) => {
      entry.to = new Date(endMs).toISOString();
    };
  }

  result(): DrillResult {
    const { targets } = DRILLS[this.drill];
    const checks = [...this.checks];
    if (targets.rtoSeconds !== undefined) {
      checks.push({
        name: `RTO within ${targets.rtoSeconds} s`,
        ok: this.rtoSeconds !== null && this.rtoSeconds <= targets.rtoSeconds,
        detail: `${this.rtoSeconds ?? 'not measured'} s`,
      });
    }
    if (targets.rpoSeconds !== undefined) {
      checks.push({
        name: `RPO within ${targets.rpoSeconds} s`,
        ok: this.rpoSeconds !== null && this.rpoSeconds <= targets.rpoSeconds,
        detail: `${this.rpoSeconds ?? 'not measured'}`,
      });
    }
    return {
      drill: this.drill,
      mode: this.mode,
      startedAt: new Date(this.t0).toISOString(),
      finishedAt: new Date().toISOString(),
      rtoSeconds: this.rtoSeconds,
      rpoSeconds: this.rpoSeconds,
      measurements: { ...this.measurements },
      checks,
      disrupted: this.disrupted.map((d) => ({ ...d })),
      notes: [...this.notes],
      passed: checks.length > 0 && checks.every((c) => c.ok),
    };
  }
}

/** Polls `fn` until it returns a value (not undefined); throws after `timeoutMs`. */
export async function until<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 90_000,
  stepMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new DrillError(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(stepMs);
  }
}

/**
 * Local fault injection is allowed on this project's `test` stack containers and on the drills' own throwaway
 * containers only — never the dev stack, never another project's containers.
 */
export const LOCAL_TEST_CONTAINER = /^inmolink-[a-z0-9]+(?:-[a-z0-9]+)*-test-\d+$/;
export const THROWAWAY_PREFIX = 'chaos-';

export function assertLocalTarget(container: string): void {
  if (!LOCAL_TEST_CONTAINER.test(container) && !container.startsWith(THROWAWAY_PREFIX)) {
    throw new DrillError(
      `refusing to disrupt ${container}: local drills touch only inmolink-*-test-* or ${THROWAWAY_PREFIX}* containers`,
    );
  }
}

/** Local engine (no dockerHost): only the test stack and throwaways. With dockerHost (staging) the drill names its hosts. */
export type ContainerOptions = DockerOptions;

const guard = (container: string, o: ContainerOptions) => {
  if (!o.dockerHost) assertLocalTarget(container);
};

/** `docker stop` (SIGTERM, then SIGKILL after `graceSeconds`). */
export async function stopContainer(container: string, o: ContainerOptions = {}, graceSeconds = 10): Promise<void> {
  guard(container, o);
  await docker(['stop', '-t', String(graceSeconds), container], o, 120_000);
}

/** `docker kill`: the hard crash (no shutdown checkpoint, no AOF flush). */
export async function killContainer(container: string, o: ContainerOptions = {}): Promise<void> {
  guard(container, o);
  await docker(['kill', container], o, 60_000);
}

export async function startContainer(container: string, o: ContainerOptions = {}): Promise<void> {
  guard(container, o);
  await docker(['start', container], o, 120_000);
}

/** Health of a container with a HEALTHCHECK (`healthy`, `starting`, `unhealthy`), or its state when it has none. */
export async function containerHealth(container: string, o: DockerOptions = {}): Promise<string> {
  return docker(
    ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container],
    o,
    30_000,
  );
}

export async function waitHealthy(container: string, o: DockerOptions = {}, timeoutMs = 120_000): Promise<number> {
  const t0 = Date.now();
  await until(
    `${container} healthy`,
    async () => {
      const h = await containerHealth(container, o);
      return h === 'healthy' || h === 'running' ? true : undefined;
    },
    timeoutMs,
    500,
  );
  return secondsSince(t0);
}

/** Percentile of a sample (nearest rank), ms. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
}

/** One probe answer during a staging CDN drill. */
export interface EdgeSample {
  atMs: number;
  status: number;
  /** `cf-cache-status` (HIT, STALE, UPDATING, MISS, EXPIRED, BYPASS, DYNAMIC) or '' when absent. */
  cacheStatus: string;
  /** The URL was cached before the origin stopped. */
  warmed: boolean;
}

/**
 * Matrix row "feed-api origin down → CDN serves stale": while the origin is down every warmed URL answers 200 from the
 * edge (HIT while fresh, STALE/UPDATING after); unwarmed URLs may fail. Returns the failed checks (empty = matches).
 */
export function evaluateEdgeOutage(samples: readonly EdgeSample[]): string[] {
  const problems: string[] = [];
  const warmed = samples.filter((s) => s.warmed);
  if (warmed.length === 0) problems.push('no warmed URL was probed while the origin was down');
  const served = new Set(['HIT', 'STALE', 'UPDATING', 'REVALIDATED']);
  const failed = warmed.filter((s) => s.status !== 200 || !served.has(s.cacheStatus.toUpperCase()));
  if (failed.length > 0) {
    const first = failed[0] as EdgeSample;
    problems.push(
      `${failed.length} of ${warmed.length} warmed answers were not served from the edge (first: ${first.status} ${first.cacheStatus || 'no cf-cache-status'})`,
    );
  }
  if (!warmed.some((s) => /^(STALE|UPDATING)$/i.test(s.cacheStatus))) {
    problems.push('no STALE answer: the outage was shorter than the cached TTL, so stale-if-error was not exercised');
  }
  return problems;
}

/** The results as a Markdown table (for `docs/build/reviews/chaos-R1.md` and the CLI). */
export function formatResults(results: readonly DrillResult[]): string {
  const rows = results.map((r) => {
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    return `| ${DRILLS[r.drill].drill} | ${r.mode} | ${r.passed ? 'PASS' : `FAIL (${failed.join('; ')})`} | ${r.rtoSeconds ?? '–'} | ${r.rpoSeconds ?? '–'} | ${Object.entries(
      r.measurements,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')} |`;
  });
  return ['| Drill | Mode | Result | RTO s | RPO | Measurements |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

/** One write the ticker saw committed: commit time on the server's clock (epoch s) and the WAL position after it. */
export interface TickerWrite {
  at: number;
  lsn: string;
}

export interface WriteTicker {
  /** n → the committed write, in commit order. */
  acked: Map<number, TickerWrite>;
  /** Resolves when the ticker process ends (the primary died, or `stop`). */
  exited: Promise<void>;
  stop(): void;
  /** Highest acknowledged n (0 before the first). */
  last(): number;
}

/**
 * A write load inside a Postgres container: one row into `table` (n int primary key, at timestamptz) every ~50 ms,
 * each committed row printed with its commit time and `pg_current_wal_lsn()` — so a drill knows exactly which writes
 * were acknowledged up to the moment the server died (RPO). `table` must be a plain identifier.
 */
export function startWriteTicker(container: string, table: string, o: DockerOptions = {}): WriteTicker {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new DrillError(`not a plain table name: ${table}`);
  const loop =
    'n=0; while true; do n=$((n+1)); ' +
    `psql -h /var/run/postgresql -d inmolink -XtAq -c "insert into ${table} values ($n, clock_timestamp()) returning n || ' ' || extract(epoch from at) || ' ' || pg_current_wal_lsn()" || exit 1; ` +
    'sleep 0.05; done';
  const env = { ...process.env };
  if (o.dockerHost) env.DOCKER_HOST = o.dockerHost;
  const child = spawn('docker', ['exec', '-u', 'postgres', container, 'bash', '-c', loop], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const acked = new Map<number, TickerWrite>();
  let buf = '';
  let last = 0;
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const [n, at, lsn] = line.trim().split(' ');
      if (n && at && lsn) {
        acked.set(Number(n), { at: Number(at), lsn });
        last = Math.max(last, Number(n));
      }
    }
  });
  const exited = new Promise<void>((res) => child.on('exit', () => res()));
  return { acked, exited, stop: () => child.kill(), last: () => last };
}

/** `X/Y` → a comparable number of bytes. */
export const lsnBytes = (lsn: string): bigint => {
  const [hi, lo] = lsn.trim().split('/');
  if (!hi || !lo) throw new DrillError(`not an LSN: ${lsn}`);
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
};

/**
 * Data lost at a failover / restore: the acknowledged writes beyond `survivorMaxN` (the highest n the new primary
 * holds) and the seconds of commits they span (server clock). Zero when none is missing.
 */
export function writesLost(
  t: WriteTicker,
  survivorMaxN: number,
  survivorMaxAt: number,
): { lost: number; rpoSeconds: number } {
  const lost = [...t.acked.keys()].filter((n) => n > survivorMaxN).length;
  const lastAt = t.acked.get(t.last())?.at ?? survivorMaxAt;
  return { lost, rpoSeconds: lost === 0 ? 0 : Math.max(0, Math.round((lastAt - survivorMaxAt) * 100) / 100) };
}
