import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** The test stack's env (`.env.test`, else the example) — passed explicitly, so `loadStackEnv` in main.ts stays out. */
function stackEnv(): Record<string, string> {
  const file = [join(ROOT, '.env.test'), join(ROOT, '.env.test.example')].find((f) => existsSync(f));
  if (!file) throw new Error('no .env.test(.example)');
  const env = parseEnv(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

const APPS = [
  { name: 'api', port: 54100, portVar: 'API_PORT', metrics: 54110, metricsVar: 'API_METRICS_PORT' },
  { name: 'feed-api', port: 54101, portVar: 'FEED_API_PORT', metrics: 54111, metricsVar: 'FEED_API_METRICS_PORT' },
  { name: 'realtime', port: 54102, portVar: 'REALTIME_PORT', metrics: 54112, metricsVar: 'REALTIME_METRICS_PORT' },
  // `maintenance` has no jobs yet; never `outbox` here — it would claim the queue suite's events.
  {
    name: 'worker',
    port: 54103,
    portVar: 'WORKER_HEALTH_PORT',
    metrics: 54113,
    metricsVar: 'WORKER_METRICS_PORT',
    extra: { WORKER_POOLS: 'maintenance' },
  },
] as const;

const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
});

async function waitReady(port: number, child: ChildProcess, output: () => string): Promise<unknown> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited with ${child.exitCode}:\n${output()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3_000) });
      if (res.status === 200) return res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not ready in 90 s:\n${output()}`);
}

describe('app entry points', () => {
  for (const app of APPS) {
    it(`[S0-08] [S0-10] ${app.name} boots from main.ts with telemetry, reports ready, serves /metrics and exits on SIGTERM`, async () => {
      const env = stackEnv();
      // The same preload as the app's `dev`/`start` scripts.
      const args = [
        TSX,
        '--conditions=@inmolink/source',
        '--import',
        '@inmolink/platform/telemetry/register',
        'src/main.ts',
      ];
      const child = spawn(process.execPath, args, {
        cwd: join(ROOT, 'apps', app.name),
        env: {
          ...process.env,
          ...env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'warn',
          [app.portVar]: String(app.port),
          [app.metricsVar]: String(app.metrics),
          ...('extra' in app ? app.extra : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      child.stdout?.on('data', (d) => {
        output += d;
      });
      child.stderr?.on('data', (d) => {
        output += d;
      });

      const body = await waitReady(app.port, child, () => output);
      expect(body).toMatchObject({ status: 'ok' });
      const metrics = await fetch(`http://127.0.0.1:${app.metrics}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain(`service_name="${app.name}"`);
      // [S7-08] the load test found feed-api booting without a search engine (every `/v2/listings` a 500): its
      // readiness now reports the engine configured.
      if (app.name === 'feed-api') expect(body).toMatchObject({ checks: { searchConfigured: 'ok' } });

      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      const code = await exited;
      // Windows has no SIGTERM delivery (the process is terminated); the drain itself is covered by the
      // platform and worker tests. On Linux (CI, servers) a clean drain exits 0.
      if (process.platform !== 'win32') expect(code, output).toBe(0);
    }, 120_000);
  }
});
