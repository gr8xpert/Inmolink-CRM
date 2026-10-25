import { readFileSync } from 'node:fs';
import { CreateContactBody, type CreateSiteInput, PlanQuota } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { restoreClock, useFakeClock } from '@inmolink/platform/clock';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as crm from '../../crm';
import * as websiteApi from '../../website-api';
import * as websites from '../../websites';
import * as billing from '../index';
import type { CatalogInput } from '../repo';

/**
 * Plan quotas and the website API notice period (S13-F21) with plans enforced, on the bundled catalog (PLAN §11):
 * each quota refuses the first item over the plan's limit with `PLAN_REQUIRED`; the create paths count before they
 * write; a downgraded agency's site keeps serving for the notice period, then answers `PLAN_REQUIRED` (402).
 */

const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('billing.quotas.int.test', fn);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, details: err.details };
    throw err;
  }
  return { code: 'accepted' };
}

const SITE: CreateSiteInput = {
  name: 'Quota site',
  domains: [],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: null,
  locales: ['en'],
  contact: null,
};

const catalog = JSON.parse(
  readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
) as { items: CatalogInput[] };
const limitsOf = (code: string) => catalog.items.find((i) => i.code === code)?.limits ?? {};

/** The plan a quota's first item over the limit needs (PLAN §11); a quota a plan does not list is unlimited. */
const REQUIRED: Record<string, Partial<Record<PlanQuota, string>>> = {
  free: { sites: 'pro', social_accounts: 'pro', crm_contacts: 'pro', studio_listings_month: 'pro' },
  pro: { sites: 'business', social_accounts: 'business' },
  business: { sites: 'enterprise', social_accounts: 'enterprise' },
  enterprise: {},
};

let superAdmin: string;
const CURSOR_KEY = 'quota-test-cursor-key-0123456789abcdef';

/**
 * The tier a refusal names. The shared test database may hold plans other test files added (random codes): the
 * cheapest offered plan that fits is then one of those or the catalog's (the exact tier is the unit test's, on the
 * catalog alone — `plan.test.ts`).
 */
const CATALOG_CODES = new Set(catalog.items.map((i) => i.code));
const expectedTier = (tier: string | undefined) =>
  expect.toSatisfy((v: unknown) => v === tier || (typeof v === 'string' && !CATALOG_CODES.has(v)));

async function onPlan(planCode: string): Promise<Founder> {
  const m = await createFounder();
  if (planCode === 'free') return m;
  await withStaffCtx({ userId: superAdmin, requestId: newId(), reason: 'quota test' }, (ctx) =>
    billing.grantPlan(ctx, {
      agencyId: m.agencyId,
      planCode,
      endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      reason: 'quota test plan',
    }),
  );
  return m;
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  billing.configureBilling({ enforcePlans: true });
  websites.configureWebsites({ planNoticeDays: 30 });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: CURSOR_KEY,
    enforcePlans: true,
  });
  await system((tx) => billing.upsertCatalog(tx, catalog.items, newId));
  superAdmin = (await createStaffUser('SUPER_ADMIN')).userId;
}, 180_000);

afterEach(() => {
  restoreClock();
  billing.configureBilling({ enforcePlans: true });
});

afterAll(async () => {
  websites.configureWebsites({});
  billing.configureBilling({});
  await closeDb();
});

describe('plan quotas (S13-F21)', () => {
  it('[S13-F21] each quota refuses the first item over the plan limit with PLAN_REQUIRED (table from the catalog)', async () => {
    expect(Object.keys(REQUIRED)).toEqual(['free', 'pro', 'business', 'enterprise']);
    for (const [plan, required] of Object.entries(REQUIRED)) {
      const m = await onPlan(plan);
      const limits = limitsOf(plan) as Partial<Record<PlanQuota, number>>;
      for (const quota of PlanQuota.options) {
        const limit = limits[quota];
        const at = `${plan}/${quota}`;
        if (limit === undefined) {
          expect(required[quota], at).toBeUndefined();
          expect((await refusal(as(m, (ctx) => billing.requireQuota(ctx, quota, 1_000_000)))).code, at).toBe(
            'accepted',
          );
          continue;
        }
        // The last item within the limit is accepted; the first one over it is refused.
        if (limit > 0) {
          expect((await refusal(as(m, (ctx) => billing.requireQuota(ctx, quota, limit - 1)))).code, at).toBe(
            'accepted',
          );
        }
        expect(await refusal(as(m, (ctx) => billing.requireQuota(ctx, quota, limit))), at).toEqual({
          code: 'PLAN_REQUIRED',
          details: { reason: 'quota', quota, plan, limit, requiredPlan: expectedTier(required[quota]) },
        });
        // Several at once: refused when the batch would cross the limit.
        if (limit > 0) {
          expect((await refusal(as(m, (ctx) => billing.requireQuota(ctx, quota, limit - 1, 2)))).code, at).toBe(
            'PLAN_REQUIRED',
          );
        }
      }
    }
  });

  it('[S13-F21] a counter is only run when the plan has a limit, and is told the limit', async () => {
    const pro = await onPlan('pro');
    const asked: number[] = [];
    const counter = async (limit: number) => {
      asked.push(limit);
      return 0;
    };
    await as(pro, (ctx) => billing.requireQuota(ctx, 'crm_contacts', counter));
    expect(asked).toEqual([]);
    const free = await onPlan('free');
    await as(free, (ctx) => billing.requireQuota(ctx, 'crm_contacts', counter));
    expect(asked).toEqual([100]);
  });

  it('[S13-F21] create paths count before writing: a Pro agency gets one site; a Free CRM 100 contacts', async () => {
    const pro = await onPlan('pro');
    await setAgencyStatus(pro.agencyId, 'VERIFIED');
    expect((await refusal(as(pro, (ctx) => websites.createSite(ctx, SITE)))).code).toBe('accepted');
    expect(await refusal(as(pro, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Second' })))).toEqual({
      code: 'PLAN_REQUIRED',
      details: { reason: 'quota', quota: 'sites', plan: 'pro', limit: 1, requiredPlan: expectedTier('business') },
    });
    expect((await as(pro, (ctx) => websites.listSites(ctx, { limit: 10 }))).items).toHaveLength(1);

    const free = await onPlan('free');
    await system((tx) =>
      tx.execute(sql`insert into contacts (id, agency_id, first_name)
        select gen_random_uuid(), ${free.agencyId}::uuid, 'Seeded ' || g from generate_series(1, 99) g`),
    );
    const contact = (firstName: string) =>
      as(free, (ctx) => crm.createContact(ctx, CreateContactBody.parse({ firstName })));
    expect((await refusal(contact('Hundredth'))).code).toBe('accepted');
    expect(await refusal(contact('Over'))).toEqual({
      code: 'PLAN_REQUIRED',
      details: { reason: 'quota', quota: 'crm_contacts', plan: 'free', limit: 100, requiredPlan: expectedTier('pro') },
    });
    // A removed contact frees its place.
    await system((tx) =>
      tx.execute(sql`update contacts set deleted_at = now()
        where id = (select id from contacts where agency_id = ${free.agencyId}::uuid limit 1)`),
    );
    expect((await refusal(contact('Back in'))).code).toBe('accepted');
  });

  it('[S13-F21] statements: a quota check is one (plus the counter), none with the plan passed and no limit', async () => {
    const pro = await onPlan('pro');
    const free = await onPlan('free');
    const count = (m: Founder, fn: (ctx: Ctx) => Promise<unknown>) => as(m, (ctx) => countQueries(() => fn(ctx)));
    expect(await count(pro, (ctx) => billing.requireQuota(ctx, 'sites', 0))).toBe(1);
    expect(await count(free, (ctx) => billing.requireQuota(ctx, 'crm_contacts', async () => 0))).toBe(1);
    expect(await count(pro, (ctx) => billing.requirePlan(ctx, 'website_api'))).toBe(1);
    const plan = await as(pro, (ctx) => billing.requirePlan(ctx, 'website_api'));
    expect(await count(pro, (ctx) => billing.requireQuota(ctx, 'crm_contacts', 0, 1, { plan }))).toBe(0);
    expect(await count(pro, (ctx) => billing.requireQuota(ctx, 'sites', 0, 1, { plan }))).toBe(1);
    // A whole create: enforced plans add two statements to a site create (the plan, the add-on units).
    await setAgencyStatus(pro.agencyId, 'VERIFIED');
    const create = (name: string) => count(pro, (ctx) => websites.createSite(ctx, { ...SITE, name }));
    billing.configureBilling({});
    const open = await create('Unenforced');
    await system((tx) => tx.execute(sql`delete from website_sites where agency_id = ${pro.agencyId}::uuid`));
    billing.configureBilling({ enforcePlans: true });
    expect((await create('Enforced')) - open).toBe(2);
  });

  it('[S13-F21] plans not enforced: no quota applies', async () => {
    const free = await onPlan('free');
    billing.configureBilling({});
    expect((await refusal(as(free, (ctx) => billing.requireQuota(ctx, 'crm_contacts', 1_000)))).code).toBe('accepted');
  });
});

describe('website API after a downgrade (S13-F21)', () => {
  it('[S13-F21] a downgraded agency site serves until the notice ends, then refuses with PLAN_REQUIRED', async () => {
    const m = await onPlan('pro');
    await setAgencyStatus(m.agencyId, 'VERIFIED');
    const site = await as(m, (ctx) => websites.createSite(ctx, SITE));
    const serve = async () => websiteApi.apiSiteOf(await websites.siteScope(site.id), null, newId());

    // On Pro: the plan is recorded on the site (AI budgets), no cut-off.
    expect(await websites.syncSitePlan(m.agencyId)).toEqual({ changed: 1 });
    expect(await serve()).toMatchObject({ plan: 'pro', scope: { planEndsAt: null } });

    // The grant is revoked: the agency is on Free, which has no website API.
    await system((tx) =>
      tx.execute(sql`update billing_plan_grants set revoked_at = now() where agency_id = ${m.agencyId}::uuid`),
    );
    const before = Date.now();
    expect(await websites.syncSitePlan(m.agencyId)).toEqual({ changed: 1 });
    const scope = await websites.siteScope(site.id);
    expect(scope.plan).toBe('free');
    const endsAt = Date.parse(scope.planEndsAt as string);
    expect(endsAt - before).toBeGreaterThanOrEqual(30 * 86_400_000 - 1_000);
    expect(endsAt - before).toBeLessThanOrEqual(30 * 86_400_000 + 60_000);
    // A later sync never extends the notice.
    expect(await websites.syncSitePlan(m.agencyId)).toEqual({ changed: 0 });

    // During the notice period the site serves.
    const clock = useFakeClock(endsAt - 60_000);
    expect((await serve()).plan).toBe('free');
    // From its end: 402.
    clock.set(endsAt);
    expect(await refusal(serve())).toEqual({ code: 'PLAN_REQUIRED', details: { feature: 'website_api' } });
    // feed-api with BILLING_ENFORCE_PLANS off: the cut-off is not applied.
    websiteApi.configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: CURSOR_KEY });
    expect((await refusal(serve())).code).toBe('accepted');
    websiteApi.configureWebsiteApi({
      mediaBaseUrl: 'https://media.example',
      cursorKey: CURSOR_KEY,
      enforcePlans: true,
    });
    restoreClock();
    // Each change was announced per site (edge purge now and at the cut-off).
    const announced = await system(async (tx) =>
      (
        await tx.execute<{ ends_at: string | null }>(sql`select payload->>'endsAt' as ends_at from outbox_events
          where type = 'websites.site.planChanged' and payload->>'siteId' = ${site.id} order by id`)
      ).rows.map((r) => r.ends_at),
    );
    expect(announced).toEqual([null, expect.any(String)]);

    // A member cannot lift the cut-off (the guard keeps the plan columns to the worker).
    await expect(
      as(m, (ctx) =>
        ctx.tx.execute(sql`update website_sites set plan_ends_at = null, version = version + 1
        where id = ${site.id}::uuid`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501', message: expect.stringContaining('plan columns') } });

    // Upgrading again (a new grant) clears the cut-off.
    await withStaffCtx({ userId: superAdmin, requestId: newId(), reason: 'quota test' }, (ctx) =>
      billing.grantPlan(ctx, {
        agencyId: m.agencyId,
        planCode: 'business',
        endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        reason: 'upgrade',
      }),
    );
    expect(await websites.syncSitePlan(m.agencyId)).toEqual({ changed: 1 });
    expect(await serve()).toMatchObject({ plan: 'business', scope: { planEndsAt: null } });
  });

  it('[S13-F21] plans not enforced: a Free agency site gets no cut-off', async () => {
    const m = await onPlan('pro');
    const site = await as(m, (ctx) => websites.createSite(ctx, SITE));
    await system((tx) =>
      tx.execute(sql`update billing_plan_grants set revoked_at = now() where agency_id = ${m.agencyId}::uuid`),
    );
    billing.configureBilling({});
    await websites.syncSitePlan(m.agencyId);
    expect(await websites.siteScope(site.id)).toMatchObject({ plan: 'free', planEndsAt: null });
  });
});
