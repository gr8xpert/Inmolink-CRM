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
