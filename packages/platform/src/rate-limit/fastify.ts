import { isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { assertRule, type RateLimiter, type RateLimitResult, type RateLimitRule, type RateScope } from './limiter';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Rules for this route; replaces the plugin defaults. `false` turns limits off (health checks only). */
    rateLimit?: readonly RateLimitRule[] | false;
  }
}

/** Returns the identity a scope counts against, or undefined when the request has none. */
export type ScopeIdentity = (request: FastifyRequest) => string | undefined;

export interface RateLimitPluginOptions {
  limiter: RateLimiter;
  /** Rules for routes that do not set `config.rateLimit`. */
  defaults: readonly RateLimitRule[];
  /**
   * Identity per scope. `ip` is required: pass `(r) => ipBucket(r.ip)` with Fastify `trustProxy` set to
   * the edge's hop count or CIDR list — never `true`, or a forged `X-Forwarded-For` gets a fresh bucket
   * per request. `user`, `key` and `tenant` come from the auth plugins, which must identify the caller
   * in `onRequest` or `preValidation` (this plugin's identity rules run in `preHandler`).
   */
  identify: { ip: ScopeIdentity } & Partial<Record<Exclude<RateScope, 'ip'>, ScopeIdentity>>;
}

const RATE_LIMITED_MESSAGE = 'Too many requests';

/**
 * The 429 answer: `Retry-After` and the standard error body. Also for limits a plugin checks itself
 * (the per-key rate tier of `requireApiKey`, S1-05).
 */
export function replyRateLimited(reply: FastifyReply, scope: RateScope, retryAfterSeconds: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterSeconds))
    .send({ error: { code: 'RATE_LIMITED', message: RATE_LIMITED_MESSAGE, details: { scope, retryAfterSeconds } } });
}

/**
 * The 429 answer for a used-up quota (S7-04): `Retry-After` and `QUOTA_EXCEEDED` with the quota's size and its reset
 * time (`resetAt`, ISO; a daily quota resets at UTC midnight), so a client knows when to come back.
 */
export function replyQuotaExceeded(
  reply: FastifyReply,
  quota: { scope: RateScope; period: 'daily'; limit: number; resetAtMs: number; retryAfterSeconds: number },
): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(quota.retryAfterSeconds))
    .send({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'Quota exceeded',
        details: {
          scope: quota.scope,
          quota: quota.period,
          limit: quota.limit,
          resetAt: new Date(quota.resetAtMs).toISOString(),
          retryAfterSeconds: quota.retryAfterSeconds,
        },
      },
    });
}

/**
 * Bucket for an IP: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 by /64 — one host usually owns a
 * whole /64, so per-address limits would be trivial to rotate around.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${full
    .slice(0, 4)
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * Rate limits per IP, user, API key and tenant (PLAN §5.3 #11). IP rules run in `onRequest`, before
 * the body is parsed; the others in `preHandler`, after authentication has identified the caller.
 * A rule whose scope has no identity on this request (anonymous caller on a user-limited route) is
 * covered by the route's IP rules; on a route without any, it counts against the client IP instead. A denied request gets 429, `Retry-After`
 * and the standard error body.
 *
 * Registered without encapsulation (like fastify-plugin), so the hooks apply to every route.
 */
export function rateLimitPlugin(
  fastify: FastifyInstance,
  options: RateLimitPluginOptions,
  done: (err?: Error) => void,
) {
  const identify = options.identify;
  if (typeof identify?.ip !== 'function') {
    return done(new TypeError('rate limit: identify.ip is required (see ipBucket and trustProxy)'));
  }
  const validate = (rules: readonly RateLimitRule[], where: string) => {
    if (rules.length === 0) throw new TypeError(`rate limit: ${where} has no rules (use rateLimit: false to opt out)`);
    for (const rule of rules) {
      assertRule(rule);
      if (typeof identify[rule.scope] !== 'function') {
        throw new TypeError(`rate limit: ${where} uses scope "${rule.scope}" but identify.${rule.scope} is not set`);
      }
    }
  };
  try {
    validate(options.defaults, 'defaults');
  } catch (err) {
    return done(err as Error);
  }

  // Route rules are checked when the route is registered, not on its first request.
  fastify.addHook('onRoute', (route) => {
    const rules = route.config?.rateLimit;
    if (rules !== undefined && rules !== false) validate(rules, `route ${route.method} ${route.url}`);
  });

  const rulesFor = (request: FastifyRequest): readonly RateLimitRule[] => {
    const configured = request.routeOptions.config?.rateLimit;
    if (configured === false) return [];
    return configured ?? options.defaults;
  };

  const check = async (request: FastifyRequest, reply: FastifyReply, phase: 'ip' | 'identity') => {
    const all = rulesFor(request);
    const rules = all.filter((r) => (phase === 'ip' ? r.scope === 'ip' : r.scope !== 'ip'));
    if (rules.length === 0) return;
    const ipLimited = all.some((r) => r.scope === 'ip');
    const checks: Promise<{ rule: RateLimitRule; result: RateLimitResult }>[] = [];
    for (const rule of rules) {
      let identity = identify[rule.scope]?.(request);
      if (!identity && rule.scope !== 'ip') {
        // The route's IP rule already covers anonymous callers; otherwise count them by IP here.
        if (ipLimited) continue;
        request.log.debug({ rule: rule.name, scope: rule.scope }, 'rate limit: no identity, using client IP');
        identity = `ip:${identify.ip(request) ?? ''}`;
      }
      if (!identity) continue;
      checks.push(options.limiter.consume(rule, identity).then((result) => ({ rule, result })));
    }
    const denied = (await Promise.all(checks)).filter((c) => !c.result.allowed);
    if (denied.length === 0) return;
    const worst = denied.reduce((a, b) => (b.result.retryAfterSeconds > a.result.retryAfterSeconds ? b : a));
    request.log.info({ rule: worst.rule.name, scope: worst.rule.scope }, 'rate limited');
    return replyRateLimited(reply, worst.rule.scope, worst.result.retryAfterSeconds);
  };

  fastify.addHook('onRequest', (request, reply) => check(request, reply, 'ip'));
  fastify.addHook('preHandler', (request, reply) => check(request, reply, 'identity'));
  done();
}

// Same effect as wrapping with fastify-plugin, without the dependency.
Object.assign(rateLimitPlugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'inmolink-rate-limit',
});
