import { CreateContactBody, CreateListingBody, UpdateListingBody } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { createKeyring, generateKey } from '@inmolink/platform/crypto';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * S16-F5: client registrations are introduction evidence kept for their validity plus the claim period
 * (`registrationClaimDays`); then the daily sweep deletes each with its viewing requests, both sides' receipts and its
 * fingerprints. A registration still within the claim period, or with a viewing still open, stays.
 */

const RUN = newId().slice(-8).toLowerCase();
const CLAIM_DAYS = 365;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.registration-retention.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

let a: Founder;
let b: Founder;
let listing: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Registers a new client of `a` for `b`'s listing and asks for a viewing; answers both ids. */
async function registered(name: string): Promise<{ registration: string; viewing: string }> {
  const { contact } = await as(a, (ctx) =>
    crm.createContact(ctx, CreateContactBody.parse({ firstName: name, emails: [`${name}-${RUN}@ret.example`] })),
  );
  const reg = await mls.registerClient((fn) => as(a, fn), {
    contactId: contact.id,
    target: { kind: 'LISTING', id: listing },
  });
  const viewing = await as(a, (ctx) =>
    mls.requestViewing(ctx, {
      registrationId: reg.registration.id,
      proposedStartAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    }),
  );
  return { registration: reg.registration.id, viewing: viewing.request.id };
}

/** Moves a registration's validity to have ended `daysAgo` days ago (fingerprints follow: ON UPDATE CASCADE). */
async function endedDaysAgo(registrationId: string, daysAgo: number, closeViewing = true): Promise<void> {
  await system(async (tx) => {
    await tx.execute(sql`update client_registrations
        set registered_at = now() - make_interval(days => ${daysAgo + 60}),
            expires_at = now() - make_interval(days => ${daysAgo})
      where id = ${registrationId}`);
    if (closeViewing) {
      await tx.execute(sql`update viewing_request_receipts set status = 'CANCELLED', awaiting = null,
          closed_by = 'INTRODUCER'
        where request_id in (select id from viewing_requests where registration_id = ${registrationId})`);
    }
  });
}

const left = (registrationId: string, viewingId: string) =>
  rows<Record<string, number>>(sql`select
      (select count(*) from client_registrations where id = ${registrationId})::int as registrations,
      (select count(*) from client_registration_receipts where registration_id = ${registrationId})::int as receipts,
      (select count(*) from client_registration_fingerprints where registration_id = ${registrationId})::int as fingerprints,
      (select count(*) from viewing_requests where id = ${viewingId})::int as viewings,
      (select count(*) from viewing_request_receipts where request_id = ${viewingId})::int as viewing_receipts`).then(
    (r) => r[0],
  );

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({
    keyring: createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' }),
    fingerprintKey: `test-fingerprint-key-${RUN}-0123456789abcdef`,
    registrationClaimDays: CLAIM_DAYS,
  });
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `ret-${RUN}`,
      translations: name('Retland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: `ret-g-${RUN}`, sort: 0, translations: name('H') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `ret-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  listing = (
    await as(b, (ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.city,
          priceCents: 40_000_000,
          energyRating: 'B',
          commission: { type: 'PCT', basisPoints: 400, includesVat: true },
          splitBp: 5000,
        }),
      ),
    )
  ).id;
  await as(b, async (ctx) =>
    properties.updateListing(
      ctx,
      listing,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'SHARED',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, listing)).version,
      }),
    ),
  );
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('registration retention', () => {
  it('[S16-F5] registrations and viewing requests are deleted after their validity plus the claim period', async () => {
    const old = await registered('olda');
    const recent = await registered('recenta');
    const open = await registered('opena');
    await endedDaysAgo(old.registration, CLAIM_DAYS + 10);
    await endedDaysAgo(recent.registration, CLAIM_DAYS - 10);
    await endedDaysAgo(open.registration, CLAIM_DAYS + 10, false); // its viewing is still open
    const all = { registrations: 1, receipts: 1, viewings: 1, viewing_receipts: 1 };
    expect(await left(old.registration, old.viewing)).toMatchObject(all);
    expect((await left(old.registration, old.viewing))?.fingerprints).toBeGreaterThan(0);

    const pruned = await mls.pruneExpiredRegistrations();
    expect(pruned.registrations).toBeGreaterThanOrEqual(1);
    expect(pruned.viewings).toBeGreaterThanOrEqual(1);
    expect(await left(old.registration, old.viewing)).toEqual({
      registrations: 0,
      receipts: 0,
      fingerprints: 0,
      viewings: 0,
      viewing_receipts: 0,
    });
    // within the claim period, or with a viewing still open: kept
    expect(await left(recent.registration, recent.viewing)).toMatchObject(all);
    expect(await left(open.registration, open.viewing)).toMatchObject(all);
    // idempotent
    await mls.pruneExpiredRegistrations();
    expect(await left(recent.registration, recent.viewing)).toMatchObject(all);
  }, 120_000);
});
