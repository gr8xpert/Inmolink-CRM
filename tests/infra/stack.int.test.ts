import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS, checkStack, REQUIRED_EXTENSIONS } from '../../scripts/ops/health';
import { readStackEnv, type StackTarget } from '../../scripts/ops/stack-env';

const ROOT = join(import.meta.dirname, '..', '..');

interface ComposeService {
  profiles?: string[];
  ports?: { published?: string }[];
  volumes?: { type: string; source?: string }[];
}

const compose = JSON.parse(
  execFileSync('docker', ['compose', '--profile', 'dev', '--profile', 'test', 'config', '--format', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }),
) as { services: Record<string, ComposeService> };

const servicesOf = (profile: StackTarget) =>
  Object.entries(compose.services).filter(([, s]) => s.profiles?.includes(profile));

const hostPorts = (profile: StackTarget) =>
  new Set(servicesOf(profile).flatMap(([, s]) => (s.ports ?? []).map((p) => Number(p.published))));

const namedVolumes = (profile: StackTarget) =>
  new Set(
    servicesOf(profile).flatMap(([, s]) =>
      (s.volumes ?? []).filter((v) => v.type === 'volume').map((v) => v.source ?? ''),
    ),
  );

/** Every localhost port an env file points at. */
const envPorts = (target: StackTarget) =>
  Object.values(readStackEnv(target))
    .map((value) => value?.match(/localhost:(\d+)/)?.[1])
    .filter((port): port is string => port !== undefined)
    .map(Number);

describe('local stack', () => {
  it('[S0-02] test profile uses separate ports and volumes', () => {
    const [devPorts, testPorts] = [hostPorts('dev'), hostPorts('test')];
    expect(devPorts.size).toBeGreaterThan(0);
    expect([...testPorts].filter((p) => devPorts.has(p))).toEqual([]);

    const [devVolumes, testVolumes] = [namedVolumes('dev'), namedVolumes('test')];
    expect(testVolumes.size).toBeGreaterThan(0);
    expect([...testVolumes].filter((v) => devVolumes.has(v))).toEqual([]);

    // Each env file only reaches its own profile's ports.
    for (const port of envPorts('dev')) expect(devPorts, `dev env port ${port}`).toContain(port);
    for (const port of envPorts('test')) expect(testPorts, `test env port ${port}`).toContain(port);
  });

  it('[S0-02] extensions are created by the init script and verified by the health check', () => {
    const sql = readFileSync(join(ROOT, 'infra/docker/postgres/initdb/01-extensions.sql'), 'utf8');
    const created = [...sql.matchAll(/CREATE EXTENSION IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...REQUIRED_EXTENSIONS].sort());
  });

  it('[S0-02] health script covers every long-running service in each profile', () => {
    for (const target of ['dev', 'test'] as const) {
      const services = servicesOf(target)
        .filter(([name]) => !name.startsWith('minio-init')) // bucket setup, not a service
        .map(([name]) => name.replace(/-test$/, ''));
      expect(CHECKS[target].map((c) => c.name).sort(), target).toEqual(services.sort());
    }
  });

  it('[S0-02] health script passes against the running test stack', async () => {
    const results = await checkStack('test');
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.find((r) => r.name === 'postgres')?.detail).toContain('pg_partman');
  });
});
