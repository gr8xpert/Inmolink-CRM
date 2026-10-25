import { CreateContactBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { configureHmacRotation, createKeyring, generateKey, hmacKeyLabel } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * S12-F8: an HMAC rotation cannot close before the fingerprint rehash finishes. Fingerprints carry the label of the key
 * that made them (`key_id`); `mls.fingerprintsPending` counts valid registrations without a current-key fingerprint, and
 * `mls.checkFingerprintRehash` raises `HmacRotationRehashPending` for any within 24 h of `HMAC_KEY_PREVIOUS_UNTIL`.
 * Counts are scoped to this file's agency: the shared test DB holds other runs' registrations under other keys.
 */

const RUN = newId().slice(-8).toLowerCase();
const OLD_KEY = `test-rehash-old-key-${RUN}-0123456789abcdef`;
const NEW_KEY = `test-rehash-new-key-${RUN}-0123456789abcdef`;
const HOUR_MS = 3_600_000;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const log = createLogger({ service: 'mls-rehash-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.rehash-pending.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a` introduces, `b` owns the listing. */
let a: Founder;
let b: Founder;
let listingId: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function registered(name: string): Promise<string> {
  const { contact } = await as(a, (ctx) =>
    crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [`${name}-${RUN}@example.com`] })),
  );
  const res = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listingId },
  });
  return res.registration.id;
}

const keyIdsOf = async (registrationId: string) =>
  (
    await rows<{ key_id: string | null }>(
      sql`select key_id from client_registration_fingerprints where registration_id = ${registrationId}`,
    )
  ).map((r) => r.key_id);

const scope = () => ({ agencyIds: [a.agencyId] });
const openWindow = (endsInMs: number) =>
  configureHmacRotation({ current: NEW_KEY, previous: OLD_KEY, previousUntil: new Date(Date.now() + endsInMs) });

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-mls-rehash-${RUN}`, logger: log });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({ keyring, fingerprintKey: OLD_KEY });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `mls-rh-${RUN}`,
      translations: name('Rehashland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `mls-rh-g-${RUN}`,
      sort: 0,
      translations: name('Rh'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `mls-rh-v-${RUN}`,
      sort: 0,
      translations: name('Rhvilla'),
    });
    return { city, villa };
  });
  const { id } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 30_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(b, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  listingId = id;
}, 180_000);

afterEach(() => {
  restoreClock();
  mls.onRehashPendingAlert(undefined);
});

afterAll(async () => {
  configureHmacRotation({ current: OLD_KEY });
  configureHmacRotation({ current: NEW_KEY });
  await closeRateLimit();
  await closeQueues();
  await closeDb();
});

describe('fingerprint rehash before the window closes', () => {
  it('[S12-F8] fingerprints are stored with the label of their key; a registration in a window gets both keys’ rows', async () => {
    const before = await registered('Ola');
    expect(await keyIdsOf(before)).toEqual([hmacKeyLabel(OLD_KEY)]);
    mls.configureMls({ keyring, fingerprintKey: NEW_KEY });
    openWindow(30 * 24 * HOUR_MS);
    try {
      const during = await registered('Ida');
      expect((await keyIdsOf(during)).sort()).toEqual([hmacKeyLabel(NEW_KEY), hmacKeyLabel(OLD_KEY)].sort());
    } finally {
      configureHmacRotation({ current: NEW_KEY });
      mls.configureMls({ keyring, fingerprintKey: OLD_KEY });
    }
  });

  it('[S12-F8] one stale registration → pending > 0 and the alert fires within 24 h of the end; after the rehash pending = 0', async () => {
    const stale = await registered('Stale');
    // the rotation: NEW_KEY is HMAC_KEY now
    mls.configureMls({ keyring, fingerprintKey: NEW_KEY });
    // a registration under the new key whose rows predate key ids (no label): the same values, so the rehash only
    // labels them
    const legacy = await registered('Legacy');
    await system((tx) =>
      tx.execute(sql`update client_registration_fingerprints set key_id = null where registration_id = ${legacy}`),
    );
    // OLD_KEY is the previous key for 12 more hours
    openWindow(12 * HOUR_MS);
    const alerts: number[] = [];
    mls.onRehashPendingAlert((n) => alerts.push(n));
    try {
      expect(await mls.fingerprintsPending(scope())).toBeGreaterThanOrEqual(2);
      const check = await mls.checkFingerprintRehash(scope());
      expect(check).toMatchObject({ alert: true });
      expect(check.pending).toBeGreaterThanOrEqual(2);
      expect(alerts).toEqual([check.pending]);

      // more than 24 h before the end: nothing counted, no alert
      openWindow(48 * HOUR_MS);
      expect(await mls.checkFingerprintRehash(scope())).toMatchObject({ pending: 0, alert: false });
      expect(alerts).toHaveLength(1);

      // the rehash adds the current key's fingerprints (and labels same-value rows): nothing pending, no alert
      openWindow(12 * HOUR_MS);
      await mls.rehashAgencyFingerprints(a.agencyId);
      expect(await mls.fingerprintsPending(scope())).toBe(0);
      expect(await keyIdsOf(stale)).toContain(hmacKeyLabel(NEW_KEY));
      expect(await keyIdsOf(legacy)).toEqual([hmacKeyLabel(NEW_KEY)]);
      expect(await mls.checkFingerprintRehash(scope())).toMatchObject({ pending: 0, alert: false });
      expect(alerts).toHaveLength(1);
      // idempotent: a second pass adds nothing
      expect((await mls.rehashAgencyFingerprints(a.agencyId)).added).toBe(0);
    } finally {
      configureHmacRotation({ current: NEW_KEY });
      mls.configureMls({ keyring, fingerprintKey: OLD_KEY });
    }
  });

  it('[S12-F8] with no window open (or one without an end) the check counts nothing', async () => {
    useFakeClock(Date.now());
    expect(await mls.checkFingerprintRehash(scope())).toEqual({ pending: 0, alert: false, endsAt: null });
  });
});
