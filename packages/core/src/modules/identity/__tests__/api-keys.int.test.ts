import type { ApiKeyScope, CreateApiKeyInput } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { cache, cacheConnection, closeCache, configureCache, seen } from '@inmolink/platform/cache';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { configureHmacRotation, hmacSha256 } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder, impersonatedCtx } from '../../../testing/factories';
import { apiKeyCacheKey, apiKeyRehashMark } from '../api-keys';
import { rehashApiKeys } from '../api-keys-repo';
import * as identity from '../index';

/** Website API keys on the real test database and redis-cache (S1-05). */

const HMAC_KEY = 'test-hmac-key-0123456789abcdef0123456789';
const log = createLogger({ service: 'identity-api-keys-test', level: 'silent' });
const CACHE_PREFIX = `t:apikeys:${newId().slice(-12)}`;
const KEY_RE = /^inl_test_(sk|pk)[a-z2-7]{10}_[a-z2-7]{52}$/;

beforeAll(async () => {
  await setupTestDb('worker');
  // Own Redis namespace: the lookup cache and the "last used" set of this file only.
  await configureCache({ prefix: CACHE_PREFIX });
  identity.configureIdentity({ hmacKey: HMAC_KEY, apiKeyEnv: 'test' });
  identity.registerIdentitySubscriptions();
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterEach(() => restoreClock());

afterAll(async () => {
  identity.unregisterIdentitySubscriptions();
  await closeCache();
  await closeDb();
});

async function verifiedFounder(): Promise<Founder> {
  const founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  return founder;
}

const setAgencyStatus = (agencyId: string, status: 'VERIFIED' | 'SUSPENDED') =>
  withSystem('api keys test: agency status', (tx) =>
    tx.execute(sql`update agencies set status = ${status}, onboarded_at = now() where agency_id = ${agencyId}`),
  );

const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const SECRET_KEY: CreateApiKeyInput = {
  name: 'WordPress site',
  kind: 'SECRET',
  scopes: ['listings:read'],
  allowedOrigins: [],
};
const PUBLISHABLE_KEY: CreateApiKeyInput = {
  name: 'Search widget',
  kind: 'PUBLISHABLE',
  scopes: ['listings:read', 'search:ai'],
  allowedOrigins: ['https://www.costa-homes.example', 'http://localhost:3000'],
};

const authenticate = (key: string | undefined, scope: ApiKeyScope = 'listings:read', origin?: string) =>
  identity.authenticateApiKey({ key, origin, scope });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

/** Runs this process's subscribers for the latest outbox event of `type` about `keyId` (the dispatcher's job). */
async function deliver(type: string, keyId: string): Promise<void> {
  const event = await withSystem('api keys test: read outbox', async (tx) => {
    const r = await tx.execute<{ id: string; agency_id: string; version: number; payload: unknown; created_at: Date }>(
      sql`select id, agency_id, version, payload, created_at from outbox_events
           where type = ${type} and payload->>'keyId' = ${keyId} order by id desc limit 1`,
    );
    return r.rows[0];
  });
  if (!event) throw new Error(`no ${type} event`);
  const subscribers = defaultSubscribers.get(type, event.version);
  expect(subscribers.length).toBeGreaterThan(0);
  for (const s of subscribers) {
    await s.handler(event.payload as never, {
      eventId: event.id,
      agencyId: event.agency_id,
      type,
      version: event.version,
      createdAt: new Date(event.created_at),
      attempt: 1,
    });
  }
}

const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

describe('API keys', () => {
  it('[S1-05] secret is shown once; only prefix + hash are stored', async () => {
    const f = await verifiedFounder();
    const issued = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect(issued.secret).toMatch(KEY_RE);
    const secretPart = issued.secret.split('_').at(-1) as string;
    expect(issued.secret.split('_')[2]).toBe(issued.key.prefix);
    expect(issued.key).toMatchObject({ name: 'WordPress site', kind: 'SECRET', status: 'ACTIVE', lastUsedAt: null });

    const [row] = await withSystem(
      'api keys test: read row',
      async (tx) => (await tx.execute(sql`select * from api_keys where id = ${issued.key.id}`)).rows,
    );
    expect(row).toMatchObject({ prefix: issued.key.prefix, key_hash: hmacSha256(HMAC_KEY, 'api-key', issued.secret) });
    // The key itself is nowhere in the row: only the prefix and the HMAC.
    expect(JSON.stringify(row)).not.toContain(secretPart);

    // Listing never shows it again, nor the hash.
    const page = await as(f, (ctx) => identity.listApiKeys(ctx, { limit: 25 }));
    expect(page.items.map((k) => k.id)).toEqual([issued.key.id]);
    expect(JSON.stringify(page)).not.toContain(secretPart);
    expect(JSON.stringify(page)).not.toContain(String(row?.key_hash));

    expect(await authenticate(issued.secret)).toMatchObject({
      keyId: issued.key.id,
      agencyId: f.agencyId,
      kind: 'SECRET',
      rateTier: 'STANDARD',
    });
  });

  it('[S1-05] creating a key needs a verified agency (agencies.assertVerified apiKey.create)', async () => {
    const pending = await createFounder();
    expect(await refusal(as(pending, (ctx) => identity.createApiKey(ctx, SECRET_KEY)))).toBe('VERIFICATION_REQUIRED');
  });

  it('[S1-05] revoked key is rejected within 60 s (cache TTL)', async () => {
    // Without the invalidation event: the shared entry lives <= 25 s, a process's copy <= 15 s after it
    // was read, so the key is refused <= 40 s (plus load time) after revocation.
    const clock = useFakeClock(Date.now());
    const f = await verifiedFounder();
    const issued = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    await authenticate(issued.secret); // cached in Redis and in this process
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: issued.key.id }));
    expect(await authenticate(issued.secret)).toMatchObject({ keyId: issued.key.id }); // the cache window

    const redisKey = `${CACHE_PREFIX}:${apiKeyCacheKey(issued.key.prefix)}`;
    const ttl = await cacheConnection().ttl(redisKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(25);
    await cacheConnection().del(redisKey); // what Redis does when that TTL runs out
    expect(await authenticate(issued.secret)).toMatchObject({ keyId: issued.key.id }); // in-process copy
    clock.advance(15_001);
    expect(await refusal(authenticate(issued.secret))).toBe('API_KEY_INVALID');

    const page = await as(f, (ctx) => identity.listApiKeys(ctx, { limit: 25 }));
    expect(page.items[0]).toMatchObject({ status: 'REVOKED' });
    expect(await refusal(as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: issued.key.id })))).toBe('NOT_FOUND');
  });

  it('[S7-08] only a system context sets the rate tier of a key: audited, and the event drops the cached lookup', async () => {
    const f = await verifiedFounder();
    const issued = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect((await authenticate(issued.secret)).rateTier).toBe('STANDARD');
    const set = (ctx: Ctx) =>
      identity.setApiKeyRateTier(ctx, { keyIds: [issued.key.id], tier: 'HIGH', reason: 'perf.load-test' });
    // An agency admin cannot choose a tier.
    expect(await refusal(as(f, set))).toBe('FORBIDDEN');
    const changed = await withSystem('api keys test: tier', (tx) =>
      set({
        tx,
        tenant: { agencyId: f.agencyId, verified: true, plan: 'none', locales: ['en'] },
        actor: { kind: 'system', reason: 'perf.load-test' },
        locale: 'en',
        requestId: newId(),
        clientMode: false,
      }),
    );
    expect(changed).toBe(1);
    await deliver('identity.apiKey.tierChanged', issued.key.id);
    cache.clearLocal();
    expect((await authenticate(issued.secret)).rateTier).toBe('HIGH');
    const audit = await withSystem('api keys test: audit', (tx) =>
      tx.execute<{ actor_kind: string; metadata: { tier: string; reason: string } }>(
        sql`select actor_kind, metadata from audit_logs
             where type = 'identity.apiKey.tierChanged' and target_id = ${issued.key.id}`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'system', metadata: { tier: 'HIGH', reason: 'perf.load-test' } });
  });

  it('[S1-05] the revocation event drops the shared cache entry', async () => {
    const f = await verifiedFounder();
    const issued = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    await authenticate(issued.secret);
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: issued.key.id }));
    await deliver('identity.apiKey.revoked', issued.key.id);
    // This process's copy is dropped too; other processes' copies expire within 15 s.
    expect(await refusal(authenticate(issued.secret))).toBe('API_KEY_INVALID');
    cache.clearLocal();
    expect(await refusal(authenticate(issued.secret))).toBe('API_KEY_INVALID');
  });

  it('[S1-05] unknown prefixes are never cached (random keys cannot fill redis-cache)', async () => {
    const unknown = `inl_test_sk${'a'.repeat(10)}_${'b'.repeat(52)}`;
    expect(await refusal(authenticate(unknown))).toBe('API_KEY_INVALID');
    expect(await cacheConnection().keys(`${CACHE_PREFIX}:*${'a'.repeat(10)}*`)).toEqual([]);
  });

  it('[S1-05] rotation replaces the secret: the old key is refused, the new one works', async () => {
    const f = await verifiedFounder();
    const first = await as(f, (ctx) => identity.createApiKey(ctx, PUBLISHABLE_KEY));
    await authenticate(first.secret, 'listings:read', 'https://www.costa-homes.example');
    const rotated = await as(f, (ctx) => identity.rotateApiKey(ctx, { keyId: first.key.id }));
    expect(rotated.key).toMatchObject({ id: first.key.id, kind: 'PUBLISHABLE', scopes: PUBLISHABLE_KEY.scopes });
    expect(rotated.key.rotatedAt).not.toBeNull();
    expect(rotated.secret).toMatch(KEY_RE);
    expect(rotated.key.prefix).not.toBe(first.key.prefix);
    await deliver('identity.apiKey.rotated', first.key.id);
    expect(await refusal(authenticate(first.secret, 'listings:read', 'https://www.costa-homes.example'))).toBe(
      'API_KEY_INVALID',
    );
    expect(await authenticate(rotated.secret, 'listings:read', 'https://www.costa-homes.example')).toMatchObject({
      keyId: first.key.id,
    });
  });

  it('[S1-05] publishable key from a non-allowlisted origin is rejected', async () => {
    const f = await verifiedFounder();
    const { secret } = await as(f, (ctx) => identity.createApiKey(ctx, PUBLISHABLE_KEY));
    expect(await authenticate(secret, 'listings:read', 'https://www.costa-homes.example')).toMatchObject({
      kind: 'PUBLISHABLE',
      rateTier: 'STANDARD',
    });
    expect(await authenticate(secret, 'listings:read', 'HTTPS://WWW.COSTA-HOMES.EXAMPLE')).toMatchObject({
      kind: 'PUBLISHABLE',
    });
    for (const origin of ['https://evil.example', 'https://costa-homes.example', 'http://www.costa-homes.example']) {
      expect(await refusal(authenticate(secret, 'listings:read', origin)), origin).toBe('API_KEY_ORIGIN_DENIED');
    }
    expect(await refusal(authenticate(secret, 'listings:read', undefined))).toBe('API_KEY_ORIGIN_DENIED');
  });

  it('[S1-05] scopes are enforced on every request', async () => {
    const f = await verifiedFounder();
    const { secret } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect(await refusal(authenticate(secret, 'leads:write'))).toBe('API_KEY_SCOPE_DENIED');
    expect(await authenticate(secret, 'listings:read')).toMatchObject({ scopes: ['listings:read'] });
  });

  it('[S1-05] a secret key used with an Origin (from a browser) is refused', async () => {
    const f = await verifiedFounder();
    const { secret } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect(await refusal(authenticate(secret, 'listings:read', 'https://www.costa-homes.example'))).toBe(
      'API_KEY_ORIGIN_DENIED',
    );
  });

  it('[S1-05] a suspension racing key creation leaves no usable key', async () => {
    // Suspended after the request read its ctx (still "verified"): the status read under lock refuses.
    const early = await verifiedFounder();
    expect(
      await refusal(
        as(early, async (ctx) => {
          await setAgencyStatus(early.agencyId, 'SUSPENDED');
          return identity.createApiKey(ctx, SECRET_KEY);
        }),
      ),
    ).toBe('VERIFICATION_REQUIRED');

    // Suspended while the creating transaction is open: the suspension waits for it, then the sync
    // job (which reads the status FOR SHARE) turns the new key off.
    const late = await verifiedFounder();
    let suspended = false;
    let suspend: Promise<unknown> = Promise.resolve();
    const issued = await as(late, async (ctx) => {
      const created = await identity.createApiKey(ctx, SECRET_KEY);
      suspend = setAgencyStatus(late.agencyId, 'SUSPENDED').then(() => {
        suspended = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(suspended).toBe(false); // blocked by the agency row lock
      return created;
    });
    await suspend;
    await identity.identityJobs.syncApiKeyAgencyStatus.spec.run(
      { eventId: newId(), agencyId: late.agencyId },
      jobCtx(),
    );
    expect(await refusal(authenticate(issued.secret))).toBe('API_KEY_INVALID');
  });

  it('[S1-05] keys are never issued (S1-09: nor revoked) while staff impersonate an admin; events record who acted', async () => {
    const f = await verifiedFounder();
    const staffId = newId();
    const impersonated = <T>(fn: (ctx: Ctx) => Promise<T>) =>
      as(f, async (ctx) => fn(await impersonatedCtx(ctx, staffId)));
    expect(await refusal(impersonated((ctx) => identity.createApiKey(ctx, SECRET_KEY)))).toBe('FORBIDDEN');
    const { key } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect(await refusal(impersonated((ctx) => identity.rotateApiKey(ctx, { keyId: key.id })))).toBe('FORBIDDEN');
    expect(await refusal(impersonated((ctx) => identity.revokeApiKey(ctx, { keyId: key.id })))).toBe('FORBIDDEN');
    // Staff impersonating may still see the keys.
    expect((await impersonated((ctx) => identity.listApiKeys(ctx, { limit: 10 }))).items).toHaveLength(1);
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: key.id }));
    const events = await withSystem(
      'api keys test: events',
      async (tx) =>
        (
          await tx.execute<{ type: string; payload: Record<string, unknown> }>(
            sql`select type, payload from outbox_events where payload->>'keyId' = ${key.id} order by id`,
          )
        ).rows,
    );
    expect(events).toEqual([
      {
        type: 'identity.apiKey.created',
        payload: expect.objectContaining({ actorUserId: f.userId, impersonatedBy: null }),
      },
      {
        type: 'identity.apiKey.revoked',
        payload: expect.objectContaining({ actorUserId: f.userId, impersonatedBy: null }),
      },
    ]);
  });

  it('[S1-05] malformed, tampered and other-environment keys get one answer: API_KEY_INVALID', async () => {
    const f = await verifiedFounder();
    const { secret } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    const last = secret.at(-1) === 'a' ? 'b' : 'a';
    for (const key of [
      undefined,
      '',
      'not-a-key',
      `${secret.slice(0, -1)}${last}`,
      secret.replace('inl_test_', 'inl_live_'),
      `${secret}x`,
    ]) {
      expect(await refusal(authenticate(key)), String(key)).toBe('API_KEY_INVALID');
    }
  });

  it('[S1-05] keys stop working while the agency is suspended (agencies.status.changed) and work again after', async () => {
    const f = await verifiedFounder();
    const { secret } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    await authenticate(secret); // cached
    await setAgencyStatus(f.agencyId, 'SUSPENDED');
    await identity.identityJobs.syncApiKeyAgencyStatus.spec.run({ eventId: newId(), agencyId: f.agencyId }, jobCtx());
    expect(await refusal(authenticate(secret))).toBe('API_KEY_INVALID');
    await setAgencyStatus(f.agencyId, 'VERIFIED');
    await identity.identityJobs.syncApiKeyAgencyStatus.spec.run({ eventId: newId(), agencyId: f.agencyId }, jobCtx());
    expect(await authenticate(secret)).toMatchObject({ agencyId: f.agencyId });
  });

  it('[S1-05] last_used_at is written in batches by the worker, not per request', async () => {
    const f = await verifiedFounder();
    const { key, secret } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    identity.resetApiKeyUsageMarks();
    await seen.drain(identity.API_KEY_USAGE_SET);
    // A foreign id in the set (not a UUID) is skipped, not cast.
    await seen.mark(identity.API_KEY_USAGE_SET, 'not-a-uuid', new Date());
    for (let i = 0; i < 5; i++) await authenticate(secret);
    const lastUsed = async () =>
      withSystem('api keys test: last used', async (tx) => {
        const r = await tx.execute<{ last_used_at: Date | null }>(
          sql`select last_used_at from api_keys where id = ${key.id}`,
        );
        return r.rows[0]?.last_used_at ?? null;
      });
    // Requests write nothing to the database.
    expect(await lastUsed()).toBeNull();
    // Marks are fire-and-forget: poll until the Redis call has landed.
    const flush = () => identity.identityJobs.flushApiKeyUsage.spec.run({}, jobCtx());
    let updated = 0;
    await expect
      .poll(async () => {
        updated += ((await flush()) as { updated: number }).updated;
        return updated;
      })
      .toBeGreaterThan(0);
    // Five requests, one mark, one write (the foreign id is drained but skipped); nothing left after.
    expect(updated).toBe(1);
    expect(await lastUsed()).not.toBeNull();
    expect(await flush()).toEqual({ keys: 0, updated: 0, rehashed: 0 });
  });

  it('[S1-05] an agency has at most MAX_ACTIVE active keys; revoking frees a slot', async () => {
    const f = await verifiedFounder();
    const ids: string[] = [];
    for (let i = 0; i < identity.API_KEYS.MAX_ACTIVE; i++) {
      ids.push((await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY))).key.id);
    }
    expect(await refusal(as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY)))).toBe('API_KEY_LIMIT_REACHED');
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: ids[0] as string }));
    expect((await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY))).key.status).toBe('ACTIVE');
  }, 60_000);

  it('[S1-05] another agency cannot list, rotate or revoke the keys', async () => {
    const owner = await verifiedFounder();
    const other = await verifiedFounder();
    const { key, secret } = await as(owner, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    expect((await as(other, (ctx) => identity.listApiKeys(ctx, { limit: 25 }))).items).toEqual([]);
    expect(await refusal(as(other, (ctx) => identity.rotateApiKey(ctx, { keyId: key.id })))).toBe('NOT_FOUND');
    expect(await refusal(as(other, (ctx) => identity.revokeApiKey(ctx, { keyId: key.id })))).toBe('NOT_FOUND');
    expect(await authenticate(secret)).toMatchObject({ agencyId: owner.agencyId });
  });

  it('[S1-05] tenants cannot change what only workers set, nor delete or revive a key (guard trigger)', async () => {
    const f = await verifiedFounder();
    const { key } = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    const denied = (statement: ReturnType<typeof sql>) =>
      as(f, (ctx) => ctx.tx.execute(statement)).then(
        () => 'ok',
        (err: unknown) => {
          for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; i++) {
            if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
            e = e.cause as typeof e;
          }
          throw err;
        },
      );
    // agency_active is derived from the agency on every tenant write, whatever the statement says.
    expect(await denied(sql`update api_keys set agency_active = false where id = ${key.id}`)).toBe('ok');
    const active = await withSystem(
      'api keys test: active',
      async (tx) =>
        (await tx.execute<{ agency_active: boolean }>(sql`select agency_active from api_keys where id = ${key.id}`))
          .rows[0],
    );
    expect(active?.agency_active).toBe(true);
    for (const statement of [
      sql`update api_keys set last_used_at = now() where id = ${key.id}`,
      sql`update api_keys set rate_tier = 'HIGH' where id = ${key.id}`,
      sql`update api_keys set scopes = '{leads:write}' where id = ${key.id}`,
      sql`update api_keys set allowed_origins = '{https://x.example}' where id = ${key.id}`,
      sql`update api_keys set key_hash = 'x' where id = ${key.id}`,
      sql`update api_keys set revoked_by = ${f.userId} where id = ${key.id}`,
    ]) {
      expect(await denied(statement)).toBe('42501');
    }
    const insert = (over: { createdBy?: string; tier?: string; siteId?: string | null }) =>
      sql`insert into api_keys (id, agency_id, name, kind, prefix, key_hash, scopes, rate_tier, created_by, site_id)
          values (${newId()}, ${f.agencyId}, 'x', 'SECRET', ${`sk${newId().slice(-10)}`}, 'h', '{listings:read}',
                  ${over.tier ?? 'STANDARD'}, ${over.createdBy ?? f.userId},
                  ${over.siteId === undefined ? key.siteId : over.siteId})`;
    expect(await denied(insert({ createdBy: newId() }))).toBe('42501');
    expect(await denied(insert({ tier: 'HIGH' }))).toBe('42501');
    // S7-01: a key is bound to a site, and stays on it.
    expect(await denied(insert({ siteId: null }))).toBe('42501');
    expect(await denied(sql`update api_keys set site_id = null where id = ${key.id}`)).toBe('42501');
    expect(await denied(insert({}))).toBe('ok');
    expect(await denied(sql`delete from api_keys where id = ${key.id}`)).toBe('42501');
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: key.id }));
    expect(await denied(sql`update api_keys set revoked_at = null where id = ${key.id}`)).toBe('42501');
  });

  it('[S1-05] the list shows active keys and keys revoked in the last 30 days', async () => {
    const f = await verifiedFounder();
    useFakeClock(Date.now() - 31 * 24 * 60 * 60_000);
    const old = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: old.key.id }));
    restoreClock();
    const recent = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    await as(f, (ctx) => identity.revokeApiKey(ctx, { keyId: recent.key.id }));
    const active = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY));
    const page = await as(f, (ctx) => identity.listApiKeys(ctx, { limit: 25 }));
    expect(page.items.map((k) => k.id)).toEqual([recent.key.id, active.key.id]);
  });

  it('[S12-F15] a key issued under the previous HMAC_KEY works during the rotation window and is rehashed on use', async () => {
    const PREVIOUS = 'test-hmac-key-previous-0123456789abcdef01';
    const f = await verifiedFounder();
    identity.configureIdentity({ hmacKey: PREVIOUS, apiKeyEnv: 'test' });
    const issued = await as(f, (ctx) => identity.createApiKey(ctx, SECRET_KEY)).finally(() =>
      identity.configureIdentity({ hmacKey: HMAC_KEY, apiKeyEnv: 'test' }),
    );
    const storedHash = () =>
      withSystem('api keys test: stored hash', async (tx) => {
        const r = await tx.execute<{ key_hash: string }>(
          sql`select key_hash from api_keys where id = ${issued.key.id}`,
        );
        return r.rows[0]?.key_hash;
      });
    expect(await storedHash()).toBe(hmacSha256(PREVIOUS, 'api-key', issued.secret));
    identity.resetApiKeyUsageMarks();
    await seen.drain(identity.API_KEY_REHASH_SET);
    try {
      // No window: a key of the previous HMAC_KEY is refused.
      expect(await refusal(authenticate(issued.secret))).toBe('API_KEY_INVALID');

      configureHmacRotation({
        current: HMAC_KEY,
        previous: PREVIOUS,
        previousUntil: new Date(Date.now() + 86_400_000),
      });
      const flush = () => identity.identityJobs.flushApiKeyUsage.spec.run({}, jobCtx());
      // A forged mark (well-formed, naming the stored hash, but its MAC is not the current key's) is ignored: it would
      // otherwise lock the key out with a garbage hash.
      const stored = (await storedHash()) as string;
      const forged = apiKeyRehashMark(issued.key.id, stored, 'A'.repeat(43)).replace(/:[^:]+$/, `:${'B'.repeat(22)}`);
      await seen.mark(identity.API_KEY_REHASH_SET, forged, new Date());
      await seen.mark(identity.API_KEY_REHASH_SET, `${newId()}:x:y`, new Date());
      expect(await flush()).toMatchObject({ rehashed: 0 });
      expect(await storedHash()).toBe(stored);
      await expect(authenticate(issued.secret)).resolves.toMatchObject({ keyId: issued.key.id });
      // A key with a wrong secret still fails under either key.
      expect(
        await refusal(authenticate(`${issued.secret.slice(0, -1)}${issued.secret.endsWith('a') ? 'b' : 'a'}`)),
      ).toBe('API_KEY_INVALID');

      // The flush job stores the current key's hash and drops the cached lookup, so the key keeps working once the
      // window closes.
      let rehashed = 0;
      await expect
        .poll(async () => {
          rehashed += ((await flush()) as { rehashed: number }).rehashed;
          return rehashed;
        })
        .toBeGreaterThan(0);
      expect(rehashed).toBe(1);
      expect(await storedHash()).toBe(hmacSha256(HMAC_KEY, 'api-key', issued.secret));

      configureHmacRotation({ current: HMAC_KEY });
      cache.clearLocal();
      await expect(authenticate(issued.secret)).resolves.toMatchObject({ keyId: issued.key.id });
      // Window closed: even a correctly signed mark is not applied.
      const current = (await storedHash()) as string;
      await seen.mark(
        identity.API_KEY_REHASH_SET,
        apiKeyRehashMark(issued.key.id, current, hmacSha256(PREVIOUS, 'api-key', issued.secret)),
        new Date(),
      );
      expect(await flush()).toMatchObject({ rehashed: 0 });
      expect(await storedHash()).toBe(current);

      // A stale mark (the key rotated meanwhile) never overwrites the rotated key's hash.
      const rotated = await as(f, (ctx) => identity.rotateApiKey(ctx, { keyId: issued.key.id }));
      const fresh = await storedHash();
      await withSystem('api keys test: stale rehash', async (tx) => {
        expect(
          await rehashApiKeys(tx, [
            {
              id: issued.key.id,
              from: hmacSha256(HMAC_KEY, 'api-key', issued.secret).slice(0, 22),
              to: hmacSha256(PREVIOUS, 'api-key', issued.secret),
            },
          ]),
        ).toEqual([]);
      });
      expect(await storedHash()).toBe(fresh);
      await expect(authenticate(rotated.secret)).resolves.toMatchObject({ keyId: issued.key.id });
    } finally {
      configureHmacRotation({ current: HMAC_KEY });
    }
  });
});
