// pnpm ops:drill <drill|all> --local [--report <file.json>]
// pnpm ops:drill <drill> --staging [--confirm] [flags below] [--report <file.json>]
//
// Chaos drills (S16-02, PLAN §15 / §5.4): search | feed-origin | postgres-primary | redis-queue | ai-provider | pitr.
//
// --local runs the drill in tests/ops/chaos.int.test.ts (vitest project `ops-chaos`, not in test:int:root) against
// the docker `test` stack (Meilisearch stopped, redis-queue restarted and crashed; Postgres drills on throwaway containers — the shared test Postgres is never killed).
// feed-origin --local also runs the S7-06 "origin stopped" Cloudflare-model test of feed-api.
//
// --staging injects the fault on the staging hosts over SSH (BLOCKED-HUMAN H4 until those exist):
//   --search-host ssh://…  --feed-api-host ssh://…  --db-primary-host ssh://…  --db-standby-host ssh://…
//   --redis-host ssh://…   --edge-url <CDN URL with _k> (repeat)  --origin-listings-url <url>
//   --origin-ai-search-url <url>  --dashboard-health-url <url>  --worker-health-url <url>  --outage-seconds <n>
//   pitr: --image <ref> --walg-env <file> [--fresh-host ssh://…] [--network <name>]
//   Every host must be listed in CHAOS_STAGING_HOSTS (comma-separated). The drill site's secret key comes from
//   CHAOS_API_KEY; the redis-queue drill reaches the staging redis-queue through CHAOS_REDIS_QUEUE_URL (a tunnel).
//   Runbooks: docs/runbooks/{search,cdn,failover,queues,pitr-restore}.md.
//
// Exit 0 = every drill matched the degradation matrix and its RTO/RPO targets. Results: docs/build/reviews/chaos-R1.md.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DRILL_IDS, DRILLS, type DrillId, type DrillResult, formatResults } from './chaos';
import {
  STAGING_DEFAULTS,
  type StagingConfig,
  stagingAiProvider,
  stagingFeedOrigin,
  stagingPitr,
  stagingPostgresPrimary,
  stagingRedisQueue,
  stagingSearch,
} from './chaos-staging';
import { DrillError } from './pitr';

const ROOT = join(import.meta.dirname, '..', '..');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    local: { type: 'boolean', default: false },
    staging: { type: 'boolean', default: false },
    confirm: { type: 'boolean', default: false },
    report: { type: 'string' },
    'search-host': { type: 'string' },
    'feed-api-host': { type: 'string' },
    'db-primary-host': { type: 'string' },
    'db-standby-host': { type: 'string' },
    'redis-host': { type: 'string' },
    'edge-url': { type: 'string', multiple: true },
    'origin-listings-url': { type: 'string' },
    'origin-ai-search-url': { type: 'string' },
    'dashboard-health-url': { type: 'string' },
    'worker-health-url': { type: 'string' },
    'outage-seconds': { type: 'string' },
    image: { type: 'string' },
    'walg-env': { type: 'string' },
    'fresh-host': { type: 'string' },
    network: { type: 'string' },
  },
});

/** The local test's name tag per drill (`-t` filter). */
const LOCAL_TEST: Record<DrillId, string> = {
  search: '[S16-02] kill search',
  'feed-origin': '[S16-02] kill feed-api origin',
  'postgres-primary': '[S16-02] kill Postgres primary',
  'redis-queue': '[S16-02] restart redis-queue',
  'ai-provider': '[S16-02] AI provider',
  pitr: '[S16-02] full restore from PITR',
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function runLocal(drills: DrillId[]): DrillResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'inmolink-drill-'));
  const report = join(dir, 'chaos.json');
  try {
    const filter =
      drills.length === DRILL_IDS.length ? '\\[S16-02\\]' : drills.map((d) => escapeRe(LOCAL_TEST[d])).join('|');
    // Node + vitest's own entry, no shell: the `-t` pattern keeps its blanks and `|` on Windows too.
    const run = spawnSync(
      process.execPath,
      [VITEST, 'run', '--project', 'ops-chaos', 'tests/ops/chaos.int.test.ts', '-t', filter, '--reporter=dot'],
      { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CHAOS_REPORT: report } },
    );
    if (drills.includes('feed-origin')) {
      const model = spawnSync(
        process.execPath,
        [VITEST, 'run', 'src/edge-cache.int.test.ts', '-t', 'origin stopped', '--reporter=dot'],
        { cwd: join(ROOT, 'apps', 'feed-api'), stdio: 'inherit' },
      );
      if (model.status !== 0) {
        console.error('feed-origin: the S7-06 Cloudflare-model test failed');
        process.exitCode = 1;
      }
    }
    if (run.status !== 0) process.exitCode = 1;
    try {
      return JSON.parse(readFileSync(report, 'utf8')) as DrillResult[];
    } catch {
      throw new DrillError('the local drill run wrote no report (see the test output above)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runStaging(drill: DrillId): Promise<DrillResult> {
  const c: StagingConfig = {
    ...STAGING_DEFAULTS,
    edgeUrls: values['edge-url'] ?? [],
    originListingsUrl: values['origin-listings-url'],
    originAiSearchUrl: values['origin-ai-search-url'],
    apiKey: process.env.CHAOS_API_KEY,
    redisQueueUrl: process.env.CHAOS_REDIS_QUEUE_URL,
    dashboardHealthUrl: values['dashboard-health-url'],
    workerHealthUrl: values['worker-health-url'],
    hosts: {
      search: values['search-host'],
      feedApi: values['feed-api-host'],
      dbPrimary: values['db-primary-host'],
      dbStandby: values['db-standby-host'],
      redis: values['redis-host'],
    },
    pitr:
      values.image && values['walg-env']
        ? {
            image: values.image,
            walgEnvFile: values['walg-env'],
            dockerHost: values['fresh-host'],
            network: values.network,
          }
        : undefined,
    outageSeconds: values['outage-seconds'] ? Number(values['outage-seconds']) : STAGING_DEFAULTS.outageSeconds,
    confirm: values.confirm,
  };
  // Only hosts the operator listed for this run (CHAOS_STAGING_HOSTS, comma-separated ssh:// URLs) are touched.
  const allowed = new Set(
    (process.env.CHAOS_STAGING_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  );
  for (const h of [...Object.values(c.hosts), c.pitr?.dockerHost]) {
    if (h && !/^ssh:\/\//.test(h)) throw new DrillError(`staging hosts are ssh:// URLs (got ${h})`);
    if (h && !allowed.has(h)) throw new DrillError(`${h} is not in CHAOS_STAGING_HOSTS: refusing to touch it`);
  }
  switch (drill) {
    case 'search':
      return stagingSearch(c);
    case 'feed-origin':
      return stagingFeedOrigin(c);
    case 'postgres-primary':
      return stagingPostgresPrimary(c);
    case 'redis-queue':
      return stagingRedisQueue(c);
    case 'ai-provider':
      return stagingAiProvider(c);
    case 'pitr':
      return stagingPitr(c);
  }
}

try {
  const [name] = positionals;
  if (!name || (name !== 'all' && !DRILL_IDS.includes(name as DrillId))) {
    throw new DrillError(`usage: ops:drill <${DRILL_IDS.join('|')}|all> --local | --staging`);
  }
  if (values.local === values.staging) throw new DrillError('pass exactly one of --local or --staging');
  const drills = name === 'all' ? DRILL_IDS : [name as DrillId];
  let results: DrillResult[];
  if (values.local) results = runLocal(drills);
  else {
    if (name === 'all') throw new DrillError('staging drills run one at a time (each disrupts real hosts)');
    results = [await runStaging(drills[0] as DrillId)];
  }
  if (values.report) writeFileSync(values.report, `${JSON.stringify(results, null, 2)}\n`);
  console.log(formatResults(results));
  for (const r of results) {
    for (const c of r.checks.filter((x) => !x.ok))
      console.error(`  ${DRILLS[r.drill].drill}: FAILED ${c.name} ${c.detail ?? ''}`);
  }
  if (results.length < drills.length || results.some((r) => !r.passed)) process.exitCode = 1;
} catch (err) {
  console.error(`chaos drill FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
