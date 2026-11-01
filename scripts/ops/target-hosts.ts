// S17-F2 (S16 review): which hosts are production and which are staging, read from the deploy config itself — the
// Ansible inventories (`infra/ansible/inventories/<env>/hosts.yml`: every inventory name, `ansible_host` and `wg_ip`) and the Kamal
// overrides (`infra/kamal/*.<env>.yml`: server hosts, accessory hosts, proxy hostnames). Operator scripts that disrupt or
// load a target (`ops:drill --staging`, the load and storm scripts) refuse a production host with these.
//
// A production proxy hostname also makes its parent domain production (`api.inmolink.es` → `inmolink.es` and every
// name under it), except under a staging parent (`api.staging.inmolink.es` → `staging.inmolink.es`).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');

export type DeployEnv = 'production' | 'staging';

export interface EnvHosts {
  /** Addresses and hostnames of the environment's servers and accessories (lower case). */
  hosts: ReadonlySet<string>;
  /** Parent domains of its public hostnames (`inmolink.es`, `staging.inmolink.es`). */
  domains: ReadonlySet<string>;
}

const lc = (h: string): string =>
  h
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

function collect(node: unknown, keys: readonly string[], out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, keys, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k)) {
      for (const h of Array.isArray(v) ? v : [v]) {
        if (typeof h === 'string' && h.trim()) out.add(canonicalHost(h) ?? lc(h));
        // Kamal's tagged form: `hosts: [{ "1.2.3.4": [tag] }]`
        else if (h && typeof h === 'object' && !Array.isArray(h))
          for (const name of Object.keys(h)) out.add(canonicalHost(name) ?? lc(name));
      }
      // an Ansible `hosts:` mapping: its keys are the inventory names (`db-1`), also how ssh configs name the servers
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const name of Object.keys(v)) out.add(lc(name));
    }
    collect(v, keys, out);
  }
}

/** The deploy config's hosts of one environment (`root`: the repo, overridable for tests). */
export function envHosts(env: DeployEnv, root = ROOT): EnvHosts {
  const hosts = new Set<string>();
  const proxies = new Set<string>();
  collect(
    parse(readFileSync(join(root, 'infra', 'ansible', 'inventories', env, 'hosts.yml'), 'utf8')),
    ['ansible_host', 'wg_ip', 'hosts'],
    hosts,
  );
  const kamal = join(root, 'infra', 'kamal');
  for (const f of readdirSync(kamal).filter((n) => n.endsWith(`.${env}.yml`))) {
    const doc = parse(readFileSync(join(kamal, f), 'utf8')) as Record<string, unknown> | null;
    if (!doc) continue;
    collect(doc.servers, ['hosts', 'host'], hosts);
    collect(doc.accessories, ['host', 'hosts'], hosts);
    collect(doc.proxy, ['host', 'hosts'], proxies);
  }
  const domains = new Set<string>();
  for (const p of proxies) {
    for (const h of p.split(',').map(lc).filter(Boolean)) {
      hosts.add(h);
      const parent = h.split('.').slice(1).join('.');
      // a staging parent counts only with a `staging` label (`staging.inmolink.es`, never `inmolink.es` itself)
      if (parent.includes('.') && (env === 'production' || parent.split('.').includes('staging'))) domains.add(parent);
    }
  }
  return { hosts, domains };
}

const under = (h: string, domains: ReadonlySet<string>) => [...domains].some((d) => h === d || h.endsWith(`.${d}`));

/**
 * One spelling per address: IPv4 in any form a resolver accepts (`3405803786`, `0xcb00710a`) as dotted quads, an
 * IPv4-mapped IPv6 address as its IPv4 (`[::ffff:203.0.113.10]`), a trailing dot dropped — so a production address
 * cannot slip past the lists in another spelling. Names stay names (lower case).
 */
export function canonicalHost(host: string): string | null {
  const h = lc(host);
  if (!h) return null;
  try {
    // the WHATWG URL parser of a special scheme normalises IPv4 number forms and IPv6 text
    const name = lc(new URL(`http://${h.includes(':') ? `[${h}]` : h}/`).hostname);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(name);
    if (mapped) {
      const [hi, lo] = [Number.parseInt(mapped[1] as string, 16), Number.parseInt(mapped[2] as string, 16)];
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return name;
  } catch {
    return null;
  }
}

/** The host of a URL (`ssh://`, `https://`, `postgres://`, `redis://` …) or of a bare `host[:port]`; null if none. */
export function hostOf(target: string): string | null {
  const t = target.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `x://${t}`);
    return u.hostname ? canonicalHost(u.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * The host a Postgres URL connects to, or null when it cannot be told for sure: libpq / pg-connection-string let a
 * `?host=` or `?hostaddr=` parameter (or a socket path) override the URL's host, and a host list (`h1,h2`) connects
 * to either — all refused.
 */
export function dbHostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) return null;
    if (u.hostname.includes(',') || u.hostname.includes('%2f') || u.hostname.includes('%2F')) return null;
  } catch {
    return null;
  }
  return hostOf(url);
}

/** Loopback only: this machine (the local docker stacks publish their ports on it). */
export function isLoopback(host: string): boolean {
  const h = lc(host);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export interface HostClassifier {
  isProduction(host: string): boolean;
  isStaging(host: string): boolean;
}

/** Production and staging hosts per the deploy config (read once per call). */
export function hostClassifier(root = ROOT): HostClassifier {
  const prod = envHosts('production', root);
  const staging = envHosts('staging', root);
  const norm = (host: string) => canonicalHost(host) ?? lc(host);
  const isStaging = (host: string) => {
    const h = norm(host);
    return staging.hosts.has(h) || under(h, staging.domains);
  };
  return {
    isStaging,
    isProduction: (host) => {
      const h = norm(host);
      if (prod.hosts.has(h)) return true;
      return under(h, prod.domains) && !isStaging(h);
    },
  };
}
