import type {
  ApiKeyDto,
  ApiKeyPage,
  ApiKeyParams,
  ApiKeyRateTier,
  ApiKeyScope,
  CreateApiKeyInput,
  IssuedApiKeyDto,
  PageQuery,
} from '@inmolink/contracts';
import { withPublicRead } from '@inmolink/db';
import { type CacheKey, cache, cacheKey, seen } from '@inmolink/platform/cache';
import { clock } from '@inmolink/platform/clock';
import { base32Encode, hmacSha256, safeEqual } from '@inmolink/platform/crypto';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
import type { Ctx } from '../../context';
import { impersonatorOf } from '../../impersonation';
import { decodeCursor, toPage } from '../../pagination';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as websites from '../websites';
import * as keysRepo from './api-keys-repo';
import { API_KEYS, type ApiKeyEnv, identityConfig } from './config';
import { identityEvents } from './events';
import { assertCan } from './policy';

/**
 * Website API keys (S1-05, PLAN §3 #30 §9.1, `.claude/rules/security.md`).
 *
 * Format `inl_<env>_<prefix>_<secret>`: `prefix` is `sk`/`pk` + 10 base32 characters (the lookup id,
 * shown in the dashboard), `secret` 52 base32 characters (256 random bits). Only the prefix and
 * `hmacSha256(HMAC_KEY, 'api-key', whole key)` are stored — an HMAC, not Argon2id, because every
 * website request checks a key (1,000 rps at origin) and a 256-bit secret cannot be guessed offline.
 * The whole key is returned once, by create and rotate.
 */

const ALPHABET = 'a-z2-7';
const KEY_RE = new RegExp(`^inl_(live|test)_([ps]k[${ALPHABET}]{10})_([${ALPHABET}]{52})$`);
const PREFIX_RE = new RegExp(`^[ps]k[${ALPHABET}]{10}$`);
const HMAC_PURPOSE = 'api-key';
/** Redis "last used" set drained by `identity.flushApiKeyUsage`. */
export const API_KEY_USAGE_SET = 'identity.apikeys';

const randomBase32 = (bytes: number) => base32Encode(crypto.getRandomValues(new Uint8Array(bytes))).toLowerCase();

function apiKeyEnv(): ApiKeyEnv {
  return identityConfig().apiKeyEnv ?? 'test';
}

function hashApiKey(key: string): string {
  return hmacSha256(identityConfig().hmacKey, HMAC_PURPOSE, key);
}

/** A fresh key: the string shown once, its prefix and the hash that is stored. */
function generateApiKey(kind: keysRepo.ApiKeyKind): { key: string; prefix: string; keyHash: string } {
  const prefix = `${kind === 'SECRET' ? 'sk' : 'pk'}${randomBase32(7).slice(0, 10)}`;
  const key = `inl_${apiKeyEnv()}_${prefix}_${randomBase32(32)}`;
  return { key, prefix, keyHash: hashApiKey(key) };
}

/**
 * Cache key of one prefix's lookup. No tags: a tag would create a Redis key per looked-up prefix, and
 * random prefixes must not be able to fill redis-cache (S1-05 review). Revoke, rotate and agency status
 * changes `cache.delete` it; other processes' in-process copies expire on their own (15 s).
 */
export function apiKeyCacheKey(prefix: string): CacheKey {
  return cacheKey({ v: 1, module: 'identity', entity: 'api-key', scope: 'global', id: prefix });
}

function toApiKeyDto(row: keysRepo.ApiKeyRow): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    prefix: row.prefix,
    scopes: row.scopes as ApiKeyScope[],
    allowedOrigins: row.allowedOrigins,
    rateTier: row.rateTier,
    siteId: row.siteId,
    status: row.revokedAt ? 'REVOKED' : 'ACTIVE',
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

// ── Dashboard: agency admins ──────────────────────────────────────────────────────────────────────

/**
 * The agency's keys, oldest first (admins only): every active key (at most `MAX_ACTIVE`) and keys
 * revoked in the last 30 days. Never the secret or its hash.
 */
export async function listApiKeys(ctx: Ctx, q: PageQuery): Promise<ApiKeyPage> {
  assertCan(ctx, 'identity.apiKeys.read');
  const revokedSince = new Date(clock.now().getTime() - API_KEYS.REVOKED_LISTED_MS);
  const rows = await keysRepo.listApiKeys(ctx.tx, ctx.tenant.agencyId, revokedSince, {
    limit: q.limit,
    cursor: decodeCursor(q.cursor),
  });
  return toPage(rows, q.limit, (r) => ({ at: r.createdAt, id: r.id }), toApiKeyDto);
}

/**
 * The acting admin, and the staff member impersonating them (never set today: key changes are forbidden
 * while impersonating, S1-09 — kept so events and audit rows stay uniform).
 */
function actorOf(ctx: Ctx): { actorUserId: string; impersonatedBy: string | null } {
  if (ctx.actor.kind !== 'user') throw new AppError('FORBIDDEN');
  return { actorUserId: ctx.actor.userId, impersonatedBy: impersonatorOf(ctx) };
}

/**
 * The agency's status read under a row lock, not the `ctx` snapshot from the start of the request: a
 * suspension that commits meanwhile either waits for this transaction (and the sync job then turns the
 * key off) or is seen here (and the key is refused). `update` also serialises key creation per agency,
 * so the active-key cap cannot be raced.
 */
async function assertAgencyVerifiedLocked(ctx: Ctx, mode: 'share' | 'update'): Promise<void> {
  const status = await agencies.lockAgencyStatus(ctx.tx, ctx.tenant.agencyId, mode);
  if (status !== 'VERIFIED') throw new AppError('VERIFICATION_REQUIRED', { action: 'apiKey.create' });
}

/**
 * Creates a key (admins of a verified agency; at most `API_KEYS.MAX_ACTIVE` active keys). Returns the
 * whole key this once. Agency keys are `STANDARD`; staff set `HIGH` (plans may sell it, S13). The key is
 * bound to a website site (S7-01): `input.siteId`, else the agency's first site (created when it has none).
 */
export async function createApiKey(ctx: Ctx, input: CreateApiKeyInput): Promise<IssuedApiKeyDto> {
  assertCan(ctx, 'identity.apiKeys.manage');
  const actor = actorOf(ctx);
  agencies.assertVerified(ctx, 'apiKey.create');
  await assertAgencyVerifiedLocked(ctx, 'update');
  const { agencyId } = ctx.tenant;
  if ((await keysRepo.countActiveApiKeys(ctx.tx, agencyId)) >= API_KEYS.MAX_ACTIVE) {
    throw new AppError('API_KEY_LIMIT_REACHED', { limit: API_KEYS.MAX_ACTIVE });
  }
  const siteId = await websites.siteForNewKey(ctx, { siteId: input.siteId, keyKind: input.kind });
  const { key, prefix, keyHash } = generateApiKey(input.kind);
  const row = await keysRepo.insertApiKey(ctx.tx, {
    id: newId(),
    agencyId,
    name: input.name,
    kind: input.kind,
    prefix,
    keyHash,
    scopes: input.scopes,
    // Secret keys are for servers; the contract already refuses origins for them.
    allowedOrigins: input.kind === 'PUBLISHABLE' ? input.allowedOrigins : [],
    rateTier: 'STANDARD',
    siteId,
    // Checked under the lock above (the guard trigger derives it from `agencies` as well).
    agencyActive: true,
    createdBy: actor.actorUserId,
    createdAt: clock.now(),
  });
  await emit(ctx.tx, identityEvents.apiKeyCreated({ agencyId, keyId: row.id, ...actor }));
  await compliance.audit(
    ctx,
    'identity.apiKey.created',
    { type: 'apiKey', id: row.id },
    { kind: row.kind, prefix, scopes: row.scopes, siteId },
  );
  return { key: toApiKeyDto(row), secret: key };
}

/**
 * Replaces an active key's secret (and prefix): the old key stops working — once the outbox delivers
 * the rotation (it drops the shared cache entry), and within 60 s even without it (cache TTLs). Same
 * id, scopes and origins.
 */
export async function rotateApiKey(ctx: Ctx, input: ApiKeyParams): Promise<IssuedApiKeyDto> {
  assertCan(ctx, 'identity.apiKeys.manage');
  const actor = actorOf(ctx);
  agencies.assertVerified(ctx, 'apiKey.create');
  await assertAgencyVerifiedLocked(ctx, 'share');
  const { agencyId } = ctx.tenant;
  const current = await keysRepo.lockActiveApiKey(ctx.tx, agencyId, input.keyId);
  if (!current) throw new AppError('NOT_FOUND');
  const { key, prefix, keyHash } = generateApiKey(current.kind);
  const row = await keysRepo.rotateApiKey(ctx.tx, agencyId, input.keyId, { prefix, keyHash }, clock.now());
  if (!row) throw new AppError('NOT_FOUND');
  await emit(
    ctx.tx,
    identityEvents.apiKeyRotated({ agencyId, keyId: row.id, retiredPrefix: current.prefix, ...actor }),
  );
  await compliance.audit(
    ctx,
    'identity.apiKey.rotated',
    { type: 'apiKey', id: row.id },
    { prefix, retiredPrefix: current.prefix },
  );
  return { key: toApiKeyDto(row), secret: key };
}

/** Revokes a key for good (allowed while unverified, suspended or impersonating). `NOT_FOUND` if not active. */
export async function revokeApiKey(ctx: Ctx, input: ApiKeyParams): Promise<void> {
  assertCan(ctx, 'identity.apiKeys.manage');
  const actor = actorOf(ctx);
  const { agencyId } = ctx.tenant;
  const revoked = await keysRepo.revokeApiKey(ctx.tx, agencyId, input.keyId, actor.actorUserId, clock.now());
  if (!revoked) throw new AppError('NOT_FOUND');
  await emit(
    ctx.tx,
    identityEvents.apiKeyRevoked({ agencyId, keyId: input.keyId, retiredPrefix: revoked.prefix, ...actor }),
  );
  await compliance.audit(
    ctx,
    'identity.apiKey.revoked',
    { type: 'apiKey', id: input.keyId },
    { prefix: revoked.prefix },
  );
}

/**
 * Sets the rate tier of some of the agency's active keys (S7-08). Not an agency action — no member can choose a tier:
 * only a system context (an ops script under `withSystem`, its reason in the actor) may, e.g. for the HIGH-tier keys of
 * the website load test. One audit row per key; the event drops each key's cached lookup once committed.
 */
export async function setApiKeyRateTier(
  ctx: Ctx,
  input: { keyIds: readonly string[]; tier: ApiKeyRateTier; reason: string },
): Promise<number> {
  if (ctx.actor.kind !== 'system') throw new AppError('FORBIDDEN');
  // The reason is a code (audit metadata holds no free text), e.g. `perf.load-test`.
  if (!/^[a-z0-9][a-z0-9.:-]{0,63}$/.test(input.reason)) throw new TypeError('reason must be a short code');
  const { agencyId } = ctx.tenant;
  const changed = await keysRepo.setApiKeyRateTier(ctx.tx, agencyId, input.keyIds, input.tier, clock.now());
  for (const key of changed) {
    await emit(
      ctx.tx,
      identityEvents.apiKeyTierChanged({ agencyId, keyId: key.id, prefix: key.prefix, tier: input.tier }),
    );
    await compliance.audit(
      ctx,
      'identity.apiKey.tierChanged',
      { type: 'apiKey', id: key.id },
      { prefix: key.prefix, tier: input.tier, reason: input.reason },
    );
  }
  return changed.length;
}

/**
 * S8-02 (system only: the legacy key import, `pnpm legacy:key-flag`): marks the agency's active key with this prefix as
 * a migrated legacy key — the only kind the v1 shim accepts as its legacy `api_key` query parameter — or clears it.
 * Audited; the cached lookup is dropped (other processes' copies expire in 15 s). False: no such active key.
 */
export async function setLegacyQueryKey(
  ctx: Ctx,
  input: { prefix: string; enabled: boolean; reason: string },
): Promise<boolean> {
  if (ctx.actor.kind !== 'system') throw new AppError('FORBIDDEN');
  if (!/^[a-z0-9][a-z0-9.:-]{0,63}$/.test(input.reason)) throw new TypeError('reason must be a short code');
  if (!PREFIX_RE.test(input.prefix)) throw new TypeError('not a key prefix');
  const changed = await keysRepo.setLegacyQueryKey(
    ctx.tx,
    ctx.tenant.agencyId,
    input.prefix,
    input.enabled,
    clock.now(),
  );
  if (!changed) return false;
  await compliance.audit(
    ctx,
    'identity.apiKey.legacyQueryKeyChanged',
    { type: 'apiKey', id: changed.id },
    { prefix: input.prefix, enabled: input.enabled, reason: input.reason },
  );
  await cache.delete(apiKeyCacheKey(input.prefix));
  return true;
}

// ── Website API: authenticate a request ───────────────────────────────────────────────────────────

/** Who is calling the website API, once the key checked out. */
export interface ApiKeyPrincipal {
  keyId: string;
  agencyId: string;
  kind: keysRepo.ApiKeyKind;
  scopes: ApiKeyScope[];
  rateTier: ApiKeyRateTier;
  /** The website the key serves (`websites.siteScope`); null for keys created before sites existed (S7-01). */
  siteId: string | null;
  /** S8-02: a migrated legacy key — the only kind the v1 shim accepts as its `api_key` query parameter. */
  legacyQueryKey: boolean;
}

export interface ApiKeyRequest {
  /** The key as sent (`X-Api-Key` or `Authorization: Bearer`); undefined when none was sent. */
  key: string | undefined;
  /** The request's `Origin` header. Required for publishable keys. */
  origin: string | undefined;
  /** What the endpoint needs. */
  scope: ApiKeyScope;
  /**
   * Runs before a database lookup (the key is in no cache), and may throw to refuse it (S7-F9: `requireApiKey` refuses
   * an IP whose failed checks are in the penalty box, so guessed keys cost no query).
   */
  beforeLookup?: () => Promise<void>;
}

/**
 * Authenticates a website API request (S1-05). No `ctx`: it runs before the tenant is known, under
 * `app_public` (CLAUDE.md rule 4 exception, like `getMe`). A found key is cached for
 * `API_KEYS.CACHE_TTL_SECONDS` in Redis and `CACHE_LOCAL_TTL_SECONDS` in-process, so a hot key costs no
 * query; unknown prefixes are never cached (they would let anyone fill the cache — `requireApiKey`
 * rate-limits failed checks per IP instead). The hash is compared in constant time on every request.
 * Throws `API_KEY_INVALID` (401) for anything that is not a usable key — one answer, so keys cannot be
 * probed — then checks the origin (publishable keys need an allowed one; secret keys refuse any, since
 * a browser must never hold them) and the scope.
 */
export async function authenticateApiKey(req: ApiKeyRequest): Promise<ApiKeyPrincipal> {
  const match = req.key ? KEY_RE.exec(req.key) : null;
  if (!match || match[1] !== apiKeyEnv()) throw new AppError('API_KEY_INVALID');
  const prefix = match[2] as string;
  const row = await cache.get(
    apiKeyCacheKey(prefix),
    { ttlSeconds: API_KEYS.CACHE_TTL_SECONDS, localTtlSeconds: API_KEYS.CACHE_LOCAL_TTL_SECONDS, local: true },
    // `undefined` is never cached: misses always go to the database.
    async () => {
      await req.beforeLookup?.();
      return (await withPublicRead((tx) => keysRepo.findUsableApiKeyByPrefix(tx, prefix))) ?? undefined;
    },
  );
  if (!row || !safeEqual(hashApiKey(req.key as string), row.keyHash)) throw new AppError('API_KEY_INVALID');
  const origin = req.origin?.trim().toLowerCase();
  if (row.kind === 'PUBLISHABLE' ? !origin || !row.allowedOrigins.includes(origin) : origin) {
    throw new AppError('API_KEY_ORIGIN_DENIED');
  }
  if (!row.scopes.includes(req.scope)) throw new AppError('API_KEY_SCOPE_DENIED', { scope: req.scope });
  markApiKeyUsed(row.id);
  return {
    keyId: row.id,
    agencyId: row.agencyId,
    kind: row.kind,
    scopes: row.scopes as ApiKeyScope[],
    rateTier: row.rateTier,
    // A lookup cached before S7-01 has no site: it reads as none until the entry expires.
    siteId: row.siteId ?? null,
    // A lookup cached before S8-02 has no flag: not a legacy key until the entry expires.
    legacyQueryKey: row.legacyQueryKey === true,
  };
}

/** The per-key rate limit for a key's tier (PLAN §9.2), for the website API's limiter. */
export function apiKeyRateRule(tier: ApiKeyRateTier): RateLimitRule {
  const { limit, windowSeconds } = API_KEYS.RATE_TIERS[tier];
  return { name: `feed.key.${tier.toLowerCase()}`, scope: 'key', limit, windowSeconds };
}

/** All of an agency's keys together (`tenant` scope): more keys do not raise the agency's ceiling. */
export const API_KEY_AGENCY_RULE: RateLimitRule = { name: 'feed.agency', scope: 'tenant', ...API_KEYS.AGENCY_RATE };

/**
 * Failed key checks per client IP (`requireApiKey` counts only failures). Fails open like other
 * website limits: Redis down must not take every website offline.
 */
export const API_KEY_FAILURE_RULE: RateLimitRule = {
  name: 'feed.keyfail.ip',
  scope: 'ip',
  ...API_KEYS.FAILED_CHECKS_PER_IP,
};

/** Whether `prefix` has the shape of a key prefix (cache invalidation input). */
export function isApiKeyPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix);
}

const lastMarked = new Map<string, number>();
const MAX_TRACKED = 10_000;

/**
 * `last_used_at` without a write per request: each process marks a key in Redis at most once per
 * `USAGE_MARK_INTERVAL_MS` (fire and forget); `identity.flushApiKeyUsage` writes the marks in batches.
 */
function markApiKeyUsed(keyId: string): void {
  const now = clock.now();
  const last = lastMarked.get(keyId);
  if (last !== undefined && now.getTime() - last < API_KEYS.USAGE_MARK_INTERVAL_MS) return;
  if (lastMarked.size >= MAX_TRACKED) lastMarked.clear();
  lastMarked.set(keyId, now.getTime());
  void seen.mark(API_KEY_USAGE_SET, keyId, now);
}

/** Tests: forget which keys this process marked. */
export function resetApiKeyUsageMarks(): void {
  lastMarked.clear();
}
