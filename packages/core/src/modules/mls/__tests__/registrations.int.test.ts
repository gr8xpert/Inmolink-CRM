import {
  CreateContactBody,
  type CreateContactInput,
  CreateListingBody,
  type CreateRegistrationBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, withSystem, withTenant } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { configureHmacRotation, createKeyring, generateKey, hmacSha256 } from '@inmolink/platform/crypto';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as taxonomy from '../../taxonomy';
import * as mls from '../index';

/**
 * Client registration (S11-01, PLAN §3 #8): first valid registration of a client (keyed fingerprint of each normalized
 * e-mail and phone) for a target wins across agencies; an expired one no longer blocks; nothing of the client is stored
 * outside the encrypted details; the owner sees who registered, never the client; a contact merge moves registrations;
 * an HMAC rotation keeps old registrations blocking; conflicts are audited and budgeted.
 */

const RUN = newId().slice(-8).toLowerCase();
const FINGERPRINT_KEY = `test-fingerprint-key-${RUN}-0123456789abcdef`;
const DAY_MS = 86_400_000;
const keyring = createKeyring({ keys: { k1: generateKey() }, activeKeyId: 'k1' });
const log = createLogger({ service: 'mls-test', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('mls.registrations.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

/** `a`, `c` and `d` introduce, `b` owns the network listings. */
let a: Founder;
let b: Founder;
let c: Founder;
let d: Founder;
let ids: { city: string; villa: string };
let listings: string[];
let privateListing: string;
let ownListing: string;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const email = (name: string) => `${name}-${RUN}@example.com`;
let phoneSeq = Number.parseInt(RUN.replaceAll(/[^0-9]/g, '').slice(0, 4) || '1', 10) * 1_000 + 500;
const mobile = () => {
  phoneSeq += 1;
  return `6${String(phoneSeq).padStart(8, '0').slice(-8)}`;
};

const contact = async (m: Founder, body: CreateContactInput) =>
  (await as(m, (ctx) => crm.createContact(ctx, CreateContactBody.parse(body)))).contact;
const register = (m: Founder, contactId: string, target: CreateRegistrationBody['target']) =>
  mls.registerClient((fn) => as(m, fn), { contactId, target });
const onListing = (i: number) => ({ kind: 'LISTING' as const, id: listings[i] as string });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) {
      // never the pg error's detail (fingerprints, the other registration's validity)
      expect(err.code === 'REGISTRATION_CONFLICT' ? err.details : undefined).toBeUndefined();
      return err.code;
    }
    throw err;
  }
  return 'accepted';
}

/** Moves a registration (and its receipt and fingerprints) `days` into the past (app_system: app_user cannot). */
const backdate = (registrationId: string, days: number) =>
  system(async (tx) => {
    const by = sql`make_interval(days => ${days}::int)`;
    await tx.execute(sql`update client_registrations set registered_at = registered_at - ${by},
      expires_at = expires_at - ${by} where id = ${registrationId}`);
    await tx.execute(sql`update client_registration_receipts set registered_at = registered_at - ${by},
      expires_at = expires_at - ${by} where registration_id = ${registrationId}`);
    // the fingerprints follow through their FK (ON UPDATE CASCADE)
  });

async function listing(m: Founder, visibility: 'SHARED' | 'PRIVATE'): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 45_000_000,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility,
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-mls-${RUN}`, logger: log });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  mls.configureMls({ keyring, fingerprintKey: FINGERPRINT_KEY });
  [a, b, c, d] = await Promise.all([createFounder(), createFounder(), createFounder(), createFounder()]);
  for (const m of [a, b, c, d]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `mls-rg-${RUN}`,
      translations: name('Regcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `mls-rg-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `mls-rg-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  listings = [];
  for (let i = 0; i < 8; i++) listings.push(await listing(b, 'SHARED'));
  privateListing = await listing(b, 'PRIVATE');
  ownListing = await listing(a, 'SHARED');
}, 180_000);

afterAll(async () => {
  configureHmacRotation({ current: FINGERPRINT_KEY });
  await closeRateLimit();
  await closeQueues();
  await closeDb();
});

describe('first valid registration wins', () => {
  it('[S11-01] second agency registering the same client for the same target gets REGISTRATION_CONFLICT', async () => {
    const phone = mobile();
    const mine = await contact(a, { firstName: 'Lena', lastName: 'Berg', emails: [email('lena')], phones: [phone] });
    const first = await register(a, mine.id, onListing(0));
    expect(first.outcome).toBe('CREATED');
    expect(first.registration).toMatchObject({
      contactId: mine.id,
      client: { firstName: 'Lena', lastName: 'Berg', emails: [email('lena')], phones: [`+34${phone}`] },
      target: onListing(0),
      ownerAgencyId: b.agencyId,
      registeredByUserId: a.userId,
    });
    // the default validity: 180 days (both agencies' settings)
    const { registeredAt, expiresAt } = first.registration;
    expect(Date.parse(expiresAt) - Date.parse(registeredAt)).toBe(180 * DAY_MS);
    // the answer is built from the write, and matches what the list reads back
    const own = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 100 }));
    expect(own.items.find((r) => r.id === first.registration.id)).toEqual(first.registration);

    // the same client in another agency's CRM: matched on the e-mail however it was typed …
    const theirs = await contact(c, { firstName: 'L.', emails: [` ${email('lena').toUpperCase()} `] });
    expect(await refusal(register(c, theirs.id, onListing(0)))).toBe('REGISTRATION_CONFLICT');
    // … or on the phone alone, in another format
    const byPhone = await contact(c, { firstName: 'Lena B', phones: [`0034 ${phone}`] });
    expect(await refusal(register(c, byPhone.id, onListing(0)))).toBe('REGISTRATION_CONFLICT');
    // nothing was written for the refused attempts, but each conflict is audited
    const written = await rows<{ n: number }>(
      sql`select count(*)::int as n from client_registrations where agency_id = ${c.agencyId}`,
    );
    expect(written[0]?.n).toBe(0);
    const audited = await rows<{ metadata: Record<string, unknown> }>(sql`select metadata from audit_logs
      where agency_id = ${c.agencyId} and type = 'mls.registration.conflicted' order by occurred_at`);
    expect(audited.map((r) => r.metadata)).toEqual([
      { targetKind: 'LISTING', targetId: listings[0], contactId: theirs.id },
      { targetKind: 'LISTING', targetId: listings[0], contactId: byPhone.id },
    ]);

    // another target is free, and so is another client for the same target
    expect((await register(c, theirs.id, onListing(1))).outcome).toBe('CREATED');
    const other = await contact(c, { firstName: 'Otto', emails: [email('otto')] });
    expect((await register(c, other.id, onListing(0))).outcome).toBe('CREATED');
  });

  it('[S11-01] the agency’s own repeat registration of the client answers the valid one, concurrent ones too', async () => {
    const mine = await contact(a, { firstName: 'Rita', emails: [email('rita')] });
    const first = await register(a, mine.id, onListing(2));
    const again = await register(a, mine.id, onListing(2));
    expect(again).toEqual({ outcome: 'EXISTING', registration: first.registration });

    // two requests at once: the exclusion constraint serializes them, the loser answers the winner's registration
    const twin = await contact(a, { firstName: 'Tina', emails: [email('tina')] });
    const both = await Promise.all([register(a, twin.id, onListing(3)), register(a, twin.id, onListing(3))]);
    expect(both.map((r) => r.outcome).sort()).toEqual(['CREATED', 'EXISTING']);
    expect(both[0]?.registration.id).toBe(both[1]?.registration.id);
  });

  it('[S11-01] expired registrations no longer block', async () => {
    const old = await contact(a, { firstName: 'Ola', emails: [email('ola')], phones: [mobile()] });
    const first = await register(a, old.id, onListing(4));
    // registered 181 days ago: its 180 days of validity are over
    await backdate(first.registration.id, 181);
    const theirs = await contact(c, { firstName: 'Ola', emails: [email('ola')] });
    const second = await register(c, theirs.id, onListing(4));
    expect(second.outcome).toBe('CREATED');
    // the new registration now blocks the first introducer in turn, until it expires
    expect(await refusal(register(a, old.id, onListing(4)))).toBe('REGISTRATION_CONFLICT');
  });

  it('[S11-01] the validity is the shorter of the introducer’s and the owner’s setting, from the database’s time', async () => {
    const setDays = (m: Founder, days: number) =>
      system((tx) =>
        tx.execute(
          sql`update agency_settings set registration_validity_days = ${days} where agency_id = ${m.agencyId}`,
        ),
      );
    await setDays(b, 30);
    try {
      const mine = await contact(a, { firstName: 'Short', emails: [email('short')] });
      const before = await rows<{ now: Date }>(sql`select now() as now`);
      const { registration } = await register(a, mine.id, onListing(5));
      expect(Date.parse(registration.expiresAt) - Date.parse(registration.registeredAt)).toBe(30 * DAY_MS);
      expect(Date.parse(registration.registeredAt)).toBeGreaterThanOrEqual(new Date(before[0]?.now as Date).getTime());
      const [receipt] = await rows<{ expires_at: Date }>(
        sql`select expires_at from client_registration_receipts where registration_id = ${registration.id}`,
      );
      expect(new Date(receipt?.expires_at as Date).toISOString()).toBe(registration.expiresAt);
    } finally {
      await setDays(b, 180);
    }
  });

  it('[S11-01] only another agency’s network listing can be registered for', async () => {
    const mine = await contact(a, { firstName: 'Tom', emails: [email('tom')] });
    for (const target of [
      { kind: 'LISTING' as const, id: privateListing },
      { kind: 'LISTING' as const, id: ownListing },
      { kind: 'LISTING' as const, id: newId() },
      { kind: 'DEVELOPMENT' as const, id: newId() },
    ]) {
      expect(await refusal(register(a, mine.id, target))).toBe('REGISTRATION_TARGET_NOT_FOUND');
    }
    expect(await refusal(register(a, newId(), onListing(6)))).toBe('CONTACT_NOT_FOUND');
    // a contact without e-mail or phone cannot be fingerprinted
    const nameOnly = await contact(a, { firstName: 'Nameless' });
    expect(await refusal(register(a, nameOnly.id, onListing(6)))).toBe('VALIDATION_FAILED');
  });

  it('[S11-01] the cross-agency rule is a database exclusion constraint (drizzle does not know it)', async () => {
    const [ex] = await rows<{ type: string; def: string }>(sql`
      select contype::text as type, pg_get_constraintdef(oid) as def from pg_constraint
       where conname = 'client_registration_fingerprints_valid_ex'
         and conrelid = 'public.client_registration_fingerprints'::regclass`);
    expect(ex?.type).toBe('x');
    expect(ex?.def).toBe(
      'EXCLUDE USING gist (target_id WITH =, fingerprint WITH =, tstzrange(registered_at, expires_at) WITH &&)',
    );
  });

  it('[S11-01] conflicts beyond the daily probe budget answer RATE_LIMITED, parallel attempts included', async () => {
    const victim = await contact(a, { firstName: 'Probe', emails: [email('probe')] });
    await register(a, victim.id, onListing(7));
    const prober = await contact(d, { firstName: 'Probe', emails: [email('probe')] });
    // 25 attempts at once: the agency's lock serializes them, so the peek and the count see each other
    const { limit } = mls.REGISTRATION_CONFLICT_BUDGET;
    const codes = await Promise.all(
      Array.from({ length: limit + 5 }, () => refusal(register(d, prober.id, onListing(7)))),
    );
    expect(codes.filter((c) => c === 'REGISTRATION_CONFLICT')).toHaveLength(limit);
    expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(5);
    const audited = await rows<{ n: number }>(sql`select count(*)::int as n from audit_logs
      where agency_id = ${d.agencyId} and type = 'mls.registration.conflicted'`);
    expect(audited[0]?.n).toBe(limit + 1); // the one that tripped the penalty conflicted too
    // in the penalty a registration that would succeed is refused too (its success would answer the same question)
    const fresh = await contact(d, { firstName: 'Fresh', emails: [email('fresh')] });
    expect(await refusal(register(d, fresh.id, onListing(7)))).toBe('RATE_LIMITED');
    // other agencies are not affected
    const unrelated = await contact(c, { firstName: 'Una', emails: [email('una')] });
    expect((await register(c, unrelated.id, onListing(7))).outcome).toBe('CREATED');
  });

  it('[S11-01] the database sets the start and caps the length, whatever a request inserts; fingerprints follow the registration', async () => {
    // as `d` (in the probe penalty by now): its list is never decrypted below — 'x' is no ciphertext
    const id = newId();
    await withTenant({ agencyId: d.agencyId, userId: d.userId }, (tx) =>
      tx.execute(sql`insert into client_registrations
        (id, agency_id, target_agency_id, target_kind, target_id, contact_id, details_enc, registered_at, expires_at)
        values (${id}, ${d.agencyId}, ${b.agencyId}, 'LISTING', ${newId()}, ${newId()}, 'x',
                '2020-01-01T00:00:00Z', '2023-01-01T00:00:00Z')`),
    );
    const [row] = await rows<{ start_lag_s: number; days: number }>(sql`
      select extract(epoch from now() - registered_at)::int as start_lag_s,
             extract(day from expires_at - registered_at)::int as days
        from client_registrations where id = ${id}`);
    expect(Math.abs(row?.start_lag_s ?? 1e9)).toBeLessThan(60);
    expect(row?.days).toBe(180); // 1,096 requested, capped at the owner's 180
    // a fingerprint cannot claim another range or target than its registration's (FK on all of them)
    const [reg] = await rows<{ registered_at: Date; expires_at: Date; target_id: string }>(
      sql`select registered_at, expires_at, target_id from client_registrations where id = ${id}`,
    );
    const insertPrint = (target: string, until: Date) =>
      withTenant({ agencyId: d.agencyId, userId: d.userId }, (tx) =>
        tx.execute(sql`insert into client_registration_fingerprints
          (registration_id, agency_id, target_id, fingerprint, registered_at, expires_at)
          values (${id}, ${d.agencyId}, ${target}, ${`fp-${id}`}, ${reg?.registered_at}, ${until})`),
      ).then(
        () => 'ok',
        (err: { cause?: { code?: string }; code?: string }) => err.cause?.code ?? err.code,
      );
    const later = new Date(new Date(reg?.expires_at as Date).getTime() + DAY_MS);
    expect(await insertPrint(reg?.target_id as string, later)).toBe('23503');
    expect(await insertPrint(newId(), reg?.expires_at as Date)).toBe('23503');
    expect(await insertPrint(reg?.target_id as string, reg?.expires_at as Date)).toBe('ok');
    // and app_user never deletes one
    const del = await withTenant({ agencyId: d.agencyId, userId: d.userId }, (tx) =>
      tx.execute(sql`delete from client_registration_fingerprints where registration_id = ${id}`),
    ).then(
      () => 'ok',
      (err: { cause?: { code?: string }; code?: string }) => err.cause?.code ?? err.code,
    );
    expect(del).toBe('42501');
  });

  it('[S11-01] the receipt trigger is the only app_owner definer that reads agency_settings', async () => {
    // a new definer reading agency settings widens what the definer_read policy exposes: review it, then list it here
    const definers = await rows<{ name: string }>(sql`
      select proname as name from pg_proc
       where prosecdef and pg_get_userbyid(proowner) = 'app_owner' and prosrc ~ 'agency_settings' order by 1`);
    expect(definers.map((r) => r.name)).toEqual(['client_registrations_receipt']);
  });
});

describe('HMAC rotation and retention', () => {
  const OLD_KEY = `test-old-fingerprint-key-${RUN}-0123456789abcdef`;

  it('[S11-01] a registration made under the previous key still blocks during a rotation window', async () => {
    const phone = mobile();
    try {
      // registered while OLD_KEY was HMAC_KEY
      mls.configureMls({ keyring, fingerprintKey: OLD_KEY });
      const mine = await contact(a, { firstName: 'Rosa', emails: [email('rosa')], phones: [phone] });
      const { registration } = await register(a, mine.id, onListing(6));

      // the rotation: FINGERPRINT_KEY is HMAC_KEY now, OLD_KEY is HMAC_KEY_PREVIOUS until the window ends
      mls.configureMls({ keyring, fingerprintKey: FINGERPRINT_KEY });
      configureHmacRotation({ current: FINGERPRINT_KEY, previous: OLD_KEY });
      const theirs = await contact(c, { firstName: 'Rosa', emails: [email('rosa')] });
      expect(await refusal(register(c, theirs.id, onListing(6)))).toBe('REGISTRATION_CONFLICT');
      // a repeat by the introducer still finds its own registration (any key's fingerprint)
      expect((await register(a, mine.id, onListing(6))).outcome).toBe('EXISTING');

      // the rehash adds the current key's fingerprints from the encrypted snapshot, once
      expect(await mls.agenciesToRehash()).toContain(a.agencyId);
      const first = await mls.rehashAgencyFingerprints(a.agencyId);
      expect(first.added).toBeGreaterThanOrEqual(2);
      expect((await mls.rehashAgencyFingerprints(a.agencyId)).added).toBe(0);
      const prints = await rows<{ fingerprint: string }>(
        sql`select fingerprint from client_registration_fingerprints where registration_id = ${registration.id}`,
      );
      const current = [`email:${email('rosa')}`, `phone:+34${phone}`].map((v) =>
        hmacSha256(Buffer.from(FINGERPRINT_KEY), 'mls.client-fingerprint', v),
      );
      expect(prints.map((p) => p.fingerprint)).toEqual(expect.arrayContaining(current));

      // the window closes: the registration keeps blocking under the current key alone
      configureHmacRotation({ current: FINGERPRINT_KEY });
      expect(await mls.agenciesToRehash()).toEqual([]);
      expect(await refusal(register(c, theirs.id, onListing(6)))).toBe('REGISTRATION_CONFLICT');
    } finally {
      configureHmacRotation({ current: FINGERPRINT_KEY });
      mls.configureMls({ keyring, fingerprintKey: FINGERPRINT_KEY });
    }
  });

  it('[S11-01] fingerprints long past expiry are pruned; registrations and receipts stay as evidence', async () => {
    const gone = await contact(a, { firstName: 'Gone', emails: [email('gone')] });
    const { registration } = await register(a, gone.id, onListing(5));
    await backdate(registration.id, 180 + mls.FINGERPRINT_RETENTION_DAYS + 1);
    expect((await mls.pruneExpiredFingerprints()).deleted).toBeGreaterThanOrEqual(1);
    const left = await rows<{ prints: number; regs: number; receipts: number }>(sql`select
      (select count(*)::int from client_registration_fingerprints where registration_id = ${registration.id}) as prints,
      (select count(*)::int from client_registrations where id = ${registration.id}) as regs,
      (select count(*)::int from client_registration_receipts where registration_id = ${registration.id}) as receipts`);
    expect(left[0]).toEqual({ prints: 0, regs: 1, receipts: 1 });
  });
});

describe('privacy', () => {
  it('[S11-01] fingerprints are not reversible without the HMAC key (no raw identifiers stored outside encrypted fields)', async () => {
    const phone = mobile();
    const mine = await contact(a, { firstName: 'Petra', lastName: 'Quist', emails: [email('petra')], phones: [phone] });
    const { registration } = await register(a, mine.id, onListing(1));

    // every stored column of the three tables, as text: no e-mail, phone or name in clear
    const stored = await rows<{ row: string }>(sql`
      select row_to_json(r)::text as row from client_registrations r where r.id = ${registration.id}
      union all select row_to_json(p)::text from client_registration_receipts p where p.registration_id = ${registration.id}
      union all select row_to_json(f)::text from client_registration_fingerprints f where f.registration_id = ${registration.id}`);
    expect(stored).toHaveLength(4); // the registration, the owner's receipt, one fingerprint per e-mail and phone
    const all = stored.map((s) => s.row).join('\n');
    for (const secret of [email('petra'), 'petra', phone, `+34${phone}`, 'Petra', 'Quist']) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    }

    // the fingerprints are the keyed HMAC of the normalized identifiers: with another key they do not match
    const prints = await rows<{ fingerprint: string }>(
      sql`select fingerprint from client_registration_fingerprints where registration_id = ${registration.id} order by 1`,
    );
    const keyed = (key: string) =>
      [`email:${email('petra')}`, `phone:+34${phone}`]
        .map((v) => hmacSha256(Buffer.from(key), 'mls.client-fingerprint', v))
        .sort();
    // sorted in JS on both sides: `order by` follows the database collation, which orders base64url's - and _
    // differently from code points (CI 803c4a9)
    const printed = prints.map((p) => p.fingerprint).sort();
    expect(printed).toEqual(keyed(FINGERPRINT_KEY));
    expect(printed).not.toEqual(keyed('another-key-0123456789abcdef0123456789'));

    // the details decrypt only through the agency's own read
    expect(registration.client).toEqual({
      firstName: 'Petra',
      lastName: 'Quist',
      emails: [email('petra')],
      phones: [`+34${phone}`],
    });
  });

  it('[S11-01] the owner sees “registered by Agency X”, never the client', async () => {
    const mine = await contact(a, { firstName: 'Vera', emails: [email('vera')] });
    const { registration } = await register(a, mine.id, onListing(2));

    const received = await as(b, (ctx) => mls.listReceivedRegistrations(ctx, { limit: 100 }));
    const seen = received.items.find((r) => r.id === registration.id);
    expect(Object.keys(seen ?? {}).sort()).toEqual(
      [
        'expiresAt',
        'id',
        'introducerAgencyId',
        'introducerName',
        'registeredAt',
        'state',
        'target',
        'targetLabel',
      ].sort(),
    );
    expect(seen).toMatchObject({
      introducerAgencyId: a.agencyId,
      target: onListing(2),
      registeredAt: registration.registeredAt,
      expiresAt: registration.expiresAt,
    });
    expect(JSON.stringify(received)).not.toContain(email('vera'));

    // under RLS the owner reaches its receipt only; nobody else sees anything; the introducer never sees receipts
    const reach = (m: Founder) =>
      withTenant({ agencyId: m.agencyId, userId: m.userId }, async (tx) => {
        const n = async (q: ReturnType<typeof sql>) => ((await tx.execute(q)).rows[0] as { n: number }).n;
        return {
          registrations: await n(
            sql`select count(*)::int as n from client_registrations where id = ${registration.id}`,
          ),
          receipts: await n(
            sql`select count(*)::int as n from client_registration_receipts where registration_id = ${registration.id}`,
          ),
          fingerprints: await n(
            sql`select count(*)::int as n from client_registration_fingerprints where registration_id = ${registration.id}`,
          ),
        };
      });
    expect(await reach(b)).toEqual({ registrations: 0, receipts: 1, fingerprints: 0 });
    expect(await reach(c)).toEqual({ registrations: 0, receipts: 0, fingerprints: 0 });
    expect(await reach(a)).toEqual({ registrations: 1, receipts: 0, fingerprints: 1 });
    const othersReceived = await as(c, (ctx) => mls.listReceivedRegistrations(ctx, { limit: 100 }));
    expect(othersReceived.items.map((r) => r.id)).not.toContain(registration.id);

    // a request can delete neither the registration (evidence) nor the owner's receipt
    const deleteAs = (m: Founder, q: ReturnType<typeof sql>) =>
      withTenant({ agencyId: m.agencyId, userId: m.userId }, (tx) => tx.execute(q)).then(
        () => 'ok',
        (err: { cause?: { code?: string }; code?: string }) => err.cause?.code ?? err.code,
      );
    expect(await deleteAs(a, sql`delete from client_registrations where id = ${registration.id}`)).toBe('42501');
    expect(
      await deleteAs(b, sql`delete from client_registration_receipts where registration_id = ${registration.id}`),
    ).toBe('42501');
  });

  it('[S11-01] the introducer’s list pages newest first by keyset', async () => {
    const page1 = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 2 }));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 100, cursor: page1.nextCursor as string }));
    const seen = [...page1.items, ...page2.items];
    expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
    const times = seen.map((r) => Date.parse(r.registeredAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
});

describe('contact merge', () => {
  it('[S11-01] contact merge moves registrations', async () => {
    const survivor = await contact(a, { firstName: 'Max', emails: [email('max')] });
    const duplicate = await contact(a, { firstName: 'Maxi', emails: [email('maxi')] });
    const { registration } = await register(a, duplicate.id, onListing(3));

    const current = await as(a, (ctx) => crm.getContact(ctx, survivor.id));
    await as(a, (ctx) => crm.mergeContacts(ctx, survivor.id, { duplicateId: duplicate.id, version: current.version }));

    // the merge's outbox event, handed to mls's subscriber, queues the re-point with the event's id as job id
    const [event] = await rows<{ id: string; created_at: Date; payload: { survivorId: string; mergedId: string } }>(sql`
      select id, created_at, payload from outbox_events
       where agency_id = ${a.agencyId} and type = 'crm.contact.merged' and payload->>'mergedId' = ${duplicate.id}`);
    expect(event?.payload).toMatchObject({ survivorId: survivor.id, mergedId: duplicate.id });
    mls.registerMlsSubscriptions();
    const enqueue = vi.spyOn(mls.mlsJobs.repointRegistrations, 'enqueue');
    try {
      const subscriber = defaultSubscribers
        .get('crm.contact.merged', 1)
        .find((s) => s.name === 'mls.registrations.contactMerged');
      expect(subscriber).toBeDefined();
      await subscriber?.handler(subscriber.def.schema.parse(event?.payload), {
        eventId: event?.id as string,
        agencyId: a.agencyId,
        type: 'crm.contact.merged',
        version: 1,
        createdAt: new Date(event?.created_at as Date),
        attempt: 1,
      });
      const payload = { eventId: event?.id, agencyId: a.agencyId, survivorId: survivor.id, mergedId: duplicate.id };
      expect(enqueue).toHaveBeenCalledWith(payload);
      // a redelivered event queues the same job (stable job ID = the event's id)
      expect((await enqueue.mock.results[0]?.value)?.id).toBe(`mls.repointRegistrations.${event?.id}`);
      expect(mls.mlsJobs.repointRegistrations.spec.jobId?.(payload as never)).toBe(event?.id);
    } finally {
      enqueue.mockRestore();
      mls.unregisterMlsSubscriptions();
    }

    // the job: run twice (at least once delivery), the second finds nothing to move
    const p = { agencyId: a.agencyId, survivorId: survivor.id, mergedId: duplicate.id };
    expect(await mls.repointRegistrations(p)).toEqual({ rows: 1 });
    expect(await mls.repointRegistrations(p)).toEqual({ rows: 0 });
    const own = await as(a, (ctx) => mls.listRegistrations(ctx, { limit: 100 }));
    expect(own.items.find((r) => r.id === registration.id)?.contactId).toBe(survivor.id);
  });
});
