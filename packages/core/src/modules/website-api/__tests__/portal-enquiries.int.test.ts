import { gunzipSync } from 'node:zlib';
import {
  CreateDevelopmentBody,
  CreateListingBody,
  CreateUnitsBody,
  SetDevelopmentAccessBody,
  UpdateListingBody,
  WebsiteLeadBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withPublicRead, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeRateLimit, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { configureStorage, createMemoryStore } from '@inmolink/platform/storage';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as developmentsModule from '../../developments';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../index';

/**
 * Portal enquiries and sitemaps (S15-02): an enquiry on an inmolink.es listing page is a marketplace lead — it reaches
 * the listing owner's CRM through the website lead intake with source MARKETPLACE — and the sitemaps the worker writes
 * list only what the portal shows (listed agencies' PUBLIC listings and open developments), per locale with hreflang.
 */

const RUN = newId().slice(-8).toLowerCase();
const slug = (s: string) => `${s}-pe-${RUN}`;
const ORIGIN = 'https://portal.test';
const log = createLogger({ service: 'portal-enquiries-test', level: 'silent' });
const jobCtx = (id: string) => ({
  log,
  jobId: id,
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

/** a: listed, owns the listings · c: published, then suspended (off the directory). */
let a: Founder;
let c: Founder;
let ids: { country: string; region: string; city: string; villa: string };
const L = { villa: '', shared: '', gone: '' };
let dev = '';
let mail: MemoryMailer;

const usedTokens = new Set<string>();
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    const fresh = !usedTokens.has(token);
    usedTokens.add(token);
    return (
      fresh &&
      token.startsWith('good') &&
      options.action === websiteApi.LEAD_TURNSTILE_ACTION &&
      (options.hostnames ?? []).includes('portal.test')
    );
  },
};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function listing(m: Founder, visibility: 'PUBLIC' | 'SHARED' = 'PUBLIC'): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents: 40_000_000,
        bedrooms: 3,
        energyRating: 'B',
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.saveListingTranslation(ctx, id, 'en', {
      version: (await properties.getListing(ctx, id)).version,
      title: `Home ${RUN}`,
      description: 'A bright home near the sea.',
    }),
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

const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;

const enquiry = (o: Partial<WebsiteLeadBody> = {}) =>
  WebsiteLeadBody.parse({
    name: 'Jane Buyer',
    email: `jane-${RUN}@example.com`,
    message: 'Is it still available?',
    privacyAccepted: true,
    marketingConsent: true,
    turnstileToken: `good-${newId()}`,
    ...o,
  });

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:portal-enq:${RUN}` });
  taxonomy.dropLocalTaxonomyCopies();
  websiteApi.resetPortalCaches();
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
    turnstile,
    portalOrigin: ORIGIN,
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  configureStorage(createMemoryStore());
  websiteApi.configurePortalSitemaps({ origin: ORIGIN });
  a = await createFounder({ companyName: `Enquiry Homes ${RUN}` });
  c = await createFounder({ companyName: `Gone Homes ${RUN}` });
  await setAgencyStatus(a.agencyId, 'VERIFIED');
  await setAgencyStatus(c.agencyId, 'VERIFIED');
  ids = await withSystem('portal-enquiries.test', async (tx) => {
    const name = (n: string, s: string) => [
      { locale: 'en', name: `${n} ${RUN}`, slug: slug(s) },
      { locale: 'es', name: `${n} ES ${RUN}`, slug: slug(`${s}-es`) },
    ];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: slug('c'),
      translations: name('Enquiryland', 'enquiryland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: slug('r'),
      translations: name('Coast', 'coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: slug('ci'),
      translations: name('Bay', 'bay'),
    });
    await taxonomy.createLocationGroup(tx, {
      key: slug('z'),
      translations: name('Bay Coast', 'bay-coast'),
      memberIds: [city],
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: slug('houses'),
      sort: 0,
      translations: name('Houses', 'houses'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: slug('villa'),
      sort: 0,
      translations: [
        { locale: 'en', name: `Villa ${RUN}`, slug: slug('villa') },
        { locale: 'es', name: `Chalet ${RUN}`, slug: slug('chalet') },
      ],
    });
    return { country, region, city, villa };
  });
  L.villa = await listing(a);
  L.shared = await listing(a, 'SHARED');
  L.gone = await listing(c);
  const created = await as(a, (ctx) =>
    developmentsModule.createDevelopment(
      ctx,
      CreateDevelopmentBody.parse({
        ref: slug('dv').toUpperCase(),
        name: `Harbour View ${RUN}`,
        status: 'UNDER_CONSTRUCTION',
        completionDate: '2027-06-30',
        locationId: ids.city,
        commission: { type: 'PCT', basisPoints: 400, includesVat: false },
      }),
    ),
  );
  dev = created.id;
  await as(a, (ctx) =>
    developmentsModule.setDevelopmentAccess(
      ctx,
      dev,
      SetDevelopmentAccessBody.parse({ version: created.version, kind: 'OPEN', allowedAgencyIds: [] }),
    ),
  );
  const units = await as(a, (ctx) =>
    developmentsModule.createUnits(
      ctx,
      dev,
      CreateUnitsBody.parse({
        units: [
          {
            ref: `U1-${RUN}`,
            status: 'AVAILABLE',
            priceCents: 30_000_000,
            bedrooms: 2,
            propertyTypeId: ids.villa,
            bathrooms: 1,
          },
        ],
      }),
    ),
  );
  await withSystem('portal-enquiries.test', async (tx) => {
    await search.rebuildReadModels(tx, 'LISTING', Object.values(L));
    await search.rebuildReadModels(
      tx,
      'UNIT',
      units.items.map((u) => u.id),
    );
  });
  await setAgencyStatus(c.agencyId, 'SUSPENDED');
  websiteApi.resetPortalCaches();
}, 180_000);

beforeEach(async () => {
  mail = createMemoryMailer();
  await configureEmail(mail);
});

afterAll(async () => {
  await closeEmail();
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

const submit = (code: string, body = enquiry(), key = `portal-${newId()}`) =>
  websiteApi.submitPortalLead({ locale: 'en', code, body }, { ip: '203.0.113.9', idempotencyKey: key });

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (err) {
    return isAppError(err) ? err.code : 'other';
  }
};

describe('portal enquiries (S15-02)', () => {
  it('[S15-02] portal lead routes to the listing owner with source MARKETPLACE', async () => {
    const code = await codeOf(L.villa);
    const { accepted, created, ownerAgencyId } = await submit(code);
    expect(created).toBe(true);
    expect(ownerAgencyId).toBe(a.agencyId);
    // The inbound row is the owner's, with no site (the portal), the owner's own reference.
    const inbound = await withSystem('portal-enquiries.test', (tx) =>
      tx.execute<{ agency_id: string; site_id: string | null; shown_ref: string; owner_agency_id: string | null }>(
        sql`select agency_id, site_id, shown_ref, owner_agency_id from website_leads where id = ${accepted.id}`,
      ),
    );
    expect(inbound.rows[0]).toMatchObject({ agency_id: a.agencyId, site_id: null, owner_agency_id: null });
    // The CRM promotion (the worker's job on `websites.lead.received`) puts it in the owner's inbox.
    const promoted = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: accepted.id });
    expect(promoted.created).toBe(true);
    const lead = await withTenant({ agencyId: a.agencyId }, (tx) =>
      tx.execute<{
        agency_id: string;
        source: string;
        presenting_agency_id: string | null;
        owner_agency_id: string | null;
        target_id: string;
        visitor_email: string;
      }>(
        sql`select agency_id, source, presenting_agency_id, owner_agency_id, target_id, visitor_email
              from leads where id = ${promoted.leadId}`,
      ),
    );
    expect(lead.rows[0]).toMatchObject({
      agency_id: a.agencyId,
      source: 'MARKETPLACE',
      presenting_agency_id: null,
      owner_agency_id: null,
      target_id: L.villa,
      visitor_email: `jane-${RUN}@example.com`,
    });
    // Promotion is idempotent (a redelivered event).
    expect((await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: accepted.id })).created).toBe(false);
  });

  it('[S15-02] the visitor gets no automatic reply (R1); the agency is notified, "via the Inmolink portal"', async () => {
    const { accepted } = await submit(await codeOf(L.villa));
    const ack = await websiteApi.websiteApiJobs.sendLeadAcknowledgement.spec.run(
      { eventId: newId(), leadId: accepted.id, agencyId: a.agencyId },
      jobCtx('ack'),
    );
    expect(ack).toMatchObject({ sent: false, skipped: 'PORTAL' });
    await websiteApi.websiteApiJobs.notifyLeadRecipient.spec.run(
      { leadId: accepted.id, agencyId: a.agencyId, recipient: a.userId },
      jobCtx('notify'),
    );
    expect(mail.sent.map((m) => m.to)).toEqual([a.email]);
    expect(JSON.stringify(mail.sent[0])).toMatch(/the Inmolink portal|el portal Inmolink/);
  });

  it('[S15-02] refused: a failed Turnstile check, a SHARED listing, an unlisted agency, a made-up code', async () => {
    const code = await codeOf(L.villa);
    expect(await refusal(submit(code, enquiry({ turnstileToken: 'bad-token' })))).toBe('TURNSTILE_FAILED');
    // A SHARED listing has no portal page (and may have no public code at all).
    const shared = await codeOf(L.shared);
    if (shared) expect(await refusal(submit(shared))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(submit(await codeOf(L.gone)))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(submit('ZZZZZZZZ'))).toBe('LISTING_NOT_FOUND');
    expect(await refusal(submit('not a code'))).toBe('LISTING_NOT_FOUND');
  });

  it('[S15-02] a double submit is one lead; the same key with another body is refused', async () => {
    const code = await codeOf(L.villa);
    const key = `portal-${newId()}`;
    const body = enquiry();
    const first = await submit(code, body, key);
    // The browser's second post reuses the (single-use) token: answered as the first lead.
    const again = await submit(code, body, key);
    expect(again).toMatchObject({ created: false, accepted: { id: first.accepted.id, replayed: true } });
    expect(await refusal(submit(code, enquiry({ message: 'Another question' }), key))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('[S15-02] enquiry posts are limited per client address, and per listing across addresses', async () => {
    const limiter = rateLimiter();
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    let allowed = 0;
    for (let i = 0; i < 50; i++) if ((await websiteApi.checkPortalLeadLimits(limiter, { ip })).allowed) allowed++;
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(50);
    // Many addresses at one listing: cut off at the listing's daily limit.
    const listing = await codeOf(L.villa);
    let atListing = 0;
    for (let i = 0; i < websiteApi.PORTAL_LEAD_LIMITS.perListingDay + 5; i++) {
      const res = await websiteApi.checkPortalLeadLimits(limiter, {
        ip: `10.${RUN.length}.${i >> 8}.${i & 255}`,
        code: listing,
      });
      if (res.allowed) atListing++;
    }
    expect(atListing).toBe(websiteApi.PORTAL_LEAD_LIMITS.perListingDay);
  });

  it('[S15-02] review: submitPortalLead applies the client’s limits itself (one call from the route), before Turnstile', async () => {
    const limiter = rateLimiter();
    const clientBucket = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    // A code of its own: the per-listing daily limit of the villa is spent by the test above.
    const code = Array.from(
      { length: 8 },
      () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)],
    ).join('');
    const answers: string[] = [];
    for (let i = 0; i < 30; i++) {
      answers.push(
        await refusal(
          websiteApi.submitPortalLead(
            // A bad token: refused by Turnstile once the limits pass, so no lead is written.
            { locale: 'en', code, body: enquiry({ turnstileToken: `bad-${newId()}` }) },
            { ip: clientBucket, clientBucket, idempotencyKey: `portal-${newId()}`, limiter },
          ),
        ),
      );
    }
    expect(answers[0]).toBe('TURNSTILE_FAILED');
    expect(answers).toContain('RATE_LIMITED');
    expect(answers.lastIndexOf('TURNSTILE_FAILED')).toBeLessThan(answers.indexOf('RATE_LIMITED'));
  });

  it('[S15-02] statement budgets: accepted 2, a double submit by its spent token 1, a failed visitor check 0', async () => {
    const code = await codeOf(L.villa);
    const key = `portal-${newId()}`;
    const body = enquiry();
    await submit(code, enquiry()); // warm: the listed-agency set and the agency profile are cached per process
    let first: Awaited<ReturnType<typeof submit>> | undefined;
    expect(
      await countQueries(async () => {
        first = await submit(code, body, key);
      }),
    ).toBeLessThanOrEqual(websiteApi.PORTAL_LEAD_STATEMENTS.accepted);
    expect(first?.created).toBe(true);
    // The browser's second post reuses the spent token: the remembered key's lead, one statement.
    let again: Awaited<ReturnType<typeof submit>> | undefined;
    expect(
      await countQueries(async () => {
        again = await submit(code, body, key);
      }),
    ).toBeLessThanOrEqual(websiteApi.PORTAL_LEAD_STATEMENTS.replayedToken);
    expect(again).toMatchObject({ created: false, accepted: { id: first?.accepted.id, replayed: true } });
    // A failed visitor check of a key never accepted: refused at once, no statement.
    let refused = '';
    expect(
      await countQueries(async () => {
        refused = await refusal(submit(code, enquiry({ turnstileToken: 'bad-token' })));
      }),
    ).toBe(websiteApi.PORTAL_LEAD_STATEMENTS.refused);
    expect(refused).toBe('TURNSTILE_FAILED');
  });
});

/** A stored sitemap file's XML. */
async function sitemapXml(name: string): Promise<string> {
  const file = await websiteApi.portalSitemapFile(name);
  expect(file, name).not.toBeNull();
  const stream = await file?.open();
  const chunks: Buffer[] = [];
  for await (const c of stream ?? []) chunks.push(c as Buffer);
  return gunzipSync(Buffer.concat(chunks)).toString('utf8');
}

describe('agency profile enquiries (S15-03)', () => {
  const submitToAgency = (agencyId: string, body = enquiry(), key = `portal-${newId()}`) =>
    websiteApi.submitPortalLead({ locale: 'en', agencyId, body }, { ip: '203.0.113.9', idempotencyKey: key });

  it('[S15-03] the profile’s contact form: a general MARKETPLACE lead for the listed agency, no listing', async () => {
    const key = `portal-${newId()}`;
    const { accepted, created, ownerAgencyId } = await submitToAgency(a.agencyId.toUpperCase(), enquiry(), key);
    expect(created).toBe(true);
    expect(ownerAgencyId).toBe(a.agencyId);
    const inbound = await withSystem('portal-enquiries.test', (tx) =>
      tx.execute<{ agency_id: string; site_id: string | null; target_kind: string | null; target_id: string | null }>(
        sql`select agency_id, site_id, target_kind, target_id from website_leads where id = ${accepted.id}`,
      ),
    );
    expect(inbound.rows[0]).toEqual({ agency_id: a.agencyId, site_id: null, target_kind: null, target_id: null });
    const promoted = await crm.promoteInboundLead({ agencyId: a.agencyId, inboundLeadId: accepted.id });
    const lead = await withTenant({ agencyId: a.agencyId }, (tx) =>
      tx.execute<{
        agency_id: string;
        source: string;
        target_id: string | null;
        presenting_agency_id: string | null;
        owner_agency_id: string | null;
      }>(
        sql`select agency_id, source, target_id, presenting_agency_id, owner_agency_id
              from leads where id = ${promoted.leadId}`,
      ),
    );
    // Routed to the agency itself: made to it directly (it presents itself), no listing, nobody introduced.
    expect(lead.rows[0]).toEqual({
      agency_id: a.agencyId,
      source: 'MARKETPLACE',
      target_id: null,
      presenting_agency_id: a.agencyId,
      owner_agency_id: null,
    });
    // The same key and body again: the first lead, not a second.
    const again = await submitToAgency(a.agencyId, enquiry(), key);
    expect(again).toMatchObject({ created: false, accepted: { id: accepted.id } });
  });

  it('[S15-03] an unlisted (suspended), unknown or malformed agency takes no enquiry', async () => {
    expect(await refusal(submitToAgency(c.agencyId))).toBe('NOT_FOUND');
    expect(await refusal(submitToAgency(newId()))).toBe('NOT_FOUND');
    expect(await refusal(submitToAgency('nope'))).toBe('NOT_FOUND');
  });
});

describe('portal sitemaps (S15-02)', () => {
  it('[S15-02] sitemaps validate and include only PUBLIC listings', async () => {
    websiteApi.resetPortalSitemapCache();
    const run = await websiteApi.generatePortalSitemaps({ log });
    expect(run.runId).toBeDefined();
    const index = await sitemapXml(websiteApi.PORTAL_SITEMAP_INDEX);
    expect(index).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/,
    );
    const names = [...index.matchAll(/<loc>https:\/\/portal\.test\/sitemaps\/([^<]+)<\/loc>/g)].map(
      (m) => m[1] as string,
    );
    for (const l of ['en', 'es']) {
      for (const part of ['listings', 'developments', 'places']) expect(names).toContain(`${l}-${part}-1.xml`);
    }
    const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sitemapXml(n)] as const)));
    for (const [name, xml] of Object.entries(files)) {
      // Well-formed per the protocol: one urlset with the sitemap and xhtml namespaces, every <url> closed, ≤ 10,000.
      expect(xml, name).toMatch(
        /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9" xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml">/,
      );
      expect(xml.match(/<url>/g)?.length ?? 0).toBe(xml.match(/<\/url>/g)?.length ?? 0);
      expect(xml.match(/<url>/g)?.length ?? 0).toBeLessThanOrEqual(websiteApi.PORTAL_SITEMAP_URLS);
      expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
    }
    // The test database holds other tests' stock too: a part may span several files.
    const part = (prefix: string) =>
      Object.entries(files)
        .filter(([n]) => n.startsWith(prefix))
        .map(([, x]) => x)
        .join('\n');
    const has = (text: string, s: string) => expect(text.includes(s), s).toBe(true);
    const all = Object.values(files).join('\n');
    const villa = (await codeOf(L.villa)).toLowerCase();
    // Each locale's URL is the listing page's own canonical and alternates (one core helper for both).
    const pageOf = async (l: string) => {
      const page = await websiteApi.portalListing({ locale: l, code: villa, requestId: newId() });
      expect(page, l).not.toBeNull();
      return page as NonNullable<typeof page>;
    };
    const [enPage, esPage] = [await pageOf('en'), await pageOf('es')];
    const en = `${ORIGIN}${enPage.paths.en}`;
    const es = `${ORIGIN}${esPage.paths.es}`;
    expect(enPage.paths).toEqual(esPage.paths);
    expect(en).toBe(`${ORIGIN}/en/property/villa-${RUN}-in-bay-${RUN}-${villa}`);
    expect(es).toBe(`${ORIGIN}/es/property/chalet-${RUN}-en-bay-es-${RUN}-${villa}`);
    // The PUBLIC listing of a listed agency, in each locale with its own type name, and hreflang alternates.
    has(part('en-listings-'), `<loc>${en}</loc>`);
    has(part('es-listings-'), `<loc>${es}</loc>`);
    has(part('en-listings-'), `<xhtml:link rel="alternate" hreflang="es" href="${es}"/>`);
    has(part('es-listings-'), `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>`);
    has(part('en-listings-'), `<xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>`);
    // Never a SHARED listing, nor an unlisted (suspended) agency's PUBLIC one.
    for (const id of [L.shared, L.gone]) {
      // A SHARED listing may have no public code at all.
      const code = (await codeOf(id))?.toLowerCase();
      if (code) expect(all.includes(`-${code}<`) || all.includes(`-${code}"`), code).toBe(false);
    }
    expect(await codeOf(L.gone)).toBeDefined();
    // The open development, the location pages down to its city, the zone; home and search.
    const devCode = (await codeOf(dev)).toLowerCase();
    has(part('en-developments-'), `/en/development/harbour-view-${RUN}-${devCode}</loc>`);
    has(
      part('en-places-'),
      `<loc>${ORIGIN}/en/properties/${slug('enquiryland')}/${slug('coast')}/${slug('bay')}</loc>`,
    );
    has(part('es-places-'), `<loc>${ORIGIN}/es/zone/${slug('bay-coast-es')}</loc>`);
    has(part('en-places-'), `<loc>${ORIGIN}/en</loc>`);
    has(part('en-places-'), `<loc>${ORIGIN}/en/properties</loc>`);
  }, 300_000);

  it('[S15-03] sitemaps list the profile pages of the listed agencies with stock on the portal, per locale', async () => {
    websiteApi.resetPortalSitemapCache();
    const run = await websiteApi.generatePortalSitemaps({ log });
    expect(run.urls?.agencies).toBeGreaterThan(0);
    const index = await sitemapXml(websiteApi.PORTAL_SITEMAP_INDEX);
    const names = [...index.matchAll(/<loc>https:\/\/portal\.test\/sitemaps\/([^<]+)<\/loc>/g)].map(
      (m) => m[1] as string,
    );
    const agencyFiles = names.filter((n) => /^[a-z]{2}-agencies-\d+\.xml$/.test(n));
    expect(agencyFiles).toEqual(expect.arrayContaining(['en-agencies-1.xml', 'es-agencies-1.xml']));
    for (const n of agencyFiles) expect(websiteApi.PORTAL_SITEMAP_FILE.test(n), n).toBe(true);
    const xml = (await Promise.all(agencyFiles.map(sitemapXml))).join('\n');
    // The page's own canonical and alternates (one core helper).
    const profile = await websiteApi.portalAgency('en', a.agencyId);
    const paths = profile?.paths ?? {};
    expect(xml).toContain(`<loc>${ORIGIN}${paths.en}</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}${paths.es}</loc>`);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="es" href="${ORIGIN}${paths.es}"/>`);
    // Never an unlisted (suspended) agency's page, though it once published.
    expect(xml).not.toContain(c.agencyId);
  }, 300_000);

  it('[S15-02] a new run serves at once; the previous run stays one more run (cached manifests), then goes', async () => {
    const first = await websiteApi.portalSitemapFile(websiteApi.PORTAL_SITEMAP_INDEX);
    await websiteApi.generatePortalSitemaps({ log });
    websiteApi.resetPortalSitemapCache();
    const second = await websiteApi.portalSitemapFile(websiteApi.PORTAL_SITEMAP_INDEX);
    expect(second?.sha256).toMatch(/^[A-Za-z0-9_-]+$/);
    // A process still holding the previous manifest can read its files…
    expect(await first?.open()).not.toBeNull();
    // …until the run after next.
    await websiteApi.generatePortalSitemaps({ log });
    expect(await first?.open().catch(() => null)).toBeNull();
    expect(await second?.open()).not.toBeNull();
    for (const bad of ['../current.json', 'en-listings-0.xml', 'xx.xml', 'en-listings-1.xml.gz', 'current.json']) {
      expect(await websiteApi.portalSitemapFile(bad), bad).toBeNull();
    }
  }, 300_000);
});
