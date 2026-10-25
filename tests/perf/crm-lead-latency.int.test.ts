import { CreateListingBody, type CreateSiteInput, UpdateListingBody } from '@inmolink/contracts';
import { createOutboxDispatcher, withMemberCtx } from '@inmolink/core';
import * as crm from '@inmolink/core/modules/crm';
import * as properties from '@inmolink/core/modules/properties';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, type Founder } from '@inmolink/core/test';
import { closeDb, withIntake, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { Dispatcher } from '@inmolink/platform/outbox';
import { closeQueues, configureQueue, type PoolHandle, registerPool } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * S10-02 budget, timed here (S12-F19: wall-clock budgets run in the perf project; the int run keeps the routing,
 * assignment and inbox checks in packages/core/src/modules/crm/__tests__/leads.int.test.ts): a burst of 20 website
 * leads — half about a partner's network listing — lands in the presenting agency's inbox at p95 < 10 s, on the
 * production path: `websites.lead.received` → outbox dispatcher (scoped to this suite's agency) → the
 * `crm.promoteInboundLead` job on the `email` pool with the worker's options.
 */

const RUN = newId().slice(-8).toLowerCase();
const LEADS = 20;
const log = createLogger({ service: 'crm-lead-latency', level: 'silent' });
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('perf.crm-lead-latency', fn);

let a: Founder;
let b: Founder;
let siteId: string;
let bListing: string;
let dispatcher: Dispatcher | undefined;
let pool: PoolHandle | undefined;

const as = <T>(m: Founder, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

/** A website form's lead on `a`'s site, through the intake path (`app_intake`, with its `websites.lead.received`). */
async function inbound(target: { kind: 'LISTING'; id: string; ownerAgencyId: string; shownRef: string } | null) {
  const id = newId();
  await withIntake({ agencyId: a.agencyId }, (tx) =>
    websites.recordInboundLead(tx, {
      id,
      agencyId: a.agencyId,
      siteId,
      kind: 'ENQUIRY',
      idempotencyHash: `idem-${id}`,
      requestHash: 'x',
      verification: 'SERVER_KEY',
      target,
      locale: 'en',
      name: 'Vera Visitor',
      email: `visitor-${id.slice(-6)}-${RUN}@example.com`,
      emailHash: `h-${id}`,
      keyTier: 'STANDARD',
      phone: null,
      message: 'Is the villa still available?',
      viewingSlots: null,
      marketingConsent: true,
      pageUrl: null,
    }),
  );
  return id;
}

beforeAll(async () => {
  await setupTestDb('worker');
  [a, b] = await Promise.all([createFounder(), createFounder()]);
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  const ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: `${n.toLowerCase()}-${RUN}` }];
    const city = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: `perf-ld-${RUN}`,
      translations: name('Leadcountry'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: `perf-ld-g-${RUN}`,
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: `perf-ld-v-${RUN}`,
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  const { id } = await as(b, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents: 50_000_000 }),
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
  bListing = id;
  const site: CreateSiteInput = {
    name: 'Lead Homes web',
    domains: [`www.perf-lead-homes-${RUN}.example`],
    mode: 'WP_PLUGIN',
    inventoryPolicy: 'OWN_ONLY',
    inventoryFilters: null,
    referencePrefix: 'LH',
    locales: ['en', 'es'],
    contact: { name: 'Lead Homes', email: 'office@lead-homes.example', phone: '+34 600 000 002' },
  };
  siteId = (await as(a, (ctx) => websites.createSite(ctx, site))).id;

  await configureQueue({ prefix: `perf-crmleads-${RUN}`, logger: log });
  crm.registerCrmSubscriptions();
  // the worker's email pool options (`apps/worker` POOL_OPTIONS): a waiting promotion re-polls within 1 s
  pool = registerPool('email', [crm.crmJobs.promoteInboundLead], {
    shutdownMs: 5_000,
    groupRetryMs: 100,
    groupRetryMaxMs: 1_000,
  });
  dispatcher = createOutboxDispatcher({ logger: log, agencyIds: [a.agencyId] });
  await dispatcher.start();
}, 180_000);

afterAll(async () => {
  await dispatcher?.stop();
  await pool?.close();
  crm.unregisterCrmSubscriptions();
  await closeQueues();
  await closeDb();
});

it('[S10-02] website lead lands in the right agency inbox in < 10 s p95 (event → outbox → promote job)', async () => {
  const inboundIds = await Promise.all(
    Array.from({ length: LEADS }, (_, i) =>
      inbound(i % 2 ? { kind: 'LISTING', id: bListing, ownerAgencyId: b.agencyId, shownRef: 'LH-X1' } : null),
    ),
  );
  const deadline = Date.now() + 60_000;
  let landed: { latency_ms: number; agency_id: string }[] = [];
  while (Date.now() < deadline) {
    landed = await system(
      async (tx) =>
        (
          await tx.execute(sql`
            select l.agency_id, extract(epoch from (l.created_at - w.created_at)) * 1000 as latency_ms
              from leads l join website_leads w on w.id = l.inbound_lead_id
             where l.inbound_lead_id = any(${sql.param(inboundIds)}::uuid[])`)
        ).rows as { latency_ms: number; agency_id: string }[],
    );
    if (landed.length === LEADS) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(landed).toHaveLength(LEADS);
  expect(new Set(landed.map((l) => l.agency_id))).toEqual(new Set([a.agencyId]));
  const latencies = landed.map((l) => Number(l.latency_ms)).sort((x, y) => x - y);
  const p95 = latencies[Math.ceil(0.95 * latencies.length) - 1] as number;
  console.info(
    `[S10-02] website lead → inbox: ${LEADS} leads, p50 ${Math.round(latencies[Math.floor(latencies.length / 2)] as number)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(latencies.at(-1) as number)} ms`,
  );
  expect(p95).toBeLessThan(10_000);
}, 120_000);
