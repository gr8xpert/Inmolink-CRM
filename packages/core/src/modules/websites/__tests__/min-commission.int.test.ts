import type { CreateSiteInput, SiteDto, SiteInventoryFilters } from '@inmolink/contracts';
import { closeDb, withSystem } from '@inmolink/db';
import { loadStackEnv, setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { loadConfig, websitesEnv } from '@inmolink/platform/config';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit } from '@inmolink/platform/rate-limit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as websites from '../index';

/**
 * Minimum-commission edits (S12-F25, S7-F10 security review): each edit of a CUSTOM site's minimum commission is a
 * yes/no question about other agencies' commissions, so an agency gets `WEBSITE_MIN_COMMISSION_EDITS_PER_DAY` a day, and
 * every accepted edit leaves one audit row with the old and new basis points.
 */

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);

const filters = (minCommissionBp?: number): SiteInventoryFilters => ({
  includeOwn: true,
  includeNetwork: true,
  locationIds: [],
  propertyTypeIds: [],
  newBuilds: true,
  ...(minCommissionBp === undefined ? {} : { minCommissionBp }),
});

const CUSTOM_SITE = (minCommissionBp: number): CreateSiteInput => ({
  name: 'Well paid',
  domains: [],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'CUSTOM',
  inventoryFilters: filters(minCommissionBp),
  referencePrefix: null,
  locales: ['en'],
  contact: null,
});

async function verifiedFounder(): Promise<Founder> {
  const m = await createFounder();
  await setAgencyStatus(m.agencyId, 'VERIFIED');
  return m;
}

/** Sets the site's minimum commission (CUSTOM policy, network listings). */
const setMin = (m: Founder, site: SiteDto, minCommissionBp: number | undefined) =>
  as(m, (ctx) =>
    websites.updateSite(
      ctx,
      { siteId: site.id },
      { version: site.version, inventoryPolicy: 'CUSTOM', inventoryFilters: filters(minCommissionBp) },
    ),
  );

async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, details: err.details };
    throw err;
  }
  return { code: 'accepted' };
}

async function auditRows(siteId: string) {
  return withSystem('websites.min-commission.test', async (tx) => {
    const r = await tx.execute<{ actor_user_id: string | null; agency_id: string; metadata: Record<string, unknown> }>(
      sql`select actor_user_id, agency_id, metadata from audit_logs
           where type = 'websites.site.minCommissionChanged' and target_type = 'site' and target_id = ${siteId}::uuid
           order by occurred_at, id`,
    );
    return r.rows;
  });
}

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
}, 120_000);

afterAll(async () => {
  await closeRateLimit();
  await closeDb();
});

describe('minimum-commission edits (S12-F25)', () => {
  it('[S12-F25] the edit past the daily limit is refused with RATE_LIMITED and a retry-after; other edits still pass', async () => {
    const { limit } = websites.minCommissionEditBudget();
    const m = await verifiedFounder();
    // Setting it on create counts as an edit.
    let site = await as(m, (ctx) => websites.createSite(ctx, CUSTOM_SITE(300)));
    for (let i = 1; i < limit; i += 1) site = await setMin(m, site, 300 + i);
    expect(site.inventoryFilters?.minCommissionBp).toBe(300 + limit - 1);

    const refused = await refusal(setMin(m, site, 900));
    expect(refused.code).toBe('RATE_LIMITED');
    expect((refused.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    // Nothing changed, and removing the minimum is an edit too.
    const stored = await as(m, (ctx) => websites.getSite(ctx, { siteId: site.id }));
    expect(stored.version).toBe(site.version);
    expect(stored.inventoryFilters?.minCommissionBp).toBe(300 + limit - 1);
    expect((await refusal(setMin(m, site, undefined))).code).toBe('RATE_LIMITED');
    // A new site with a minimum is refused as well: the budget is the agency's, not the site's.
    expect((await refusal(as(m, (ctx) => websites.createSite(ctx, CUSTOM_SITE(500))))).code).toBe('RATE_LIMITED');

    // Edits that leave the minimum alone are not counted.
    const renamed = await as(m, (ctx) =>
      websites.updateSite(ctx, { siteId: site.id }, { version: site.version, name: 'Renamed' }),
    );
    expect(renamed.name).toBe('Renamed');
    // Another agency has its own budget.
    const other = await verifiedFounder();
    const otherSite = await as(other, (ctx) => websites.createSite(ctx, CUSTOM_SITE(300)));
    expect((await setMin(other, otherSite, 350)).inventoryFilters?.minCommissionBp).toBe(350);
  });

  it('[S12-F25] each accepted edit has one audit row with the actor, the site and old → new basis points', async () => {
    const m = await verifiedFounder();
    let site = await as(m, (ctx) => websites.createSite(ctx, CUSTOM_SITE(300)));
    site = await setMin(m, site, 450);
    site = await as(m, (ctx) =>
      websites.updateSite(ctx, { siteId: site.id }, { version: site.version, name: 'Same minimum' }),
    );
    site = await as(m, (ctx) =>
      websites.updateSite(
        ctx,
        { siteId: site.id },
        { version: site.version, inventoryPolicy: 'OWN_ONLY', inventoryFilters: null },
      ),
    );

    const rows = await auditRows(site.id);
    expect(rows.map((r) => r.metadata)).toEqual([
      { oldBp: null, newBp: 300 },
      { oldBp: 300, newBp: 450 },
      { oldBp: 450, newBp: null },
    ]);
    for (const r of rows) {
      expect(r.actor_user_id).toBe(m.userId);
      expect(r.agency_id).toBe(m.agencyId);
    }

    // A refused edit leaves no row.
    const n = await verifiedFounder();
    let capped = await as(n, (ctx) => websites.createSite(ctx, CUSTOM_SITE(300)));
    for (let i = 1; i < websites.minCommissionEditBudget().limit; i += 1) capped = await setMin(n, capped, 300 + i);
    expect((await refusal(setMin(n, capped, 999))).code).toBe('RATE_LIMITED');
    expect(await auditRows(capped.id)).toHaveLength(websites.minCommissionEditBudget().limit);
  });

  it('[S12-F25] the daily limit comes from config: WEBSITE_MIN_COMMISSION_EDITS_PER_DAY, default 5', async () => {
    expect(loadConfig(websitesEnv, {}).WEBSITE_MIN_COMMISSION_EDITS_PER_DAY).toBe(5);
    expect(
      loadConfig(websitesEnv, { WEBSITE_MIN_COMMISSION_EDITS_PER_DAY: '3' }).WEBSITE_MIN_COMMISSION_EDITS_PER_DAY,
    ).toBe(3);
    expect(() => loadConfig(websitesEnv, { WEBSITE_MIN_COMMISSION_EDITS_PER_DAY: '0' })).toThrow();
    websites.configureWebsites({ minCommissionEditsPerDay: 2 });
    try {
      const m = await verifiedFounder();
      const site = await setMin(m, await as(m, (ctx) => websites.createSite(ctx, CUSTOM_SITE(300))), 310);
      expect((await refusal(setMin(m, site, 320))).code).toBe('RATE_LIMITED');
    } finally {
      websites.configureWebsites({});
    }
    expect(websites.minCommissionEditBudget().limit).toBe(loadConfig(websitesEnv).WEBSITE_MIN_COMMISSION_EDITS_PER_DAY);
  });
});
