import { describe, expect, it } from 'vitest';
import { assertDrillTargets } from '../../scripts/ops/drill-guard';
import { canonicalHost, hostClassifier, hostOf, isLoopback } from '../../scripts/ops/target-hosts';
import { assertLoadTarget } from '../../scripts/perf/load-sites';

const hosts = hostClassifier();
const PROD_DB = 'postgres://app_user:x@10.10.0.21:6432/inmolink';
const STAGING_DB = 'postgres://app_user:x@10.20.0.11:6432/inmolink';
const LOCAL_DB = 'postgres://app_user:x@localhost:6433/inmolink';

describe('operator target guards (S17-F2)', () => {
  it('[S17-F2] the deploy config tells production from staging hosts', () => {
    for (const h of [
      '203.0.113.10',
      '10.10.0.21',
      '198.51.100.30',
      'api.inmolink.es',
      'inmolink.es',
      'x.inmolink.es',
    ]) {
      expect(hosts.isProduction(h), h).toBe(true);
    }
    for (const h of ['203.0.113.50', '10.20.0.11', 'api.staging.inmolink.es', 'staging.inmolink.es']) {
      expect(hosts.isProduction(h), h).toBe(false);
      expect(hosts.isStaging(h), h).toBe(true);
    }
    expect(hosts.isStaging('203.0.113.10')).toBe(false);
    // inventory names (an ssh config's aliases), upper case and a trailing dot
    for (const h of ['db-1', 'db-2', 'app-1', 'drill-1', 'API.INMOLINK.ES.'])
      expect(hosts.isProduction(hostOf(`ssh://${h}`) ?? ''), h).toBe(true);
    expect(hosts.isStaging('staging-1')).toBe(true);
    // other spellings of a production address
    for (const h of ['3405803786', '0xcb00710a', '[::ffff:203.0.113.10]', '203.0.113.10.']) {
      expect(hosts.isProduction(hostOf(`ssh://${h}`) ?? ''), h).toBe(true);
    }
    expect(canonicalHost('::FFFF:cb00:710a')).toBe('203.0.113.10');
    expect(hostOf('ssh://root@API.Inmolink.es:22')).toBe('api.inmolink.es');
    expect(hostOf('10.0.0.1:6432')).toBe('10.0.0.1');
    expect(hostOf('')).toBeNull();
    expect(isLoopback('127.0.0.1') && isLoopback('localhost') && !isLoopback('10.0.0.1')).toBe(true);
  });

  it('[S17-F2] ops:drill refuses a production host (only test / staging targets)', () => {
    const env = { CHAOS_STAGING_HOSTS: 'ssh://deploy@203.0.113.50,ssh://deploy@203.0.113.10' };
    const staging = (t: { sshHosts?: string[]; urls?: string[] }, e: Record<string, string> = env) =>
      assertDrillTargets({ local: false, env: e, ...t }, hosts);
    expect(() =>
      staging({ sshHosts: ['ssh://deploy@203.0.113.50'], urls: ['https://feed.staging.inmolink.es/x'] }),
    ).not.toThrow();
    // Listed by the operator, but a production server: refused all the same.
    expect(() => staging({ sshHosts: ['ssh://deploy@203.0.113.10'] })).toThrow(/production host/);
    expect(() => staging({ urls: ['https://feed.inmolink.es/v2/listings?_k=1'] })).toThrow(/production host/);
    expect(() => staging({ urls: ['https://inmolink.es/healthz'] })).toThrow(/production host/);
    expect(() => staging({ urls: ['redis://10.10.0.11:6380'] })).toThrow(/production host/);
    // Unknown hosts are not staging; a tunnel on this machine is.
    expect(() => staging({ urls: ['https://example.com/'] })).toThrow(/not a staging host/);
    expect(() => staging({ urls: ['redis://127.0.0.1:16380'] })).not.toThrow();
    expect(() => staging({ sshHosts: ['ssh://deploy@203.0.113.99'] })).toThrow(/not in CHAOS_STAGING_HOSTS/);
    expect(() => staging({ sshHosts: ['203.0.113.50'] })).toThrow(/ssh:\/\//);
    // The environment itself.
    expect(() => staging({}, { ...env, DEPLOY_ENV: 'production' })).toThrow(/DEPLOY_ENV=production/);
    expect(() => staging({}, { ...env, NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
    expect(() => staging({}, { ...env, NODE_ENV: 'production', DEPLOY_ENV: 'staging' })).not.toThrow();
    // --local: the docker test stack only.
    const local = (e: Record<string, string>) => assertDrillTargets({ local: true, env: e }, hosts);
    expect(() => local({ DATABASE_URL_APP_USER: LOCAL_DB, REDIS_QUEUE_URL: 'redis://localhost:6380' })).not.toThrow();
    expect(() => local({ DATABASE_URL_APP_USER: PROD_DB })).toThrow(/not the local test stack/);
    expect(() => local({ REDIS_QUEUE_URL: 'redis://10.20.0.11:6380' })).toThrow(/REDIS_QUEUE_URL/);
    expect(() => local({ DEPLOY_ENV: 'staging' })).toThrow(/--local/);
  });

  it('[S17-F2] assertLoadTarget refuses a wrong database host, not only a production environment name', () => {
    // A test environment by name, but production credentials: refused.
    expect(() => assertLoadTarget({ NODE_ENV: 'test', DATABASE_URL_APP_USER: PROD_DB }, false, hosts)).toThrow(
      /production \(10\.10\.0\.21\)/,
    );
    expect(() =>
      assertLoadTarget({ NODE_ENV: 'production', DEPLOY_ENV: 'staging', DATABASE_URL_ADMIN: PROD_DB }, true, hosts),
    ).toThrow(/production/);
    // A local run stays on this machine; a staging run on loopback or the staging servers.
    expect(() => assertLoadTarget({ NODE_ENV: 'test', DATABASE_URL_APP_USER: LOCAL_DB }, false, hosts)).not.toThrow();
    expect(() => assertLoadTarget({ NODE_ENV: 'test', DATABASE_URL_APP_USER: STAGING_DB }, false, hosts)).toThrow(
      /not this machine/,
    );
    const stagingEnv = { NODE_ENV: 'production', DEPLOY_ENV: 'staging' };
    expect(() => assertLoadTarget({ ...stagingEnv, DATABASE_URL_APP_USER: STAGING_DB }, true, hosts)).not.toThrow();
    expect(() => assertLoadTarget({ ...stagingEnv, DATABASE_URL_APP_USER: LOCAL_DB }, true, hosts)).not.toThrow();
    expect(() =>
      assertLoadTarget({ ...stagingEnv, DATABASE_URL_APP_USER: 'postgres://u:p@db.example.com/x' }, true, hosts),
    ).toThrow(/not a staging host/);
    // libpq's host overrides: the URL's host is not where it connects
    for (const url of [
      'postgres://u@localhost/db?host=10.10.0.21',
      'postgres://u@localhost/db?hostaddr=10.10.0.21',
      'postgres://u@localhost,10.10.0.21/db',
    ]) {
      expect(() => assertLoadTarget({ NODE_ENV: 'test', DATABASE_URL_APP_USER: url }, false, hosts), url).toThrow(
        /names no database host/,
      );
    }
    expect(() =>
      assertDrillTargets(
        { local: true, env: { DATABASE_URL_APP_USER: 'postgres://u@localhost/db?host=10.10.0.21' } },
        hosts,
      ),
    ).toThrow(/not the local test stack/);
    expect(() => assertLoadTarget({ NODE_ENV: 'test', DATABASE_URL_APP_USER: 'not a url' }, false, hosts)).toThrow(
      /names no database host/,
    );
  });
});
