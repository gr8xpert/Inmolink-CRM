import { BlockList, isIP } from 'node:net';

/**
 * Client IP from `X-Forwarded-For` for runtimes without a socket address (Next.js route handlers and
 * server actions). Same trust model as Fastify's `trustProxy` / `TRUST_PROXY` (S0-08):
 *
 * - hop count N — the N-th entry from the right (each trusted proxy appends the peer it saw);
 * - list of IPs / CIDRs / keywords — the right-most entry that is not a trusted proxy;
 * - `false` — no proxy is trusted. Development only: the right-most entry is used (Next fills the
 *   header from the socket when it is absent), which a client can forge. Production requires a value.
 *
 * Returns undefined when no usable address is found; callers then count against a shared bucket.
 */
export type TrustProxy = false | number | readonly string[];

const KEYWORDS: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

const lists = new WeakMap<readonly string[], BlockList>();

function trustedList(items: readonly string[]): BlockList {
  let list = lists.get(items);
  if (list) return list;
  list = new BlockList();
  for (const item of items) {
    const keyword = KEYWORDS[item];
    if (keyword) {
      for (const [net, prefix, type] of keyword) list.addSubnet(net, prefix, type);
      continue;
    }
    const [address = '', prefix] = item.split('/');
    const family = isIP(address);
    if (family === 0) throw new TypeError(`trust proxy: invalid entry ${JSON.stringify(item)}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  lists.set(items, list);
  return list;
}

function normalize(entry: string): string | undefined {
  let value = entry.trim();
  // `[v6]:port` and `v4:port` forms some proxies emit.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1]) value = mapped[1];
  return isIP(value) ? value : undefined;
}

export function clientIpFromForwarded(forwardedFor: string | null | undefined, trust: TrustProxy): string | undefined {
  if (!forwardedFor) return undefined;
  const entries = forwardedFor.split(',').map(normalize);
  if (entries.length === 0 || entries.length > 32) return undefined;
  if (trust === false) return entries.at(-1);
  if (typeof trust === 'number') {
    const index = Math.max(0, entries.length - trust);
    return entries[index];
  }
  const list = trustedList(trust);
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = entries[i];
    if (!ip) return undefined;
    if (!list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')) return ip;
  }
  return entries[0];
}
