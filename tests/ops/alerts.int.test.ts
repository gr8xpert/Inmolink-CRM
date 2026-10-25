import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docker } from '../../scripts/ops/pitr';

// promtool from the same Prometheus release the monitoring role deploys (infra/ansible/group_vars/all.yml).
const PROMETHEUS_IMAGE = 'prom/prometheus:v3.13.4';
const RULES = join(import.meta.dirname, '..', '..', 'infra', 'monitoring', 'rules');

const promtool = (...args: string[]) =>
  docker(
    ['run', '--rm', '-v', `${RULES}:/rules:ro`, '--entrypoint', 'promtool', PROMETHEUS_IMAGE, ...args],
    {},
    180_000,
    true,
  );

describe('Postgres alerts', () => {
  it('[S0-15] alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/postgres.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S0-15] replica lag alert fires when lag > 60 s (and not below), plus streaming, archiving and base-backup alerts', async () => {
    // postgres.test.yml: lag 59 s → no alert; 61 s → pending; held 30 s → PostgresReplicaLagHigh firing.
    expect(await promtool('test', 'rules', '/rules/postgres.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Search alerts', () => {
  it('[S5-04] search fallback alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/search.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S5-04] the fallback alert fires when the breaker stays open 2 min, and on a high fallback share', async () => {
    expect(await promtool('test', 'rules', '/rules/search.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Import alerts', () => {
  it('[S6-08] import alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/imports.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S6-08] [S7-F1] a paused feed (spike, drop or empty feed) alerts at once; a feed run waiting over 15 min in the queue alerts after 5 min', async () => {
    expect(await promtool('test', 'rules', '/rules/imports.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Website API alerts', () => {
  it('[S7-04] website anti-scraping alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/website.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  // The test file also holds the S7-F7 case: failing limiter calls are critical after 5 minutes.
  it('[S7-04] [S7-F7] scripted paging and a honeytoken hit alert at once and clear after 15 quiet minutes; failing rate limits page', async () => {
    expect(await promtool('test', 'rules', '/rules/website.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Queue age alerts', () => {
  it('[S11-review] queue age alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/queues.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S11-review] a delivery pool (realtime, email) past a 30 s p95 alerts after 5 min; digests only past 15 min', async () => {
    expect(await promtool('test', 'rules', '/rules/queues.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Security alerts', () => {
  it('[S12-F8] security alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/security.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  it('[S12-F8] pending fingerprint rehash near the end of an HMAC rotation window alerts at once and clears at 0', async () => {
    expect(await promtool('test', 'rules', '/rules/security.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});

describe('Redis memory alerts', () => {
  it('[S7-04] redis memory alert rules are valid Prometheus rules', async () => {
    expect(await promtool('check', 'rules', '/rules/redis.yml')).toMatch(/SUCCESS: \d+ rules found/);
  }, 200_000);

  // The test file also holds the S7-F7 case: an exporter (or its Redis) not answering is critical after 5 minutes.
  it('[S7-04] [S7-F7] redis-queue past 80 % of maxmemory warns after 10 min, past 95 % is critical after 2 min; a silent exporter is critical', async () => {
    expect(await promtool('test', 'rules', '/rules/redis.test.yml')).toMatch(/SUCCESS/);
  }, 200_000);
});
