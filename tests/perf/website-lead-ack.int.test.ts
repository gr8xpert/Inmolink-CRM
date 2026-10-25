import { performance } from 'node:perf_hooks';
import { createOutboxDispatcher, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as identity from '@inmolink/core/modules/identity';
import * as search from '@inmolink/core/modules/search';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { closeEmail, configureEmail, type EmailMessage, type Mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { Dispatcher } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, type PoolHandle, queueFor, registerPool } from '@inmolink/platform/queue';
import { closeRateLimit, configureRateLimit, RateLimiter, rateLimitConnection } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/feed-api/src/app';

/**
 * S7-05 budget, timed here (S12-F19: wall-clock budgets run in the perf project; the int run keeps the delivery,
 * branding and agency notification in apps/feed-api/src/leads.int.test.ts): speed-to-lead end to end — a burst of 20
 * website leads posted by the site's server (secret key), each acknowledged to the visitor at p95 < 60 s: POST →
 * outbox (the dispatcher, scoped to this suite's agency) → email queue (BullMQ) → the e-mail adapter.
 */

const RUN = newId().slice(-8);
const LEADS = 20;
const prefix = `t:rl:perf-leads:${RUN}`;
const log = createLogger({ level: 'silent' });

let app: Awaited<ReturnType<typeof buildApp>>;
let founder: Founder;
let secret: string;
let pool: PoolHandle | undefined;
let dispatcher: Dispatcher | undefined;

/** The e-mail adapter's test transport, stamping each message's arrival. */
const sent: { message: EmailMessage; at: number }[] = [];
const transport: Mailer = {
  async send(message) {
    sent.push({ message, at: performance.now() });
    return { id: String(sent.length) };
  },
  async close() {},
};

const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:perf-leads:${RUN}` });
  await configureRateLimit({ commandTimeoutMs: 5_000 });
  await configureQueue({ prefix: `perfleads${RUN}`, logger: log });
  await configureEmail(transport);
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
    turnstile: { verify: async () => false },
    limits: { leadsPerBrowser: 1_000, leadsPerBrowserDay: 1_000, leadsPerKeyHour: { STANDARD: 1_000, HIGH: 1_000 } },
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const siteId = (
    await as((ctx) =>
      websites.createSite(ctx, {
        name: 'Lead site',
        domains: [`www.perf-lead-site-${RUN}.example`],
        mode: 'WIDGET',
        inventoryPolicy: 'OWN_ONLY',
        inventoryFilters: null,
        referencePrefix: 'LS',
        locales: ['en', 'es'],
        contact: { name: 'Lead Site Homes', email: 'office@lead-site.example' },
      }),
    )
  ).id;
  secret = (
    await as((ctx) =>
      identity.createApiKey(ctx, {
        name: 'SECRET forms',
        kind: 'SECRET',
        scopes: ['listings:read', 'leads:write'],
        allowedOrigins: [],
        siteId,
      }),
    )
  ).secret;
  const limiter = new RateLimiter({
    redis: rateLimitConnection(),
    prefix,
    logger: log,
    hmacKey: 'test-rate-limit-hmac-key-0123456789abcdef',
  });
  app = await buildApp({ logger: log, trustProxy: false, docsUi: false, limiter, checks: {} });

  websiteApi.registerWebsiteApiSubscriptions();
  crm.registerCrmSubscriptions();
  pool = registerPool(
    'email',
    [
      websiteApi.websiteApiJobs.sendLeadAcknowledgement,
      websiteApi.websiteApiJobs.notifyLeadAgency,
      websiteApi.websiteApiJobs.notifyLeadRecipient,
      crm.crmJobs.promoteInboundLead,
    ],
    { shutdownMs: 5_000 },
  );
  dispatcher = createOutboxDispatcher({ logger: log, agencyIds: [founder.agencyId] });
  await dispatcher.start();
}, 240_000);

afterAll(async () => {
  await dispatcher?.stop();
  await app?.close();
  await pool?.close();
  websiteApi.unregisterWebsiteApiSubscriptions();
  crm.unregisterCrmSubscriptions();
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

it('[S7-05] auto-ack is sent in < 60 s p95 (POST → outbox → email queue → e-mail adapter)', async () => {
  const postedAt = new Map<string, number>();
  await Promise.all(
    Array.from({ length: LEADS }, async (_, i) => {
      const email = `ana-${newId().slice(-8)}@example.com`;
      const started = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: '/v2/leads',
        remoteAddress: '198.51.100.20',
        headers: { 'content-type': 'application/json', 'x-api-key': secret, 'idempotency-key': `form-${newId()}` },
        payload: JSON.stringify({
          name: 'Ana Buyer',
          email,
          privacyAccepted: true,
          message: 'Please call me.',
          serverVerified: true,
          lang: i % 2 ? 'es' : 'en',
        }),
      });
      expect(res.statusCode).toBe(201);
      postedAt.set(email, started);
    }),
  );
  const acks = () => sent.filter((s) => s.message.tag === 'website.lead-ack' && postedAt.has(s.message.to));
  const deadline = Date.now() + 90_000;
  while (acks().length < LEADS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const latencies = acks()
    .map((s) => s.at - (postedAt.get(s.message.to) as number))
    .sort((x, y) => x - y);
  expect(latencies).toHaveLength(LEADS);
  const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1] as number;
  console.info(
    `[S7-05] speed-to-lead: ${LEADS} leads, p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] as number)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(latencies.at(-1) as number)} ms`,
  );
  expect(p95).toBeLessThan(60_000);
}, 180_000);
