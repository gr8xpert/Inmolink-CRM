import type { UpdateAgencySettingsBody } from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { setupTestDb } from '@inmolink/db/testing';
import { cacheConnection, closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { configureStorage, createMemoryStore, type MemoryStore } from '@inmolink/platform/storage';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, CtxRunner } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as agencies from '../index';

/** Agency profile and settings on the real test database and redis-cache (S1-06). */

const CACHE_PREFIX = `t:agsettings:${newId().slice(-12)}`;
let store: MemoryStore;

beforeAll(async () => {
  await setupTestDb('worker');
  // Own Redis namespace: this file's settings cache only.
  await configureCache({ prefix: CACHE_PREFIX });
  store = createMemoryStore();
  configureStorage(store);
  agencies.registerAgenciesSubscriptions();
}, 120_000); // setupTestDb under a full parallel verify (S1-F1)

afterAll(async () => {
  agencies.unregisterAgenciesSubscriptions();
  await closeCache();
  await closeDb();
});

interface As {
  clientMode?: boolean;
  impersonatedBy?: string;
}

/** The member's real request `ctx`, optionally in Client Mode or impersonated by staff (S1-09 sets those). */
const as = <T>(m: { userId: string; agencyId: string }, fn: (ctx: Ctx) => Promise<T>, over: As = {}) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, (ctx) =>
    fn({
      ...ctx,
      clientMode: over.clientMode ?? false,
      actor:
        ctx.actor.kind === 'user' && over.impersonatedBy
          ? { ...ctx.actor, impersonatedBy: over.impersonatedBy }
          : ctx.actor,
    }),
  );
const runner =
  (m: Founder, over: As = {}): CtxRunner =>
  (fn) =>
    as(m, fn, over);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

type OutboxRow = {
  id: string;
  agency_id: string;
  version: number;
  payload: Record<string, unknown>;
  created_at: Date;
};

const eventsOf = (type: string, agencyId: string) =>
  withSystem('agency settings test: read outbox', async (tx) => {
    const r = await tx.execute<OutboxRow>(
      sql`select id, agency_id, version, payload, created_at from outbox_events
           where type = ${type} and agency_id = ${agencyId} order by id`,
    );
    return r.rows;
  });

/** Runs this process's subscribers for an outbox event (the dispatcher's job). */
async function deliver(type: string, event: OutboxRow): Promise<void> {
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

const setVerified = (agencyId: string) =>
  withSystem('agency settings test: verify', (tx) =>
    tx.execute(sql`update agencies set status = 'VERIFIED', onboarded_at = now() where agency_id = ${agencyId}`),
  );

function settingsBody(
  current: { version: number },
  over: Partial<UpdateAgencySettingsBody> = {},
): UpdateAgencySettingsBody {
  return {
    version: current.version,
    defaultCommission: { type: 'PCT', basisPoints: 300, includesVat: false },
    registrationValidityDays: 180,
    viewingResponseDays: 3,
    enabledLocales: ['es', 'en'],
    whiteLabel: { referencePrefix: 'CH', showPoweredBy: false, emailSenderName: 'Costa Homes' },
    clientMode: { pinMinLength: 6, pinMaxAttempts: 5 },
    ...over,
  };
}

// 1×1 PNG and the start of a PDF.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');

describe('agency settings', () => {
  it('[S1-06] settings changes emit agencies.settings.changed and invalidate cached settings', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getAgencySettings(ctx)); // cached now
    expect(await as(f, (ctx) => agencies.getAgencyDefaultCommission(ctx))).toBeNull();
    const key = `${CACHE_PREFIX}:${agencies.agencySettingsCacheKey(f.agencyId)}`;
    expect(await cacheConnection().exists(key)).toBe(1);
    // Bounded: the entry expires on its own even if an event were lost.
    const ttl = await cacheConnection().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(agencies.AGENCY_SETTINGS_CACHE_TTL_SECONDS);

    const saved = await as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before)));
    expect(saved).toMatchObject({
      version: before.version + 1,
      defaultCommission: { type: 'PCT', basisPoints: 300, includesVat: false },
      clientMode: { pinMinLength: 6, pinMaxAttempts: 5 },
    });

    const [event] = await eventsOf('agencies.settings.changed', f.agencyId);
    expect(event?.payload).toEqual({
      agencyId: f.agencyId,
      version: saved.version,
      changed: ['defaultCommission', 'enabledLocales', 'whiteLabel', 'clientMode'],
      actorUserId: f.userId,
      impersonatedBy: null,
    });
    // Until the event is delivered other readers may still see the cached value…
    expect((await as(f, (ctx) => agencies.getAgencySettings(ctx))).version).toBe(before.version);
    // …and the subscriber makes every process miss.
    await deliver('agencies.settings.changed', event as OutboxRow);
    const after = await as(f, (ctx) => agencies.getAgencySettings(ctx));
    const { defaultCommission, ...shared } = saved;
    expect(after).toEqual(shared);
    expect(await as(f, (ctx) => agencies.getAgencyDefaultCommission(ctx))).toEqual(defaultCommission);
  });

  it('[S1-06] a transaction that wrote settings never caches its uncommitted value', async () => {
    const f = await createFounder();
    const key = `${CACHE_PREFIX}:${agencies.agencySettingsCacheKey(f.agencyId)}`;
    class Rollback extends Error {}
    await as(f, async (ctx) => {
      const saved = await agencies.updateAgencySettings(ctx, settingsBody(await agencies.getMyAgencySettings(ctx)));
      // Read after the write in the same transaction: the new value, straight from the database.
      expect((await agencies.getAgencySettings(ctx)).version).toBe(saved.version);
      expect(await cacheConnection().exists(key)).toBe(0);
      throw new Rollback();
    }).catch((err) => {
      if (!(err instanceof Rollback)) throw err;
    });
    const committed = await as(f, (ctx) => agencies.getAgencySettings(ctx));
    expect(committed.version).toBe(1);
    expect(await as(f, (ctx) => agencies.getAgencyDefaultCommission(ctx))).toBeNull();
  });

  it('[S1-06] the dashboard read is never stale for the admin who saved', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    const saved = await as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before)));
    expect(await as(f, (ctx) => agencies.getMyAgencySettings(ctx))).toEqual(saved);
  });

  it('[S1-06] a save that changes nothing writes and emits nothing', async () => {
    const f = await createFounder();
    const first = await as(f, async (ctx) =>
      agencies.updateAgencySettings(ctx, settingsBody(await agencies.getMyAgencySettings(ctx))),
    );
    const again = await as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(first)));
    expect(again.version).toBe(first.version);
    expect(await eventsOf('agencies.settings.changed', f.agencyId)).toHaveLength(1);
  });

  it('[S1-06] a stale version is refused (VERSION_CONFLICT)', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    await as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before)));
    expect(
      await refusal(
        as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before, { viewingResponseDays: 5 }))),
      ),
    ).toBe('VERSION_CONFLICT');
  });

  it('[S1-06] fixed commission is stored as cents + currency; locales come from the i18n config', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    const fixed = { type: 'FIXED' as const, amount: { amountCents: 500_000, currency: 'EUR' }, includesVat: true };
    const saved = await as(f, (ctx) =>
      agencies.updateAgencySettings(ctx, settingsBody(before, { defaultCommission: fixed })),
    );
    expect(saved.defaultCommission).toEqual(fixed);
    expect(
      await refusal(
        as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(saved, { enabledLocales: ['es', 'xx'] }))),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('[S1-06] Client Mode never sees the commission or the PIN policy, and cannot change settings', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    const saved = await as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before)));
    const client = { clientMode: true };
    expect(await refusal(as(f, (ctx) => agencies.getMyAgencySettings(ctx), client))).toBe('FORBIDDEN');
    expect(await refusal(as(f, (ctx) => agencies.getAgencyDefaultCommission(ctx), client))).toBe('FORBIDDEN');
    // The shared read other modules use has no commission at all (also absent from its type).
    const shared = await as(f, (ctx) => agencies.getAgencySettings(ctx), client);
    expect('defaultCommission' in shared).toBe(false);
    expect(JSON.stringify(shared)).not.toContain('basisPoints');
    expect(await refusal(as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(saved)), client))).toBe(
      'FORBIDDEN',
    );
  });

  it('[S1-06] staff impersonating an admin cannot change settings', async () => {
    const f = await createFounder();
    const before = await as(f, (ctx) => agencies.getMyAgencySettings(ctx));
    expect(
      await refusal(
        as(f, (ctx) => agencies.updateAgencySettings(ctx, settingsBody(before)), { impersonatedBy: newId() }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('[S1-06] a direct table write cannot store settings the service would refuse (CHECK constraints)', async () => {
    const f = await createFounder();
    const write = (assignment: ReturnType<typeof sql>) =>
      withTenant({ agencyId: f.agencyId, userId: f.userId }, (tx) =>
        tx.execute(sql`update agency_settings set ${assignment} where agency_id = ${f.agencyId}`),
      );
    expect(await sqlState(write(sql`default_commission_type = 'PCT', default_commission_bp = 20000`))).toBe('23514');
    expect(await sqlState(write(sql`default_commission_type = 'FIXED', default_commission_bp = 300`))).toBe('23514');
    expect(await sqlState(write(sql`client_mode_pin_min_length = 2`))).toBe('23514');
    expect(await sqlState(write(sql`enabled_locales = '{}'`))).toBe('23514');
  });
});

describe('agency profile', () => {
  it('[S1-06] the first save creates the profile; texts replace the others; the change is an event', async () => {
    const f = await createFounder();
    const empty = await as(f, (ctx) => agencies.getAgencyProfile(ctx));
    expect(empty).toMatchObject({ version: 0, logo: null, translations: [] });

    const saved = await as(f, (ctx) =>
      agencies.updateAgencyProfile(ctx, {
        version: 0,
        primaryColor: '#0a7cff',
        accentColor: null,
        contactEmail: 'hola@costa-homes.example',
        contactPhone: '+34 952 000 000',
        websiteUrl: 'https://www.costa-homes.example',
        translations: [
          { locale: 'es', tagline: 'Casas en la costa', description: 'Desde 1999.' },
          { locale: 'en', tagline: 'Coastal homes', description: null },
        ],
      }),
    );
    expect(saved).toMatchObject({ version: 1, primaryColor: '#0a7cff', contactPhone: '+34 952 000 000' });
    expect(saved.translations.map((t) => t.locale)).toEqual(['en', 'es']);

    const next = await as(f, (ctx) =>
      agencies.updateAgencyProfile(ctx, {
        ...saved,
        version: saved.version,
        translations: [{ locale: 'es', tagline: 'Casas', description: null }],
      }),
    );
    expect(next.translations).toEqual([{ locale: 'es', tagline: 'Casas', description: null }]);
    expect(
      await refusal(as(f, (ctx) => agencies.updateAgencyProfile(ctx, { ...saved, version: 0, translations: [] }))),
    ).toBe('VERSION_CONFLICT');
    expect(await eventsOf('agencies.profile.updated', f.agencyId)).toHaveLength(2);
  });

  it('[S1-06] a profile save that changes nothing writes and emits nothing', async () => {
    const f = await createFounder();
    const body = {
      version: 0,
      primaryColor: '#0a7cff',
      accentColor: null,
      contactEmail: null,
      contactPhone: null,
      websiteUrl: 'https://costa.example',
      translations: [
        { locale: 'es', tagline: 'Casas', description: null },
        { locale: 'en', tagline: 'Homes', description: null },
      ],
    };
    const first = await as(f, (ctx) => agencies.updateAgencyProfile(ctx, body));
    // Same values, texts in another order: no write, no event, same version.
    const again = await as(f, (ctx) =>
      agencies.updateAgencyProfile(ctx, {
        ...body,
        version: first.version,
        translations: [...body.translations].reverse(),
      }),
    );
    expect(again).toEqual(first);
    expect(await eventsOf('agencies.profile.updated', f.agencyId)).toHaveLength(1);
    // A first save of an empty profile creates nothing either.
    const g = await createFounder();
    const empty = { ...body, primaryColor: null, websiteUrl: null, translations: [] };
    expect((await as(g, (ctx) => agencies.updateAgencyProfile(ctx, empty))).version).toBe(0);
    expect(await eventsOf('agencies.profile.updated', g.agencyId)).toHaveLength(0);
  });

  it('[S1-06] staff impersonating an admin may fix the profile; the event names both', async () => {
    const f = await createFounder();
    const staffId = newId();
    await as(
      f,
      (ctx) =>
        agencies.updateAgencyProfile(ctx, {
          version: 0,
          primaryColor: null,
          accentColor: null,
          contactEmail: null,
          contactPhone: null,
          websiteUrl: 'https://costa.example',
          translations: [],
        }),
      { impersonatedBy: staffId },
    );
    const [event] = await eventsOf('agencies.profile.updated', f.agencyId);
    expect(event?.payload).toMatchObject({ actorUserId: f.userId, impersonatedBy: staffId, logoChanged: false });
  });

  it('[S1-06] logo upload (stub until S3-03): checked by magic bytes and size, stored per agency, old object removed', async () => {
    const f = await createFounder();
    expect(await refusal(agencies.uploadAgencyLogo(runner(f), { body: PDF }))).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await refusal(agencies.uploadAgencyLogo(runner(f), { body: new Uint8Array(600 * 1024) }))).toBe(
      'PAYLOAD_TOO_LARGE',
    );

    const first = await agencies.uploadAgencyLogo(runner(f), { body: PNG });
    expect(first.logo).toMatchObject({ contentType: 'image/png', sizeBytes: PNG.byteLength });
    const keys = () => [...store.objects.keys()].filter((k) => k.startsWith(`private/agency-logos/${f.agencyId}/`));
    expect(keys()).toHaveLength(1);
    const url = await as(f, (ctx) => agencies.getAgencyLogoUrl(ctx));
    expect(url.url).toContain(`agency-logos/${f.agencyId}/`);
    // Served as the image type checked at upload (`response-content-type`; the memory store shows it as `type`).
    expect(url.url).toContain('type=image%2Fpng');

    await agencies.uploadAgencyLogo(runner(f), { body: PNG });
    expect(keys()).toHaveLength(1); // the replaced logo is gone
    const removed = await agencies.removeAgencyLogo(runner(f));
    expect(removed.logo).toBeNull();
    expect(keys()).toHaveLength(0);
    const events = await eventsOf('agencies.profile.updated', f.agencyId);
    expect(events.map((e) => e.payload.logoChanged)).toEqual([true, true, true]);
  });

  it('[S1-06] only admins change the logo, never in Client Mode', async () => {
    const f = await createFounder();
    expect(await refusal(agencies.uploadAgencyLogo(runner(f, { clientMode: true }), { body: PNG }))).toBe('FORBIDDEN');
    expect([...store.objects.keys()].some((k) => k.includes(f.agencyId))).toBe(false);
  });

  it('[S1-06] a direct write cannot point the logo at another object (CHECK constraint)', async () => {
    const f = await createFounder();
    const other = await createFounder();
    await as(f, (ctx) =>
      agencies.updateAgencyProfile(ctx, {
        version: 0,
        primaryColor: null,
        accentColor: null,
        contactEmail: null,
        contactPhone: null,
        websiteUrl: 'https://costa.example', // something to save, so the row exists
        translations: [],
      }),
    );
    for (const key of [`verification/${f.agencyId}/${newId()}`, `agency-logos/${other.agencyId}/${newId()}`]) {
      const state = await sqlState(
        withTenant({ agencyId: f.agencyId, userId: f.userId }, (tx) =>
          tx.execute(sql`update agency_profiles set logo_storage_key = ${key}, logo_content_type = 'image/png',
                           logo_size_bytes = 10 where agency_id = ${f.agencyId}`),
        ),
      );
      expect(state).toBe('23514');
    }
  });
});

describe('register number', () => {
  const details = {
    name: 'Costa Homes S.L.',
    taxId: 'B12345674',
    addressLine: 'Calle Mayor 1',
    city: 'Marbella',
    postalCode: '29601',
    region: 'ES-AN' as const,
    languages: ['es'],
  };

  it('[S1-06] the register number is a company detail, locked once verified (service and guard trigger)', async () => {
    const f = await createFounder();
    const agency = await as(f, (ctx) => agencies.getMyAgency(ctx));
    const saved = await as(f, (ctx) =>
      agencies.updateAgencyDetails(ctx, { ...details, version: agency.version, registerNumber: 'AICAT 1234' }),
    );
    expect(saved.registerNumber).toBe('AICAT 1234');
    // Omitted: unchanged.
    const again = await as(f, (ctx) => agencies.updateAgencyDetails(ctx, { ...details, version: saved.version }));
    expect(again.registerNumber).toBe('AICAT 1234');

    await setVerified(f.agencyId);
    const verified = await as(f, (ctx) => agencies.getMyAgency(ctx));
    expect(
      await refusal(
        as(f, (ctx) =>
          agencies.updateAgencyDetails(ctx, { ...details, version: verified.version, registerNumber: 'AICAT 9999' }),
        ),
      ),
    ).toBe('AGENCY_DETAILS_LOCKED');
    // A direct table write is refused by the guard trigger too (42501), for each locked column.
    for (const assignment of [
      sql`register_number = 'AICAT 9999'`,
      sql`name = 'Other Co S.L.'`,
      sql`tax_id = 'B00000000'`,
    ]) {
      const state = await sqlState(
        withTenant({ agencyId: f.agencyId, userId: f.userId }, (tx) =>
          tx.execute(sql`update agencies set ${assignment} where agency_id = ${f.agencyId}`),
        ),
      );
      expect(state).toBe('42501');
    }
  });
});
