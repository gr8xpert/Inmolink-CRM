import {
  type CreateClientProfileBody,
  CreateContactBody,
  type CreateContactInput,
  CreateListingBody,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, type Tx, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { FALLBACK_CONTENT_LOCALE } from '@inmolink/i18n';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail, type EmailMessage, type Mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as presentations from '../../presentations';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as matching from '../index';

/**
 * AUTO_SEND delivery (R2-02e) on the real test database: the engine's QUEUED matches of a profile go to the client as
 * one branded selection, by e-mail in the client's language (or as a WhatsApp link to the agent), never twice, only
 * with marketing consent, within the caps, white-labelled; a re-run sends nothing again and a failed send is retried
 * with a new link. Each test has its own city, so its listings reach only its own profiles.
 */

const RUN = newId().slice(-8).toLowerCase();
const L = FALLBACK_CONTENT_LOCALE;
const code = (s: string) => `${s}-dl-${RUN}`;
const system = <T>(fn: (tx: Tx) => Promise<T>) => withSystem('matching.delivery.test', fn);
const rows = <T>(q: ReturnType<typeof sql>) => system(async (tx) => (await tx.execute(q)).rows as T[]);

const OWNER_NAME = `Ownerhaus Delivera ${RUN}`;
const OWNER_MAIL = `sales-${RUN}@ownerhaus-delivera.example`;
const OWNER_PHONE = '+34 955 512 345';

let o: Founder;
let net: Founder;
let ids: { region: string; villa: string };

/** The memory mailer, failing the next `failNext` sends (nothing sent). */
const mail = {
  sent: [] as EmailMessage[],
  failNext: 0,
};
const mailer: Mailer = {
  async send(m) {
    if (mail.failNext > 0) {
      mail.failNext -= 1;
      throw new Error('smtp down');
    }
    mail.sent.push(m);
    return { id: newId() };
  },
  async close() {},
};
const mailsTo = (to: string) => mail.sent.filter((m) => m.to === to);

const as = <T>(f: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: f.userId, agencyId: f.agencyId, requestId: newId(), locale: 'en' }, fn);

async function city(): Promise<string> {
  const n = newId().slice(-6);
  return system((tx) =>
    taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: ids.region,
      code: code(`ci${n}`),
      translations: [{ locale: L, name: `Deliverton ${n}`, slug: code(`ci${n}`) }],
    }),
  );
}

/** A PUBLIC, ACTIVE listing of `f` in `cityId`, shared to ALL; its read model built and matched. */
async function listing(f: Founder, cityId: string, body: Partial<CreateListingBody> = {}, description?: string) {
  const version = async (id: string) => (await as(f, (ctx) => properties.getListing(ctx, id))).version;
  const { id } = await as(f, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: cityId,
        priceCents: 50_000_000,
        bedrooms: 4,
        energyRating: 'B',
        commission: { type: 'PCT', basisPoints: 500, includesVat: false },
        splitBp: 5000,
        ...body,
      }),
    ),
  );
  if (description) {
    for (const locale of ['en', 'es']) {
      await as(f, async (ctx) =>
        properties.saveListingTranslation(ctx, id, locale, {
          version: await version(id),
          title: `Villa ${RUN}`,
          description,
        }),
      );
    }
  }
  await as(f, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        version: await version(id),
      }),
    ),
  );
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
  await matching.matchListingsToProfiles({ agencyId: f.agencyId, listingIds: [id] });
  return id;
}

async function withdraw(f: Founder, id: string): Promise<void> {
  const { version } = await as(f, (ctx) => properties.getListing(ctx, id));
  await as(f, (ctx) => properties.updateListing(ctx, id, UpdateListingBody.parse({ visibility: 'PRIVATE', version })));
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', [id]));
}

let seq = 0;
async function contact(f: Founder, over: Partial<CreateContactInput> = {}) {
  seq += 1;
  const email = `client-${seq}-${RUN}@example.com`;
  const c = await as(f, (ctx) =>
    crm.createContact(
      ctx,
      CreateContactBody.parse({
        firstName: 'Lucía',
        emails: [email],
        language: 'es',
        consentMarketing: true,
        ...over,
      }),
    ),
  );
  return { id: c.contact.id, email };
}

async function profile(f: Founder, contactId: string, cityId: string, extra: Partial<CreateClientProfileBody> = {}) {
  return (
    await as(f, (ctx) =>
      matching.createClientProfile(ctx, contactId, {
        mode: 'AUTO_SEND',
        frequency: 'INSTANT',
        transactionType: 'SALE',
        propertyTypeIds: [ids.villa],
        locationIds: [cityId],
        priceMaxCents: 90_000_000,
        ...extra,
      }),
    )
  ).id;
}

const statuses = (profileId: string) =>
  rows<{ listing_id: string; status: string; selection_id: string | null }>(
    sql`select listing_id, status, selection_id from client_profile_matches where profile_id = ${profileId}`,
  );
const selectionItems = (selectionId: string) =>
  rows<{ target_id: string }>(
    sql`select target_id from selection_items where selection_id = ${selectionId} order by position`,
  ).then((r) => r.map((x) => x.target_id));
const deliveries = (profileId: string) =>
  rows<{ id: string; status: string; channel: string; period_key: string; attempts: number; selection_id: string }>(
    sql`select id, status, channel, period_key, attempts, selection_id from client_profile_deliveries
         where profile_id = ${profileId} order by created_at`,
  );
const deliver = (f: Founder, profileId: string, period: matching.DeliveryPeriod = 'INSTANT', limits = {}) =>
  matching.deliverProfile({ agencyId: f.agencyId, profileId, period }, { limits });

/** The selection page link in an alert e-mail. */
const linkIn = (m: EmailMessage) => /https:\/\/sites\.example\/s\/[A-Za-z0-9_-]{43}/.exec(m.text)?.[0] ?? null;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:dl:${RUN}`, commandTimeoutMs: 2_000 });
  await configureEmail(mailer);
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.example',
  });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  [o, net] = await Promise.all([createFounder(), createFounder({ companyName: OWNER_NAME })]);
  for (const f of [o, net]) await setAgencyStatus(f.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (x: string) => [{ locale: L, name: `${x} ${RUN}`, slug: code(x.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Deliveryland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Delivershire'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('villa'),
      sort: 0,
      translations: name('Villa'),
    });
    return { region, villa };
  });
}, 240_000);

beforeEach(() => {
  mail.failNext = 0;
});

afterAll(async () => {
  await closeEmail();
  await closeCache();
  await closeDb();
});

describe('AUTO_SEND delivery (R2-02e)', () => {
  it('[R2-02e] INSTANT: many queued matches go as one selection in one e-mail; a re-run sends nothing twice', async () => {
    const ci = await city();
    const c = await contact(o);
    const P = await profile(o, c.id, ci);
    const listings = [await listing(o, ci), await listing(o, ci), await listing(o, ci, { priceCents: 60_000_000 })];
    expect((await statuses(P)).map((s) => s.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);

    const r = await deliver(o, P);
    expect(r).toMatchObject({ outcome: 'SENT', sent: 3, channel: 'EMAIL', duplicates: 0 });
    expect(mailsTo(c.email)).toHaveLength(1);
    const after = await statuses(P);
    expect(after.every((s) => s.status === 'SENT')).toBe(true);
    const selectionId = after[0]?.selection_id as string;
    expect(new Set(after.map((s) => s.selection_id))).toEqual(new Set([selectionId]));
    expect(new Set(await selectionItems(selectionId))).toEqual(new Set(listings));
    // the selection is the contact's (so it is in the client's SUBJECT export, selections.csv) and from its agent
    const [sel] = await rows<{ contact_id: string; created_by: string; locale: string }>(
      sql`select contact_id, created_by, locale from selections where id = ${selectionId}`,
    );
    expect(sel).toEqual({ contact_id: c.id, created_by: o.userId, locale: 'es' });
    expect(await deliveries(P)).toEqual([expect.objectContaining({ status: 'SENT', channel: 'EMAIL', attempts: 1 })]);

    // idempotent: the job re-run (a redelivered job) sends nothing and writes nothing
    expect(await deliver(o, P)).toMatchObject({ outcome: 'NONE', sent: 0 });
    expect(mailsTo(c.email)).toHaveLength(1);
    expect(await deliveries(P)).toHaveLength(1);
    // the link opens the client's page with the three listings
    const link = linkIn(mailsTo(c.email)[0] as EmailMessage) as string;
    const page = await presentations.selectionPage(link.split('/s/')[1] as string);
    expect(page.items.filter((i) => i.detail)).toHaveLength(3);
  });

  it("[R2-02e] the e-mail is in the client's language (ES / EN), branded as the agency, with why and how to stop", async () => {
    const ci = await city();
    const es = await contact(o, { language: 'es' });
    const en = await contact(o, { language: 'en', firstName: 'Mary' });
    const Pes = await profile(o, es.id, ci);
    const Pen = await profile(o, en.id, ci);
    await listing(o, ci);
    await deliver(o, Pes);
    await deliver(o, Pen);
    const [mes] = mailsTo(es.email);
    const [men] = mailsTo(en.email);
    expect(mes?.subject).toContain('nueva propiedad para ti');
    expect(mes?.text).toContain('Hola Lucía:');
    expect(mes?.text).toContain('Ver la selección');
    expect(mes?.text).toContain('Para dejar de recibirlos');
    expect(men?.subject).toContain('new property for you');
    expect(men?.text).toContain('Hello Mary,');
    expect(men?.text).toContain('To stop them, reply to this e-mail');
    expect(men?.fromName).toBe('Costa Homes S.L.');
    expect(men?.tag).toBe('matching.profile-alert');
    // "reply to stop" reaches someone: the agency's address, else the agent's
    expect(men?.replyTo).toMatch(/@/);
    expect(linkIn(men as EmailMessage)).not.toBeNull();
  });

  it('[R2-02e] a client with a phone and no e-mail: the agent gets the wa.me link with the text in the client language', async () => {
    const ci = await city();
    const c = await contact(o, { emails: [], phones: ['+34 611 222 333'], language: 'es' });
    const P = await profile(o, c.id, ci);
    await listing(o, ci);
    const r = await deliver(o, P);
    expect(r).toMatchObject({ outcome: 'SENT', channel: 'WHATSAPP', sent: 1 });
    const wa = new URL(r.whatsappUrl as string);
    expect(wa.origin + wa.pathname).toBe('https://wa.me/34611222333');
    const text = wa.searchParams.get('text') as string;
    expect(text).toMatch(/^Hola Lucía, hemos encontrado nuevas propiedades/);
    expect(text).toMatch(/https:\/\/sites\.example\/s\/[A-Za-z0-9_-]{43}$/);
    const [agent] = mailsTo(o.email);
    expect(agent?.tag).toBe('matching.profile-alert-whatsapp');
    expect(agent?.text).toContain(r.whatsappUrl as string);
    expect((await deliveries(P))[0]).toMatchObject({ channel: 'WHATSAPP', status: 'SENT' });
  });

  it('[R2-02e] never twice: a listing sent through another profile of the contact, or in a selection for them, is not sent again', async () => {
    const ci = await city();
    const c = await contact(o);
    const P1 = await profile(o, c.id, ci);
    const A = await listing(o, ci);
    expect(await deliver(o, P1)).toMatchObject({ outcome: 'SENT', sent: 1 });
    // a second profile of the same client matches A (already sent) and B; a manual selection for the client holds C
    const P2 = await profile(o, c.id, ci, { priceMaxCents: 95_000_000 });
    await matching.matchProfilesToListings({ agencyId: o.agencyId, profileIds: [P2] });
    const B = await listing(o, ci);
    const C = await listing(o, ci);
    await as(o, (ctx) =>
      presentations.createSelection(ctx, {
        title: 'For Lucía',
        locale: 'es',
        contactId: c.id,
        items: [{ targetId: C }],
      }),
    );
    expect(new Set((await statuses(P2)).map((s) => s.listing_id))).toEqual(new Set([A, B, C]));
    const r = await deliver(o, P2);
    expect(r).toMatchObject({ outcome: 'SENT', sent: 1, duplicates: 2 });
    const s2 = await statuses(P2);
    const sentWith = s2.find((s) => s.listing_id === B)?.selection_id as string;
    expect(await selectionItems(sentWith)).toEqual([B]);
    for (const l of [A, C])
      expect(s2.find((s) => s.listing_id === l)).toMatchObject({ status: 'SENT', selection_id: null });
    // P1 got B and C too: neither is sent again
    expect(await deliver(o, P1)).toMatchObject({ outcome: 'NONE', duplicates: 2, sent: 0 });
    expect(mailsTo(c.email)).toHaveLength(2);
  });

  it('[R2-02e] no consent, do-not-contact or no channel: nothing is sent, the matches stay QUEUED', async () => {
    const ci = await city();
    const none = await contact(o, { consentMarketing: false });
    const dnc = await contact(o, { doNotContact: true });
    const mute = await contact(o, { emails: [], firstName: 'Nadie' });
    const P1 = await profile(o, none.id, ci);
    const P2 = await profile(o, dnc.id, ci);
    const P3 = await profile(o, mute.id, ci);
    await listing(o, ci);
    expect((await deliver(o, P1)).outcome).toBe('NO_CONSENT');
    expect((await deliver(o, P2)).outcome).toBe('NO_CONSENT');
    expect((await deliver(o, P3)).outcome).toBe('NO_CHANNEL');
    for (const P of [P1, P2, P3]) {
      expect((await statuses(P)).map((s) => s.status)).toEqual(['QUEUED']);
      expect(await deliveries(P)).toEqual([]);
    }
    expect(mailsTo(none.email)).toHaveLength(0);
    expect(mailsTo(dnc.email)).toHaveLength(0);
    // consent given later: the waiting match goes
    const { version } = await as(o, (ctx) => crm.getContact(ctx, none.id));
    await as(o, (ctx) => crm.updateContact(ctx, none.id, { version, consentMarketing: true }));
    expect(await deliver(o, P1)).toMatchObject({ outcome: 'SENT', sent: 1 });
  });

  it('[R2-02e] an own listing withdrawn before the send is EXPIRED and left out', async () => {
    const ci = await city();
    const c = await contact(o);
    const P = await profile(o, c.id, ci);
    const A = await listing(o, ci);
    const B = await listing(o, ci);
    await withdraw(o, A);
    const r = await deliver(o, P);
    expect(r).toMatchObject({ outcome: 'SENT', sent: 1, expired: 1 });
    const s = await statuses(P);
    expect(s.find((x) => x.listing_id === A)?.status).toBe('EXPIRED');
    expect(await selectionItems(s.find((x) => x.listing_id === B)?.selection_id as string)).toEqual([B]);
  });

  it('[R2-02e] white-label: a network listing in the e-mail shows no owner name, e-mail, phone, commission or reference', async () => {
    const ci = await city();
    const c = await contact(o, { language: 'en' });
    const P = await profile(o, c.id, ci);
    const N = await listing(
      net,
      ci,
      {},
      `Villa with 4 bedrooms and a pool. Call ${OWNER_NAME} on ${OWNER_PHONE} or mail ${OWNER_MAIL}.`,
    );
    expect(await deliver(o, P)).toMatchObject({ outcome: 'SENT', sent: 1 });
    const [m] = mailsTo(c.email);
    const ownerRef = (await as(net, (ctx) => properties.getListing(ctx, N))).ref as string;
    const whole = `${m?.subject}\n${m?.text}\n${m?.html}\n${m?.fromName}\n${m?.replyTo ?? ''}`;
    for (const leak of [
      OWNER_NAME,
      OWNER_MAIL,
      'ownerhaus-delivera',
      '955 512 345',
      '955512345',
      ownerRef,
      net.agencyId,
    ]) {
      expect(whole).not.toContain(leak);
    }
    expect(whole).not.toMatch(/commission|comisi/i);
    expect(m?.text).toContain('Costa Homes S.L.');
    expect(m?.text).toContain(`Villa ${RUN}`);
  });

  it('[R2-02e] DAILY / WEEKLY: due at the local digest hour, once per period; INSTANT jobs leave them alone', async () => {
    // 2026-11-09 is a Monday; Madrid is UTC+1 in November
    expect(matching.digestPeriodsDue(new Date('2026-11-09T08:00:00Z'), 'Europe/Madrid')).toEqual([
      { frequency: 'DAILY', period: 'D:2026-11-09' },
      { frequency: 'WEEKLY', period: 'W:2026-W46' },
    ]);
    expect(matching.digestPeriodsDue(new Date('2026-11-10T08:30:00Z'), 'Europe/Madrid')).toEqual([
      { frequency: 'DAILY', period: 'D:2026-11-10' },
    ]);
    // before the hour: nothing; later the same local day: still due (a missed sweep catches up, never twice)
    expect(matching.digestPeriodsDue(new Date('2026-11-10T07:30:00Z'), 'Europe/Madrid')).toEqual([]);
    expect(matching.digestPeriodsDue(new Date('2026-11-10T21:00:00Z'), 'Europe/Madrid')).toEqual([
      { frequency: 'DAILY', period: 'D:2026-11-10' },
    ]);
    expect(matching.digestPeriodsDue(new Date('2026-11-10T23:30:00Z'), 'Europe/Madrid')).toEqual([]);
    expect(matching.digestPeriodsDue(new Date('2026-11-10T09:00:00Z'), 'Europe/London')).toHaveLength(1);
    expect(matching.isoWeekOf('2027-01-01')).toBe('2026-W53');
    // the jobs take these periods (and nothing else)
    const pid = newId();
    for (const period of ['INSTANT', 'D:2026-11-09', 'W:2026-W46']) {
      expect(
        matching.deliveryJobs.deliverProfile.spec.payload.safeParse({ agencyId: o.agencyId, profileId: pid, period })
          .success,
      ).toBe(true);
    }
    for (const period of ['D:dddd-dd-dd', 'W:2026-46', 'X:1']) {
      expect(
        matching.deliveryJobs.deliverProfile.spec.payload.safeParse({ agencyId: o.agencyId, profileId: pid, period })
          .success,
      ).toBe(false);
    }
    expect(
      matching.deliveryJobs.deliverDigests.spec.payload.safeParse({
        agencyId: o.agencyId,
        frequency: 'DAILY',
        period: 'D:2026-11-09',
        day: '2026-11-09',
        after: null,
      }).success,
    ).toBe(true);

    const ci = await city();
    const c = await contact(o);
    const D = await profile(o, c.id, ci, { frequency: 'DAILY' });
    const W = await profile(o, (await contact(o)).id, ci, { frequency: 'WEEKLY' });
    await listing(o, ci);
    expect((await deliver(o, D, 'INSTANT')).outcome).toBe('OTHER_FREQUENCY');
    expect((await deliver(o, D, 'W:2026-W46')).outcome).toBe('OTHER_FREQUENCY');
    expect(await deliver(o, D, 'D:2026-11-09')).toMatchObject({ outcome: 'SENT', sent: 1 });
    await listing(o, ci);
    expect((await deliver(o, D, 'D:2026-11-09')).outcome).toBe('ALREADY_DELIVERED');
    expect(await deliver(o, D, 'D:2026-11-10')).toMatchObject({ outcome: 'SENT', sent: 1 });
    expect(await deliver(o, W, 'W:2026-W46')).toMatchObject({ outcome: 'SENT', sent: 2 });
    expect((await deliveries(D)).map((d) => d.period_key)).toEqual(['D:2026-11-09', 'D:2026-11-10']);
  });

  it('[R2-02e] caps: per contact and per agency a rolling day; capped matches wait', async () => {
    const ci = await city();
    const c = await contact(o);
    const P = await profile(o, c.id, ci);
    await listing(o, ci);
    expect((await deliver(o, P, 'INSTANT', { perContactPerDay: 1 })).outcome).toBe('SENT');
    await listing(o, ci);
    expect((await deliver(o, P, 'INSTANT', { perContactPerDay: 1 })).outcome).toBe('CAPPED');
    expect((await statuses(P)).filter((s) => s.status === 'QUEUED')).toHaveLength(1);
    const [{ n }] = (await rows<{ n: number }>(
      sql`select count(*)::int as n from client_profile_deliveries where agency_id = ${o.agencyId}
           and created_at >= now() - interval '1 day'`,
    )) as [{ n: number }];
    expect((await deliver(o, P, 'INSTANT', { perAgencyPerDay: n })).outcome).toBe('CAPPED');
    expect((await deliver(o, P, 'INSTANT', { perAgencyPerDay: n + 1 })).outcome).toBe('SENT');
    expect(mailsTo(c.email)).toHaveLength(2);
  });

  it('[R2-02e] a failed send stays PENDING and the retry sends it once with a new link (the first one stops)', async () => {
    const ci = await city();
    const c = await contact(o);
    const P = await profile(o, c.id, ci);
    await listing(o, ci);
    mail.failNext = 1;
    await expect(deliver(o, P)).rejects.toThrow('smtp down');
    const [d] = await deliveries(P);
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1 });
    const r = await deliver(o, P);
    expect(r).toMatchObject({ resent: true, outcome: 'NONE' });
    expect(mailsTo(c.email)).toHaveLength(1);
    expect((await deliveries(P))[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    expect(mailsTo(c.email)[0]?.idempotencyKey).toBe(`pdel:${d?.id}:2`);
    const link = linkIn(mailsTo(c.email)[0] as EmailMessage) as string;
    expect((await presentations.selectionPage(link.split('/s/')[1] as string)).items).toHaveLength(1);
    // and once more: nothing
    expect(await deliver(o, P)).toMatchObject({ resent: false, outcome: 'NONE' });
    expect(mailsTo(c.email)).toHaveLength(1);
  });

  it('[R2-02e] a failed send is not retried once the member revoked its selection or switched the profile off AUTO_SEND', async () => {
    const ci = await city();
    const c = await contact(o);
    const P = await profile(o, c.id, ci);
    const c2 = await contact(o);
    const P2 = await profile(o, c2.id, ci);
    await listing(o, ci);
    mail.failNext = 2;
    await expect(deliver(o, P)).rejects.toThrow('smtp down');
    await expect(deliver(o, P2)).rejects.toThrow('smtp down');
    const [d] = await deliveries(P);
    await system((tx) => tx.execute(sql`update selections set revoked_at = now() where id = ${d?.selection_id}`));
    expect(await deliver(o, P)).toMatchObject({ resent: false });
    const { version } = await as(o, (ctx) => matching.getClientProfile(ctx, P2));
    await as(o, (ctx) =>
      matching.updateClientProfile(ctx, P2, {
        version,
        mode: 'REVIEW',
        frequency: 'INSTANT',
        transactionType: 'SALE',
        propertyTypeIds: [ids.villa],
        locationIds: [ci],
        priceMaxCents: 90_000_000,
      }),
    );
    expect(await deliver(o, P2)).toMatchObject({ resent: false, outcome: 'NOT_AUTO_SEND' });
    expect(mailsTo(c.email)).toHaveLength(0);
    expect(mailsTo(c2.email)).toHaveLength(0);
    expect((await deliveries(P))[0]?.status).toBe('PENDING');
  });

  it('[R2-02e] members can read deliveries but never write one (worker-only)', async () => {
    const state = await withMemberCtx(
      { userId: o.userId, agencyId: o.agencyId, requestId: newId(), locale: 'en' },
      async (ctx) => {
        try {
          await ctx.tx.execute(
            sql`update client_profile_deliveries set status = 'SENT' where agency_id = ${o.agencyId}`,
          );
          return 'ok';
        } catch (err) {
          const e = err as { code?: string; cause?: { code?: string } };
          return e.code ?? e.cause?.code ?? 'unknown';
        }
      },
    );
    expect(state).toBe('42501');
  });
});
