// S17-F2 (S16 review): `ops:drill` disrupts only test or staging targets, never production.
//
// - The environment must not say production: `DEPLOY_ENV` (if set) development, test or staging; `NODE_ENV=production`
//   only next to `DEPLOY_ENV=staging`. A `--local` run also refuses `DEPLOY_ENV=staging`, and every `DATABASE_URL_*` /
//   `REDIS_*_URL` already in the environment must be loopback (the docker `test` stack).
// - `--staging`: every ssh host must be an `ssh://` URL listed in `CHAOS_STAGING_HOSTS`; every host the drill
//   touches or probes (ssh hosts, the edge / origin / health URLs, the redis-queue tunnel) must parse, must not be a
//   production host of the deploy config (`target-hosts.ts`) — whatever `CHAOS_STAGING_HOSTS` lists — and must be
//   loopback (a tunnel), a staging host of the deploy config, or listed in `CHAOS_STAGING_HOSTS`. Hosts are compared as
//   spelled after normalising (`target-hosts.ts` `canonicalHost`), not resolved: an ssh alias or DNS name the operator
//   lists that points at a production server is the operator's to check (runbook chaos-R1.md).
import { DrillError } from './pitr';
import { dbHostOf, type HostClassifier, hostClassifier, hostOf, isLoopback } from './target-hosts';

export interface DrillTargets {
  local: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** `--staging`: the ssh hosts (search, feed-api, db primary / standby, redis, the PITR docker host). */
  sshHosts?: readonly (string | undefined)[];
  /** `--staging`: every URL the drill calls (edge, origin, health, the redis-queue tunnel). */
  urls?: readonly (string | undefined)[];
}

const ENV_OK = ['development', 'test', 'staging'];

/** Throws `DrillError` when a drill would touch production (or a target nobody listed). */
export function assertDrillTargets(t: DrillTargets, hosts: HostClassifier = hostClassifier()): void {
  const deploy = t.env.DEPLOY_ENV?.trim() || undefined;
  const node = t.env.NODE_ENV?.trim() || undefined;
  if (deploy && !ENV_OK.includes(deploy)) throw new DrillError(`refusing a drill with DEPLOY_ENV=${deploy}`);
  if (node === 'production' && deploy !== 'staging') {
    throw new DrillError('refusing a drill with NODE_ENV=production (only DEPLOY_ENV=staging may run one)');
  }
  if (t.local) {
    if (deploy === 'staging')
      throw new DrillError('--local runs on the docker test stack, not with DEPLOY_ENV=staging');
    for (const key of Object.keys(t.env).sort()) {
      const url = t.env[key];
      if (!url || !(key.startsWith('DATABASE_URL_') || /^REDIS_\w*URL$/.test(key))) continue;
      const host = key.startsWith('DATABASE_URL_') ? dbHostOf(url) : hostOf(url);
      if (!host || !isLoopback(host)) {
        throw new DrillError(`--local refused: ${key} points at ${host ?? 'no host'}, not the local test stack`);
      }
    }
    return;
  }
  const listed = (t.env.CHAOS_STAGING_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedSsh = new Set(listed);
  const listedHosts = new Set(listed.map(hostOf).filter((h): h is string => h !== null));
  const check = (target: string, what: string) => {
    const host = hostOf(target);
    if (!host) throw new DrillError(`${what} ${target} names no host`);
    if (hosts.isProduction(host)) throw new DrillError(`${what} ${target} is a production host: refusing to touch it`);
    if (!isLoopback(host) && !hosts.isStaging(host) && !listedHosts.has(host)) {
      throw new DrillError(
        `${what} ${target} is not a staging host (nor in CHAOS_STAGING_HOSTS): refusing to touch it`,
      );
    }
  };
  for (const h of t.sshHosts ?? []) {
    if (!h) continue;
    if (!/^ssh:\/\//.test(h)) throw new DrillError(`staging hosts are ssh:// URLs (got ${h})`);
    if (!allowedSsh.has(h)) throw new DrillError(`${h} is not in CHAOS_STAGING_HOSTS: refusing to touch it`);
    check(h, 'host');
  }
  for (const u of t.urls ?? []) if (u) check(u, 'URL');
}
