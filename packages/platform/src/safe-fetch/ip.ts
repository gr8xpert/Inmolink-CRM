import { isIPv4, isIPv6 } from 'node:net';

/**
 * Which destinations an SSRF-safe fetch may connect to (PLAN §3 #64, security.md "Untrusted input"). Pure
 * functions, no DNS: `safeFetch` resolves names itself and passes every answer through `classifyIp`.
 *
 * Blocked: unspecified, loopback, RFC 1918 private, CGNAT (100.64/10, also Alibaba's metadata 100.100.100.200),
 * link-local (169.254/16 with the AWS/GCP/Azure/OCI metadata 169.254.169.254), IETF/benchmark/documentation/
 * reserved ranges, multicast and broadcast; IPv6 loopback, unique-local (fc00::/7, the AWS metadata
 * fd00:ec2::254), link-local, site-local, multicast, documentation, Teredo/ORCHID, and every IPv4-mapped or
 * IPv4-compatible IPv6 address (a classic filter bypass). NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an
 * IPv4 address: they are judged by it. Azure's wire server 168.63.129.16 is public but internal: blocked.
 */
export type IpVerdict = { allowed: true } | { allowed: false; reason: IpBlockReason };

export type IpBlockReason =
  | 'invalid'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link-local'
  | 'metadata'
  | 'reserved'
  | 'multicast'
  | 'unique-local'
  | 'ipv4-mapped';

/** [first address as a 32-bit number, prefix length, reason] — the most specific entries first. */
const V4_RANGES: ReadonlyArray<readonly [string, number, IpBlockReason]> = [
  ['169.254.169.254', 32, 'metadata'],
  ['168.63.129.16', 32, 'metadata'],
  ['100.100.100.200', 32, 'metadata'],
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'], // IETF protocol assignments (incl. OCI metadata 192.0.0.192)
  ['192.0.2.0', 24, 'reserved'], // TEST-NET-1
  ['192.88.99.0', 24, 'reserved'], // 6to4 relay anycast
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'], // benchmarking
  ['198.51.100.0', 24, 'reserved'], // TEST-NET-2
  ['203.0.113.0', 24, 'reserved'], // TEST-NET-3
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // incl. 255.255.255.255 broadcast
];

function v4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

const V4_TABLE = V4_RANGES.map(([base, bits, reason]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask, reason };
});

function classifyV4(address: string): IpVerdict {
  const n = v4ToInt(address);
  for (const r of V4_TABLE) if ((n & r.mask) >>> 0 === r.net) return { allowed: false, reason: r.reason };
  return { allowed: true };
}

/** Eight 16-bit groups of an IPv6 address (`::` expanded, a trailing dotted quad folded in); null if malformed. */
export function expandIpv6(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!isIPv6(text)) return null;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!isIPv4(last)) return null;
    const n = v4ToInt(last);
    text = `${text.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', rest] = text.split('::') as [string, string | undefined];
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((h) => Number.parseInt(h, 16)));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...new Array<number>(Math.max(fill, 0)).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

const embeddedV4 = (g: number[], hi: number, lo: number) =>
  `${(g[hi] as number) >> 8}.${(g[hi] as number) & 0xff}.${(g[lo] as number) >> 8}.${(g[lo] as number) & 0xff}`;

function classifyV6(address: string): IpVerdict {
  const g = expandIpv6(address);
  if (!g) return { allowed: false, reason: 'invalid' };
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(8)) return { allowed: false, reason: 'unspecified' };
  if (zeroTo(7) && g7 === 1) return { allowed: false, reason: 'loopback' };
  // ::ffff:a.b.c.d (mapped), ::ffff:0:a.b.c.d (translated) and ::a.b.c.d (deprecated compatible): never a feed host.
  if (zeroTo(5) && g5 === 0xffff) return { allowed: false, reason: 'ipv4-mapped' };
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return { allowed: false, reason: 'ipv4-mapped' };
  if (zeroTo(6)) return { allowed: false, reason: 'ipv4-mapped' };
  // NAT64 well-known prefix: the embedded IPv4 address decides.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return classifyV4(embeddedV4(g, 6, 7));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return { allowed: false, reason: 'reserved' }; // local-use NAT64
  if (g0 === 0x2002) return classifyV4(embeddedV4(g, 1, 2)); // 6to4
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return { allowed: false, reason: 'reserved' }; // discard-only
  if (g0 === 0x2001 && g1 === 0) return { allowed: false, reason: 'reserved' }; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return { allowed: false, reason: 'reserved' }; // documentation
  if (g0 === 0x2001 && (g1 & 0xffe0) === 0x0) return { allowed: false, reason: 'reserved' }; // IETF special
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return { allowed: false, reason: 'reserved' }; // ORCHID
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x20) return { allowed: false, reason: 'reserved' }; // ORCHIDv2
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return { allowed: false, reason: 'reserved' }; // documentation (2024)
  if (g0 === 0xfd00 && g1 === 0xec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254) {
    return { allowed: false, reason: 'metadata' };
  }
  if ((g0 & 0xfe00) === 0xfc00) return { allowed: false, reason: 'unique-local' };
  if ((g0 & 0xffc0) === 0xfe80) return { allowed: false, reason: 'link-local' };
  if ((g0 & 0xffc0) === 0xfec0) return { allowed: false, reason: 'private' }; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return { allowed: false, reason: 'multicast' };
  // Only global unicast (2000::/3) is routable on the internet.
  if ((g0 & 0xe000) !== 0x2000) return { allowed: false, reason: 'reserved' };
  return { allowed: true };
}

/** Whether a connection to `address` (an IP literal, either family) is allowed. */
export function classifyIp(address: string): IpVerdict {
  if (isIPv4(address)) return classifyV4(address);
  if (address.includes(':')) return classifyV6(address);
  return { allowed: false, reason: 'invalid' };
}

/** Host names that never name a public server, whatever DNS answers (checked before resolving). */
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

/** A lower-case host name without a trailing dot is refused if it is reserved for local or internal use. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === '' || BLOCKED_NAMES.has(host)) return true;
  if (!host.includes('.')) return true; // single-label names resolve through search domains to internal hosts
  return BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}
