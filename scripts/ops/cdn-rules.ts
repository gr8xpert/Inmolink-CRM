// pnpm ops:cdn-rules --env <staging|production> [--apply | --verify]
//
// Website API edge cache rules as code (S7-06, runbook docs/runbooks/cdn.md). Renders infra/cloudflare/cache-rules.json
// for a destination (the feed-api host from infra/kamal/feed-api.<env>.yml) and, with --apply, writes it to the zone's
// `http_request_cache_settings` entrypoint ruleset: rules whose ref starts with `inmolink_` are replaced, every other
// rule of the zone is kept in its order and ours go last (later rules win); the ruleset is read back and checked (vary
// block, order). --verify probes the live host: key A twice (HIT), key B on the same URL, key A from another origin and
// without the `_k` token (never a HIT). Without --apply / --verify it prints the ruleset it would write (dry run).
//
// --verify env: CDN_VERIFY_KEY_A, CDN_VERIFY_KEY_B — secret keys of two different sites of that environment.
//
// Env: CLOUDFLARE_ZONE_ID and CLOUDFLARE_RULES_TOKEN (a token with "Zone > Cache Rules: Edit" on that zone only — not
// the worker's purge token). Never printed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const API = 'https://api.cloudflare.com/client/v4';
const PHASE = 'http_request_cache_settings';
/** Rules this repository owns on the zone. */
export const OWN_REF = /^inmolink_/;

export interface CacheRule {
  ref?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  enabled?: boolean;
  [key: string]: unknown;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The feed-api host of a Kamal destination (`proxy.host`). */
export function feedApiHost(env: string): string {
  const doc = parse(readFileSync(join(ROOT, 'infra', 'kamal', `feed-api.${env}.yml`), 'utf8')) as {
    proxy?: { host?: string };
  };
  const host = doc.proxy?.host;
  if (!host || !HOST.test(host)) throw new TypeError(`feed-api.${env}.yml has no valid proxy.host`);
  return host;
}

/** The repository's cache rules for one feed-api host. */
export function renderCacheRules(host: string): CacheRule[] {
  if (!HOST.test(host)) throw new TypeError(`not a hostname: ${host}`);
  const file = JSON.parse(readFileSync(join(ROOT, 'infra', 'cloudflare', 'cache-rules.json'), 'utf8')) as {
    phase: string;
    rules: CacheRule[];
  };
  if (file.phase !== PHASE) throw new TypeError(`cache-rules.json: phase must be ${PHASE}`);
  return file.rules.map((rule) => {
    if (!rule.ref || !OWN_REF.test(rule.ref))
      throw new TypeError(`cache-rules.json: every rule needs an inmolink_ ref`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder in cache-rules.json, not a template
    return { ...rule, expression: rule.expression.replaceAll('${FEED_API_HOST}', host) };
  });
}

/**
 * The zone's rules with ours in: every other rule stays in its order (Cloudflare's read-only fields removed), rules of
 * ours no longer in the file are dropped, and ours go **last** — later Cache Rules override earlier ones, so no other
 * rule can widen what ours set for `/v2/`.
 */
export function mergeRules(existing: readonly CacheRule[], ours: readonly CacheRule[]): CacheRule[] {
  const others = existing
    .filter((rule) => !(rule.ref && OWN_REF.test(rule.ref)))
    .map(({ id: _id, version: _v, last_updated: _u, ...kept }) => kept as CacheRule);
  return [...others, ...ours];
}

/**
 * Other rules that may also match the website API: no host test, or the feed-api host, or `/v2`. Listed as warnings
 * (ours run last and win, but a cache-everything rule elsewhere deserves a look).
 */
export function overlappingRules(rules: readonly CacheRule[], host: string): string[] {
  return rules
    .filter((r) => !(r.ref && OWN_REF.test(r.ref)) && r.enabled !== false)
    .filter((r) => !/http\.host/.test(r.expression) || r.expression.includes(host) || r.expression.includes('/v2'))
    .map((r) => `${r.ref ?? r.description ?? '(unnamed)'}: ${r.expression}`);
}

/**
 * Problems of the zone's ruleset as read back after applying: our rules present, unchanged and last, with the vary
 * block that keeps answers per key (default bypass, the key headers passed through).
 */
export function checkApplied(applied: readonly CacheRule[], ours: readonly CacheRule[]): string[] {
  const problems: string[] = [];
  const tail = applied.slice(applied.length - ours.length);
  ours.forEach((rule, i) => {
    const got = tail[i];
    if (!got || got.ref !== rule.ref) {
      problems.push(`${rule.ref}: not among the last rules of the zone`);
      return;
    }
    const vary = (
      got.action_parameters as {
        vary?: { default?: { action?: string }; headers?: Record<string, { action?: string }> };
      }
    )?.vary;
    if (vary?.default?.action !== 'bypass') problems.push(`${rule.ref}: vary.default is not bypass`);
    for (const h of ['x-api-key', 'authorization']) {
      if (vary?.headers?.[h]?.action !== 'passthrough') problems.push(`${rule.ref}: vary ${h} is not passthrough`);
    }
    if (got.expression !== rule.expression) problems.push(`${rule.ref}: expression differs`);
  });
  return problems;
}

/** One probe of `--verify`: the edge's `cf-cache-status` for a request. */
export interface Probe {
  name: 'a-first' | 'a-again' | 'b-same-url' | 'a-other-origin' | 'a-no-token';
  status: number;
  cacheStatus: string | null;
}

/**
 * `--verify` verdict: key A's second request is a HIT; key B on A's URL, key A from another origin (its own token)
 * and a request without the token are never HITs. Problems, or none.
 */
export function judgeVerify(probes: readonly Probe[]): string[] {
  const by = new Map(probes.map((p) => [p.name, p]));
  const problems: string[] = [];
  for (const p of probes)
    if (p.name !== 'a-other-origin' && p.status !== 200) problems.push(`${p.name}: HTTP ${p.status}`);
  if (by.get('a-again')?.cacheStatus !== 'HIT')
    problems.push('a-again: not a HIT (is the rule live, the edge cache on?)');
  for (const name of ['b-same-url', 'a-other-origin', 'a-no-token'] as const) {
    if (by.get(name)?.cacheStatus === 'HIT') problems.push(`${name}: a HIT — a cached answer crossed keys or origins`);
  }
  return problems;
}

async function cloudflare<T>(path: string, token: string, init: RequestInit = {}): Promise<T | null> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as { success?: boolean; errors?: unknown; result?: T };
  if (!res.ok || body.success !== true) {
    throw new Error(`cloudflare ${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body.errors ?? [])}`);
  }
  return body.result ?? null;
}

const tokenOf = (key: string, origin = '') =>
  createHash('sha256').update(`${key}\n${origin}`).digest('base64url').slice(0, 22);

/** Live probes against the environment's feed-api host (keys of two different sites; never printed). */
async function verify(host: string, keyA: string, keyB: string): Promise<Probe[]> {
  // A URL no one else asks for: a fresh entry.
  const path = `/v2/listings?limit=1&sort=newest&q=cdn-verify-${Date.now().toString(36)}`;
  const probe = async (name: Probe['name'], key: string, token: string | null, origin?: string): Promise<Probe> => {
    const res = await fetch(`https://${host}${path}${token ? `&_k=${token}` : ''}`, {
      headers: { 'x-api-key': key, ...(origin ? { origin } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    await res.arrayBuffer();
    return { name, status: res.status, cacheStatus: res.headers.get('cf-cache-status') };
  };
  const other = 'https://cdn-verify.invalid';
  return [
    await probe('a-first', keyA, tokenOf(keyA)),
    await probe('a-again', keyA, tokenOf(keyA)),
    await probe('b-same-url', keyB, tokenOf(keyA)),
    await probe('a-other-origin', keyA, tokenOf(keyA, other), other),
    await probe('a-no-token', keyA, null),
  ];
}

async function main() {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      apply: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
    },
  });
  if (values.env !== 'staging' && values.env !== 'production') throw new TypeError('--env staging|production');
  const host = feedApiHost(values.env);
  const ours = renderCacheRules(host);
  if (values.verify) {
    const keyA = process.env.CDN_VERIFY_KEY_A ?? '';
    const keyB = process.env.CDN_VERIFY_KEY_B ?? '';
    if (!keyA || !keyB) throw new TypeError('set CDN_VERIFY_KEY_A and CDN_VERIFY_KEY_B (secret keys of two sites)');
    const probes = await verify(host, keyA, keyB);
    for (const p of probes) console.log(`${p.name}: HTTP ${p.status}, cf-cache-status ${p.cacheStatus ?? '-'}`);
    const problems = judgeVerify(probes);
    if (problems.length > 0) throw new Error(`verify failed on ${values.env}:\n- ${problems.join('\n- ')}`);
    console.log(`verify passed on ${values.env}: cached answers stay with their key and origin`);
    return;
  }
  if (!values.apply) {
    console.log(JSON.stringify({ phase: PHASE, rules: ours }, null, 2));
    console.log('\nDry run. --apply writes these rules to the zone (other rules are kept, ours go last).');
    return;
  }
  const zone = process.env.CLOUDFLARE_ZONE_ID ?? '';
  const token = process.env.CLOUDFLARE_RULES_TOKEN ?? '';
  if (!/^[a-f0-9]{32}$/.test(zone) || !token) throw new TypeError('set CLOUDFLARE_ZONE_ID and CLOUDFLARE_RULES_TOKEN');
  const path = `/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`;
  const current = await cloudflare<{ rules?: CacheRule[] }>(path, token);
  const rules = mergeRules(current?.rules ?? [], ours);
  for (const w of overlappingRules(rules, host)) console.warn(`warning: another cache rule may match the API: ${w}`);
  await cloudflare(path, token, { method: 'PUT', body: JSON.stringify({ rules }) });
  const applied = (await cloudflare<{ rules?: CacheRule[] }>(path, token))?.rules ?? [];
  const problems = checkApplied(applied, ours);
  if (problems.length > 0) throw new Error(`the zone does not hold our rules as written:\n- ${problems.join('\n- ')}`);
  console.log(
    `applied ${ours.length} rule(s) to ${values.env} (last); ${rules.length - ours.length} other rule(s) kept`,
  );
  console.log(`next: CDN_VERIFY_KEY_A=… CDN_VERIFY_KEY_B=… pnpm ops:cdn-rules --env ${values.env} --verify`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
