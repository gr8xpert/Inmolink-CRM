import { readFileSync } from 'node:fs';
import type { CreateSiteInput, PlanFeature } from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx, StaffCtx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { createFounder, type Founder } from '../../../testing/factories';
import * as identity from '../../identity';
import * as websites from '../../websites';
import * as billing from '../index';
import * as repo from '../repo';

/**
 * Plan gates, seats, trial and staff grants (S13-02) with plans enforced, on the bundled catalog (PLAN §11 matrix):
 * gated features answer `PLAN_REQUIRED` with the cheapest tier that has them, seats follow the plan, a new agency's
 * trial ends in Free with its data intact, staff grant and revoke plans.
 */

const log = createLogger({ service: 'billing-plans-int', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('billing.plans.int.test', fn);
const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const asStaff = <T>(userId: string, fn: (ctx: StaffCtx) => Promise<T>) =>
  withStaffCtx({ userId, requestId: newId(), reason: 'billing plans test' }, fn);

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
  name: 'Trial site',
  domains: [],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_ONLY',
  inventoryFilters: null,
  referencePrefix: null,
  locales: ['en'],
  contact: null,
};

/** The cheapest tier of each gated feature (PLAN §11). */
const REQUIRED_TIER: Record<PlanFeature, string> = {
  website_api: 'pro',
  portal_exports: 'pro',
  new_builds_full: 'pro',
  crm_full: 'pro',
  client_matching: 'pro',
  speed_to_lead: 'pro',
  social_posting: 'pro',
  pdfs_and_forms: 'pro',
  client_portal: 'pro',
  reports_standard: 'pro',
  crm_automations: 'business',
  matching_auto_send: 'business',
  chat_agent: 'business',
  crm_copilot: 'business',
  email_campaigns: 'business',
  ai_video: 'business',
  reports_advanced: 'business',
};

const planEvents = (agencyId: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ plan: string; reason: string }>(
      sql`select payload->>'plan' as plan, payload->>'reason' as reason from outbox_events
          where type = 'billing.plan.changed' and agency_id = ${agencyId}::uuid order by id`,
    );
    return r.rows;
  });

const invite = (m: Founder) =>
  as(m, (ctx) => identity.inviteMember(ctx, { email: `agent-${newId().slice(-12)}@example.com`, role: 'AGENT' }));

let superAdmin: string;

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  billing.configureBilling({ enforcePlans: true, trial: { planCode: 'pro', days: 14 }, dunningGraceDays: 14 });
  const file = JSON.parse(
    readFileSync(new URL('../../../../../../scripts/ops/billing-catalog.json', import.meta.url), 'utf8'),
  ) as { items: repo.CatalogInput[] };
  await system((tx) => billing.upsertCatalog(tx, file.items, newId));
  superAdmin = (await createStaffUser('SUPER_ADMIN')).userId;
}, 180_000);

afterAll(async () => {
  await closeDb();
});

describe('plan gates (S13-02)', () => {
  it('[S13-02] each gated feature returns PLAN_REQUIRED with the required tier (table from the plan matrix)', async () => {
    const free = await createFounder();
    const business = await createFounder();
    await asStaff(superAdmin, (ctx) =>
      billing.grantPlan(ctx, {
        agencyId: business.agencyId,
        planCode: 'business',
        endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        reason: 'pilot agency',
      }),
    );
    for (const [feature, tier] of Object.entries(REQUIRED_TIER) as [PlanFeature, string][]) {
      const refused = await refusal(as(free, (ctx) => billing.requirePlan(ctx, feature)));
      expect(refused, feature).toEqual({
        code: 'PLAN_REQUIRED',
        details: { feature, plan: 'free', requiredPlan: tier },
      });
      expect((await refusal(as(business, (ctx) => billing.requirePlan(ctx, feature)))).code, feature).toBe('accepted');
    }
  });

  it('[S13-02] a gated use case refuses before writing: a Free agency cannot create a website API site', async () => {
    const m = await createFounder();
    await setAgencyStatus(m.agencyId, 'VERIFIED');
    expect(await refusal(as(m, (ctx) => websites.createSite(ctx, SITE)))).toEqual({
      code: 'PLAN_REQUIRED',
      details: { feature: 'website_api', plan: 'free', requiredPlan: 'pro' },
    });
    const sites = await as(m, (ctx) => websites.listSites(ctx, { limit: 10 }));
    expect(sites.items).toEqual([]);
  });

  it('[S13-02] seats follow the plan: Free has one, a Pro grant four', async () => {
    const m = await createFounder();
    expect(await refusal(invite(m))).toEqual({
      code: 'PLAN_REQUIRED',
      details: { reason: 'seats', plan: 'free', seats: 1 },
    });
    await asStaff(superAdmin, (ctx) =>
      billing.grantPlan(ctx, {
        agencyId: m.agencyId,
        planCode: 'pro',
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'support goodwill',
      }),
    );
    for (let i = 0; i < 3; i++) expect((await refusal(invite(m))).code).toBe('accepted');
    // 1 member + 3 open invites = the 4 seats of Pro.
    expect((await refusal(invite(m))).details).toEqual({ reason: 'seats', plan: 'pro', seats: 4 });
    expect((await as(m, (ctx) => billing.getBillingOverview(ctx))).seats).toBe(4);
  });

  it('[S13-02] trial expiry downgrades to Free without data loss', async () => {
    const m = await createFounder();
    await setAgencyStatus(m.agencyId, 'VERIFIED');
    expect(await billing.billingJobs.startTrial.spec.run({ agencyId: m.agencyId }, jobCtx())).toEqual({
      started: 'pro',
    });
    // Once per agency, ever.
    expect(await billing.billingJobs.startTrial.spec.run({ agencyId: m.agencyId }, jobCtx())).toEqual({
      skipped: 'history',
    });
    const trial = await as(m, (ctx) => billing.getBillingOverview(ctx));
    expect(trial).toMatchObject({ plan: 'pro', seats: 4, grant: { kind: 'TRIAL', planCode: 'pro' } });
    const days = (Date.parse(trial.grant?.endsAt as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);

    // Data made during the trial (a website on Pro).
    const site = await as(m, (ctx) => websites.createSite(ctx, SITE));

    // Fourteen days later.
    await system((tx) =>
      tx.execute(sql`update billing_plan_grants set starts_at = now() - interval '15 days', ends_at = now() - interval '1 day'
                     where agency_id = ${m.agencyId}::uuid`),
    );
    await billing.billingJobs.endPlanGrants.spec.run({}, jobCtx());
    expect(await planEvents(m.agencyId)).toEqual([
      { plan: 'pro', reason: 'TRIAL_STARTED' },
      { plan: 'free', reason: 'GRANT_ENDED' },
    ]);
    // Announced once.
    await billing.billingJobs.endPlanGrants.spec.run({}, jobCtx());
    expect(await planEvents(m.agencyId)).toHaveLength(2);

    const after = await as(m, (ctx) => billing.getBillingOverview(ctx));
    expect(after).toMatchObject({ plan: 'free', seats: 1, grant: null });
    // Nothing deleted: the site is still there; only new paid work is gated.
    const sites = await as(m, (ctx) => websites.listSites(ctx, { limit: 10 }));
    expect(sites.items.map((s) => s.id)).toEqual([site.id]);
    expect((await refusal(as(m, (ctx) => websites.createSite(ctx, { ...SITE, name: 'Second' })))).code).toBe(
      'PLAN_REQUIRED',
    );
  });

  it('[S13-02] no trial for an agency with billing history (migrated / founding: staff grant or price lock first)', async () => {
    const m = await createFounder();
    await asStaff(superAdmin, (ctx) =>
      billing.setPriceLock(ctx, {
        agencyId: m.agencyId,
        planCode: 'pro',
        interval: 'YEAR',
        currency: 'EUR',
        amountCents: 80_000,
        endsAt: new Date(Date.now() + 3 * 365 * 86_400_000).toISOString(),
        reason: 'founding offer (migrated)',
      }),
    );
    expect(await billing.billingJobs.startTrial.spec.run({ agencyId: m.agencyId }, jobCtx())).toEqual({
      skipped: 'history',
    });
    expect((await as(m, (ctx) => billing.getBillingOverview(ctx))).plan).toBe('free');
  });

  it('[S13-02] staff grants with expiry: super admins only; revoking ends the plan at once and is announced', async () => {
    const m = await createFounder();
    const support = (await createStaffUser('STAFF_SUPPORT')).userId;
    const body = {
      agencyId: m.agencyId,
      planCode: 'business',
      endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reason: 'parallel run until the old provider renews',
    };
    expect((await refusal(asStaff(support, (ctx) => billing.grantPlan(ctx, body)))).code).toBe('FORBIDDEN');
    // The database refuses it too (RLS: active super admins only), whatever the query.
    const direct = await asStaff(support, (ctx) =>
      ctx.tx.execute(sql`insert into billing_plan_grants (id, agency_id, kind, plan_code, starts_at, ends_at, reason)
        values (${newId()}::uuid, ${m.agencyId}::uuid, 'STAFF', 'business', now(), now() + interval '1 day', 'x')`),
    ).then(
      () => 'inserted',
      (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
    );
    expect(direct).toMatch(/row-level security/);
    expect(
      (await refusal(asStaff(superAdmin, (ctx) => billing.grantPlan(ctx, { ...body, planCode: 'platinum' })))).code,
    ).toBe('BILLING_PRICE_UNAVAILABLE');
    expect(
      (
        await refusal(
          asStaff(superAdmin, (ctx) =>
            billing.grantPlan(ctx, { ...body, endsAt: new Date(Date.now() - 1).toISOString() }),
          ),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');

    const grant = await asStaff(superAdmin, (ctx) => billing.grantPlan(ctx, body));
    expect(grant).toMatchObject({ kind: 'STAFF', planCode: 'business', revokedAt: null });
    expect(await as(m, async (ctx) => (await billing.planOf(ctx.tx, ctx.tenant.agencyId)).code)).toBe('business');
    const stored = await system(async (tx) => {
      const r = await tx.execute<{ granted_by: string; reason: string }>(
        sql`select granted_by, reason from billing_plan_grants where id = ${grant.id}::uuid`,
      );
      return r.rows[0];
    });
    expect(stored).toEqual({ granted_by: superAdmin, reason: body.reason });

    const revoked = await asStaff(superAdmin, (ctx) => billing.revokePlanGrant(ctx, grant.id, 'Ticket 9: pilot ended'));
    expect(revoked.revokedAt).not.toBeNull();
    expect(await as(m, async (ctx) => (await billing.planOf(ctx.tx, ctx.tenant.agencyId)).code)).toBe('free');
    expect(
      (await refusal(asStaff(superAdmin, (ctx) => billing.revokePlanGrant(ctx, grant.id, 'Ticket 9: pilot ended'))))
        .code,
    ).toBe('BILLING_GRANT_NOT_FOUND');
    expect(await planEvents(m.agencyId)).toEqual([
      { plan: 'business', reason: 'GRANT_STARTED' },
      { plan: 'free', reason: 'GRANT_ENDED' },
    ]);
    // Announced by the revoke: the sweep adds nothing.
    await billing.billingJobs.endPlanGrants.spec.run({}, jobCtx());
    expect(await planEvents(m.agencyId)).toHaveLength(2);
  });

  it('[S13 review] RLS: a support session cannot append billing.plan.changed nor write the plan catalog', async () => {
    const m = await createFounder();
    const support = (await createStaffUser('STAFF_SUPPORT')).userId;
    const attempt = (query: ReturnType<typeof sql>) =>
      asStaff(support, (ctx) => ctx.tx.execute(query)).then(
        () => 'inserted',
        (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
      );
    // A forged plan notice: only an active super admin (the grant's own gate) may append it.
    expect(
      await attempt(sql`insert into outbox_events (id, agency_id, type, version, payload)
        values (${newId()}::uuid, ${m.agencyId}::uuid, 'billing.plan.changed', 1,
                ${JSON.stringify({ agencyId: m.agencyId, plan: 'free', reason: 'GRANT_ENDED' })}::jsonb)`),
    ).toMatch(/row-level security/);
    // The catalog is written by withSystem only; staff writes need a super admin.
    const updated = await asStaff(support, (ctx) =>
      ctx.tx.execute(sql`update billing_prices set amount_cents = 1 where currency = 'EUR' returning id`),
    );
    expect(updated.rows).toHaveLength(0);
    expect(
      await attempt(sql`insert into billing_catalog_items (id, code, kind, rank, features)
        values (${newId()}::uuid, ${`forged-${newId().slice(-8)}`}, 'PLAN', 999, '{}')`),
    ).toMatch(/row-level security/);
  });

  it('[S13-02] plans not enforced (billing not live): every feature and seat stays open', async () => {
    const m = await createFounder();
    billing.configureBilling({});
    try {
      expect((await refusal(as(m, (ctx) => billing.requirePlan(ctx, 'ai_video')))).code).toBe('accepted');
      expect((await refusal(invite(m))).code).toBe('accepted');
    } finally {
      billing.configureBilling({ enforcePlans: true, trial: { planCode: 'pro', days: 14 }, dunningGraceDays: 14 });
    }
  });
});

describe('one plan in force (S14-F1)', () => {
  /** A Pro subscription PAST_DUE without `past_due_since` (synced `syncedDaysAgo` days ago), two extra users, one site. */
  const pastDueWithoutSince = (agencyId: string, syncedDaysAgo: number) =>
    system((tx) =>
      repo.upsertSubscription(tx, {
        agencyId,
        stripeSubscriptionId: `sub_f1_${newId().slice(-12)}`,
        planCode: 'pro',
        status: 'PAST_DUE',
        interval: 'YEAR',
        currency: 'EUR',
        addons: [
          { code: 'extra_user', quantity: 2 },
          { code: 'extra_website', quantity: 1 },
        ],
        paymentMethod: 'card',
        currentPeriodEnd: null,
        cancelAt: null,
        pastDueSince: null,
        syncedAt: new Date(Date.now() - syncedDaysAgo * 86_400_000),
      }),
    );

  /** The plan as each path sees it: plan in force, batched plans, overview + seats, quota with and without the plan. */
  const everyPath = async (m: Founder) => {
    const planOf = await as(m, async (ctx) => (await billing.planOf(ctx.tx, ctx.tenant.agencyId)).code);
    const now = new Date();
    const batched = await system(
      async (tx) =>
        (await repo.plansInForce(tx, [m.agencyId], now, new Date(now.getTime() - 14 * 86_400_000))).get(m.agencyId)
          ?.code,
    );
    const overview = await as(m, (ctx) => billing.getBillingOverview(ctx));
    const quota = (await refusal(as(m, (ctx) => billing.requireQuota(ctx, 'sites', 10)))).details as {
      plan: string;
      limit: number;
    };
    const quotaWithPlan = (
      await refusal(
        as(m, async (ctx) =>
          billing.requireQuota(ctx, 'sites', 10, 1, { plan: await billing.planOf(ctx.tx, m.agencyId) }),
        ),
      )
    ).details as { plan: string; limit: number };
    return {
      planOf,
      batched,
      overview: overview.plan,
      seats: overview.seats,
      quota: [quota.plan, quota.limit],
      quotaWithPlan: [quotaWithPlan.plan, quotaWithPlan.limit],
    };
  };

  it('[S14-F1] a PAST_DUE subscription with a null past_due_since gets the same plan from every path', async () => {
    // Synced 15 days ago (the grace counts from `synced_at`): Free everywhere, and its add-ons no longer count.
    const lapsed = await createFounder();
    await pastDueWithoutSince(lapsed.agencyId, 15);
    expect(await everyPath(lapsed)).toEqual({
      planOf: 'free',
      batched: 'free',
      overview: 'free',
      seats: 1,
      quota: ['free', 0],
      quotaWithPlan: ['free', 0],
    });
    expect((await refusal(invite(lapsed))).details).toEqual({ reason: 'seats', plan: 'free', seats: 1 });

    // Synced a day ago: within the grace — Pro everywhere, with its add-ons (4 + 2 seats, 1 + 1 sites).
    const inGrace = await createFounder();
    await pastDueWithoutSince(inGrace.agencyId, 1);
    expect(await everyPath(inGrace)).toEqual({
      planOf: 'pro',
      batched: 'pro',
      overview: 'pro',
      seats: 6,
      quota: ['pro', 2],
      quotaWithPlan: ['pro', 2],
    });
  });

  it('[S14-F1] a PAST_DUE subscription with a null past_due_since gets one GRACE_ENDED once its synced_at is past the grace', async () => {
    const lapsed = await createFounder();
    await pastDueWithoutSince(lapsed.agencyId, 15);
    const inGrace = await createFounder();
    await pastDueWithoutSince(inGrace.agencyId, 1);
    const graceEnded = async (agencyId: string) =>
      (await planEvents(agencyId)).filter((e) => e.reason === 'GRACE_ENDED');

    await billing.billingJobs.endDunningGrace.spec.run({}, jobCtx());
    expect(await graceEnded(lapsed.agencyId)).toEqual([{ plan: 'free', reason: 'GRACE_ENDED' }]);
    expect(await graceEnded(inGrace.agencyId)).toEqual([]);
    // Announced once.
    await billing.billingJobs.endDunningGrace.spec.run({}, jobCtx());
    expect(await graceEnded(lapsed.agencyId)).toHaveLength(1);
  });

  it('[S14-F1] billing.endPlanGrants runs a fixed number of statements per batch', async () => {
    /** Agencies with a Pro grant that ended a day ago (not announced yet). */
    const endedGrants = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const m = await createFounder();
        await asStaff(superAdmin, (ctx) =>
          billing.grantPlan(ctx, {
            agencyId: m.agencyId,
            planCode: 'pro',
            endsAt: new Date(Date.now() + 86_400_000).toISOString(),
            reason: 'pilot agency',
          }),
        );
        ids.push(m.agencyId);
      }
      await system((tx) =>
        tx.execute(sql`update billing_plan_grants set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day'
                       where agency_id = any(${sql.param(ids)}::uuid[])`),
      );
      return ids;
    };
    const run = () => countQueries(() => billing.billingJobs.endPlanGrants.spec.run({}, jobCtx()));

    // Drain anything left over, then one agency and five agencies cost the same statements.
    await billing.billingJobs.endPlanGrants.spec.run({}, jobCtx());
    const one = await endedGrants(1);
    const single = await run();
    const five = await endedGrants(5);
    const batch = await run();
    expect(batch).toBe(single);
    // Each agency still gets its event, with the plan now in force.
    for (const agencyId of [...one, ...five]) {
      const ended = (await planEvents(agencyId)).filter((e) => e.reason === 'GRANT_ENDED');
      expect(ended).toEqual([{ plan: 'free', reason: 'GRANT_ENDED' }]);
    }
  });
});
