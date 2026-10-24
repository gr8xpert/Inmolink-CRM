import { CreateListingBody, UpdateListingBody, type WebsiteLeadAccepted } from '@inmolink/contracts';
import { closeDb, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as identity from '@inmolink/core/modules/identity';
import * as properties from '@inmolink/core/modules/properties';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { countQueries, createFounder, type Founder, withSystem } from '@inmolink/core/test';
import { adminQuery, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail, type EmailMessage, type Mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { defaultSubscribers } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit, RateLimiter, rateLimitConnection } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { LEAD_BODY_LIMIT } from './routes/website-api/leads';

/**
 * Website lead intake over HTTP (S7-05): Turnstile for browser forms, idempotent posts, validation and size caps, form
 * spam limits, CORS — and speed-to-lead end to end: POST → outbox event → email queue (BullMQ) → acknowledgement sent
 * through the e-mail adapter, measured per lead; the agency's notification after the CRM promotion (S10-02).
 */

const RUN = newId().slice(-8);
const CURSOR_KEY = 'test-cursor-key-0123456789abcdef0123';
const ORIGIN = 'https://www.lead-site.example';
const LEADS_FOR_P95 = 20;
const prefix = `t:rl:leads:${RUN}`;
const queuePrefix = `leads${RUN}`;
const log = createLogger({ level: 'silent' });

let app: Awaited<ReturnType<typeof buildApp>>;
let founder: Founder;
let siteId: string;
let publishable: string;
let secret: string;
let pool: PoolHandle | undefined;

/** The e-mail adapter's test transport, stamping each message's arrival. */
const sent: { message: EmailMessage; at: number }[] = [];
const transport: Mailer = {
  async send(message) {
    sent.push({ message, at: performance.now() });
    return { id: String(sent.length) };
  },
  async close() {},
};

const used = new Set<string>();
const good = () => `good-${newId()}`;
let listingRef = '';
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    // Single-use, like Siteverify.
    const fresh = !used.has(token);
    used.add(token);
    return (
      fresh &&
      token.startsWith('good') &&
      options.action === 'website-lead' &&
      options.hostnames?.[0] === 'www.lead-site.example'
    );
  },
};

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Every test posts from a few addresses: the form-spam limits are wide unless a test narrows them. */
function configure(limits: Partial<websiteApi.WebsiteLimits> = {}) {
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: CURSOR_KEY,
    turnstile,
    limits: { leadsPerBrowser: 1_000, leadsPerBrowserDay: 1_000, ...limits },
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:feed-leads:${RUN}` });
  await configureRateLimit({ commandTimeoutMs: 5_000 });
  await configureQueue({ prefix: queuePrefix, logger: log });
  await configureEmail(transport);
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  configure();
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const ids = await withSystem('feed-api.leads.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `lf-${RUN}`,
      translations: name('Formland'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `lf-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `lf-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { country, villa };
  });
  const listingIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { id } = await as((ctx) =>
      properties.createListing(
        ctx,
        CreateListingBody.parse({
          propertyTypeId: ids.villa,
          locationId: ids.country,
          priceCents: 40_000_000 + i * 1_000_000,
          energyRating: 'B',
        }),
      ),
    );
    await as(async (ctx) =>
      properties.updateListing(
        ctx,
        id,
        UpdateListingBody.parse({
          status: 'ACTIVE',
          visibility: 'PUBLIC',
          version: (await properties.getListing(ctx, id)).version,
        }),
      ),
    );
    listingIds.push(id);
  }
  await withSystem('feed-api.leads.test', (tx) => search.rebuildReadModels(tx, 'LISTING', listingIds));
  listingRef = (await adminQuery<{ ref: string }>('select ref from properties where id = $1', [listingIds[0]]))[0]
    ?.ref as string;
  siteId = (
    await as((ctx) =>
      websites.createSite(ctx, {
        name: 'Lead site',
        domains: ['www.lead-site.example'],
        mode: 'WIDGET',
        inventoryPolicy: 'OWN_ONLY',
        inventoryFilters: null,
        referencePrefix: 'LS',
        locales: ['en', 'es'],
        contact: { name: 'Lead Site Homes', email: 'office@lead-site.example' },
      }),
    )
  ).id;
  const key = async (kind: 'SECRET' | 'PUBLISHABLE') =>
    (
      await as((ctx) =>
        identity.createApiKey(ctx, {
          name: `${kind} forms`,
          kind,
          scopes: ['listings:read', 'leads:write', 'viewing-requests:write'],
          allowedOrigins: kind === 'PUBLISHABLE' ? [ORIGIN] : [],
          siteId,
        }),
      )
    ).secret;
  publishable = await key('PUBLISHABLE');
  secret = await key('SECRET');
  const limiter = new RateLimiter({
    redis: rateLimitConnection(),
    prefix,
    logger: log,
    hmacKey: 'test-rate-limit-hmac-key-0123456789abcdef',
  });
  app = await buildApp({ logger: log, trustProxy: false, docsUi: false, limiter, checks: {} });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.close();
  try {
    for (const name of ['email', 'email.dead']) await queueFor(name).obliterate({ force: true });
    const redis = rateLimitConnection();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Not connected (setup failed): nothing to clean.
  }
  await closeQueues();
  await closeEmail();
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

beforeEach(() => configure());

const lead = (overrides: Record<string, unknown> = {}) => ({
  name: 'Ana Buyer',
  email: `ana-${newId().slice(-8)}@example.com`,
  privacyAccepted: true,
  message: 'Please call me.',
  ...overrides,
});

function post(
  url: string,
  body: unknown,
  opts: { key?: string; idem?: string | null; ip?: string; origin?: string | null; raw?: string } = {},
) {
  const browser = (opts.key ?? publishable) === publishable;
  return app.inject({
    method: 'POST',
    url,
    remoteAddress: opts.ip ?? '198.51.100.20',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key ?? publishable,
      ...(opts.idem === null ? {} : { 'idempotency-key': opts.idem ?? `form-${newId()}` }),
      ...(browser && opts.origin !== null ? { origin: opts.origin ?? ORIGIN } : {}),
    },
    payload: opts.raw ?? JSON.stringify(body),
  });
}

describe('website lead intake over HTTP (S7-05)', () => {
  it('[S7-05] a browser form posts with Turnstile; the same Idempotency-Key answers the same lead (201, then 200)', async () => {
    const idem = `form-${newId()}`;
    const body = lead({ turnstileToken: good() });
    const first = await post('/v2/leads', body, { idem });
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['access-control-allow-origin']).toBe(ORIGIN);
    const created = first.json() as WebsiteLeadAccepted;
    expect(created).toMatchObject({ kind: 'ENQUIRY', status: 'RECEIVED', replayed: false });
    // A double submit: the token was used, yet the same lead answers again.
    const again = await post('/v2/leads', { ...body, turnstileToken: 'spent' }, { idem });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ...created, replayed: true });
    const other = await post('/v2/leads', { ...body, message: 'Something else' }, { idem });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const rows = await adminQuery('select agency_id from website_leads where site_id = $1 and email = $2', [
      siteId,
      body.email,
    ]);
    expect(rows).toEqual([{ agency_id: founder.agencyId }]);
    // Without a solved token, or solved on another site: refused.
    expect((await post('/v2/leads', lead({ turnstileToken: 'bad' }))).json().error.code).toBe('TURNSTILE_FAILED');
    expect((await post('/v2/leads', lead())).statusCode).toBe(403);
    // The browser preflight lets the idempotency header through.
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v2/leads',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers['access-control-allow-headers']).toContain('Idempotency-Key');
  });

  it('[S7-05] every field is validated and size-capped; the Idempotency-Key is required', async () => {
    const code = async (res: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => {
      const r = await res;
      return `${r.statusCode} ${r.json().error.code}`;
    };
    const ok = { turnstileToken: good() };
    expect(await code(post('/v2/leads', lead(ok), { idem: null }))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead(ok), { idem: 'short' }))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead({ ...ok, message: 'x'.repeat(4_001) })))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead({ ...ok, name: 'Cheap pills http://spam.example' })))).toBe(
      '422 VALIDATION_FAILED',
    );
    expect(await code(post('/v2/leads', lead({ ...ok, email: 'not-an-email' })))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead({ ...ok, privacyAccepted: false })))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead({ ...ok, pageUrl: 'javascript:alert(1)' })))).toBe(
      '422 VALIDATION_FAILED',
    );
    expect(await code(post('/v2/leads', lead({ ...ok, isAdmin: true })))).toBe('422 VALIDATION_FAILED');
    expect(await code(post('/v2/leads', lead({ ...ok, lang: 'fr' })))).toBe('422 VALIDATION_FAILED');
    const tooBig = JSON.stringify(lead({ ...ok, message: 'y'.repeat(LEAD_BODY_LIMIT) }));
    expect(await code(post('/v2/leads', null, { raw: tooBig }))).toBe('413 PAYLOAD_TOO_LARGE');
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const slots = Array.from({ length: 4 }, (_, i) => ({ date: day(i + 1), timeOfDay: 'ANY' }));
    expect(await code(post('/v2/viewing-requests', lead({ ...ok, ref: 'LS-1', slots })))).toBe('422 VALIDATION_FAILED');
    const late = [{ date: day(400), timeOfDay: 'ANY' }];
    expect(await code(post('/v2/viewing-requests', lead({ ...ok, ref: 'LS-1', slots: late })))).toBe(
      '422 VALIDATION_FAILED',
    );
    // A viewing request needs a listing the site shows.
    expect(
      await code(
        post('/v2/viewing-requests', lead({ turnstileToken: good(), ref: 'NOPE-1', slots: slots.slice(0, 1) })),
      ),
    ).toBe('404 LISTING_NOT_FOUND');
  });

  it("[S8-05] the WordPress plugin's server-verified post (secret key, serverVerified) lands with the site's agency", async () => {
    const body = lead({ serverVerified: true, ref: listingRef, email: `wp-${newId()}@example.com` });
    const res = await post('/v2/leads', body, { key: secret });
    expect(res.statusCode).toBe(201);
    const rows = await adminQuery('select agency_id, verification, shown_ref from website_leads where id = $1', [
      (res.json() as WebsiteLeadAccepted).id,
    ]);
    expect(rows).toEqual([{ agency_id: founder.agencyId, verification: 'SERVER_KEY', shown_ref: listingRef }]);
    // A publishable key may not claim a server check (refused: the browser path needs its Turnstile token).
    expect((await post('/v2/leads', lead({ serverVerified: true }))).statusCode).toBe(422);
  });

  it('[S7-05] query budget: a new lead 2 statements, a replay 3, an unknown reference 1 (feed-api ≤ 3)', async () => {
    const body = lead({ serverVerified: true, ref: listingRef });
    const idem = `form-${newId()}`;
    const count = async (b: unknown, i = idem) => {
      let status = 0;
      const n = await countQueries(async () => {
        status = (await post('/v2/leads', b, { key: secret, idem: i })).statusCode;
      });
      return `${status}:${n}`;
    };
    // Warm the key and site caches (as on a live site).
    await post('/v2/leads', lead({ serverVerified: true }), { key: secret });
    expect(await count(body)).toBe('201:2');
    expect(await count(body)).toBe('200:3');
    expect(await count({ ...body, message: 'Other' })).toBe('422:3');
    expect(await count(lead({ serverVerified: true, ref: 'NOPE-123' }), `form-${newId()}`)).toBe('404:1');
    expect(await count(lead({ serverVerified: true }), `form-${newId()}`)).toBe('201:1');
  });

  it("[S7-05] form spam: a browser's lead posts are limited (429), other browsers keep posting", async () => {
    configure({ leadsPerBrowser: 2 });
    const ip = '203.0.113.99';
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await post('/v2/leads', lead({ turnstileToken: good() }), { ip })).statusCode);
    expect(statuses).toEqual([201, 201, 429]);
    expect((await post('/v2/leads', lead({ turnstileToken: good() }), { ip: '203.0.113.100' })).statusCode).toBe(201);
  });

  it('[S7-05] auto-ack is sent in < 60 s p95 (POST → outbox → email queue → e-mail adapter) and uses the site branding', async () => {
    websiteApi.registerWebsiteApiSubscriptions();
    // S10-02: the agency's notification follows the lead's promotion to the CRM inbox (`crm.lead.created`).
    crm.registerCrmSubscriptions();
    pool = registerPool(
      'email',
      [
        websiteApi.websiteApiJobs.sendLeadAcknowledgement,
        websiteApi.websiteApiJobs.notifyLeadAgency,
        websiteApi.websiteApiJobs.notifyLeadRecipient,
        crm.crmJobs.promoteInboundLead,
      ],
      {
        shutdownMs: 5_000,
      },
    );
    // The dispatcher's delivery, for this test's agency only (the shared test database's other events belong to
    // other test files): poll every 250 ms (ADR 0014), claim, hand to the subscribers, acknowledge.
    let dispatching = true;
    const dispatcher = (async () => {
      while (dispatching) {
        const claimed = await adminQuery<{
          id: string;
          agency_id: string;
          type: string;
          version: number;
          payload: unknown;
          created_at: Date;
        }>(
          `update outbox_events set processed_at = now(), attempts = attempts + 1
            where id in (select id from outbox_events
                          where agency_id = $1 and type in ('websites.lead.received', 'crm.lead.created')
                            and processed_at is null
                          order by available_at, id limit 50 for update skip locked)
           returning id, agency_id, type, version, payload, created_at`,
          [founder.agencyId],
        );
        for (const row of claimed) {
          for (const sub of defaultSubscribers.get(row.type, row.version)) {
            await sub.handler(sub.def.schema.parse(row.payload), {
              eventId: row.id,
              agencyId: row.agency_id,
              type: row.type,
              version: row.version,
              createdAt: new Date(row.created_at),
              attempt: 1,
            });
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    try {
      sent.length = 0;
      configure({ leadsPerKeyHour: { STANDARD: 1_000, HIGH: 1_000 } });
      const postedAt = new Map<string, number>();
      // A burst from the site's server (secret key, its own visitor check), all at once.
      await Promise.all(
        Array.from({ length: LEADS_FOR_P95 }, async (_, i) => {
          const body = lead({ serverVerified: true, lang: i % 2 ? 'es' : 'en' });
          const started = performance.now();
          const res = await post('/v2/leads', body, { key: secret });
          expect(res.statusCode).toBe(201);
          postedAt.set(body.email, started);
        }),
      );
      // This burst's acknowledgements (earlier tests' leads are delivered too, by the same poll).
      const acks = () => sent.filter((s) => s.message.tag === 'website.lead-ack' && postedAt.has(s.message.to));
      const deadline = Date.now() + 90_000;
      while (acks().length < LEADS_FOR_P95 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const latencies = acks()
        .map((s) => s.at - (postedAt.get(s.message.to) as number))
        .sort((x, y) => x - y);
      expect(latencies).toHaveLength(LEADS_FOR_P95);
      const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1] as number;
      console.info(
        `[S7-05] speed-to-lead: ${LEADS_FOR_P95} leads, p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] as number)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(latencies.at(-1) as number)} ms`,
      );
      expect(p95).toBeLessThan(60_000);
      // Branded as the site, in the visitor's language.
      const spanish = acks().find((s) => s.message.subject.startsWith('Hemos recibido'));
      expect(spanish?.message.subject).toBe('Hemos recibido su consulta – Lead Site Homes');
      expect(acks().some((s) => s.message.subject === 'We have received your enquiry – Lead Site Homes')).toBe(true);
      // The agency was told about each lead too.
      const notes = sent.filter((s) => s.message.tag === 'website.lead-notify');
      expect(notes.length).toBeGreaterThanOrEqual(1);
      expect(new Set(notes.map((s) => s.message.to))).toEqual(new Set(['office@lead-site.example']));
    } finally {
      dispatching = false;
      await dispatcher;
      websiteApi.unregisterWebsiteApiSubscriptions();
      crm.unregisterCrmSubscriptions();
    }
  }, 180_000);
});
