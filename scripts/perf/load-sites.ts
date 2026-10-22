/**
 * Load-test sites and keys (S7-08): the website API load test runs through the real key check and limiter, so it
 * needs keys that no limit trips at the target rate — and no bypass anywhere in the request path. Each load-test key
 * belongs to its own site and agency (scale-seed agencies with the most public listings), is a SECRET key on the HIGH
 * tier, and is named `load-test`; `keysNeeded` (tests/load/lib) says how many a rate needs. Refused in production;
 * `revokeLoadKeys` revokes every one after the run (runbook website-api.md › Load test).
 */
import { type Ctx, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { type Tx, withSystem } from '@inmolink/db';
import { newId } from '@inmolink/platform/ids';
import { sql } from 'drizzle-orm';
import type { KeyLimits } from '../../tests/load/lib/website-mix';

export const LOAD_SITE_NAME = 'Load test (S7-08)';
export const LOAD_KEY_NAME = 'load-test';
/** Scale-seed members only (`a<n>-u<m>@s<seed>.scale.inmolink.test`): never a real agency, even on staging. */
export const SCALE_EMAIL_LIKE = '%.scale.inmolink.test';
export const LOAD_TIER = 'HIGH' as const;
const REASON = 'perf.load-test';

/** The limits a load-test key runs under (its tier, the agency ceiling, burst and daily quota). */
export function loadKeyLimits(): KeyLimits {
  const l = websiteApi.DEFAULT_WEBSITE_LIMITS;
  return {
    perKeyPerMinute: identity.API_KEYS.RATE_TIERS[LOAD_TIER].limit,
    agencyPerMinute: identity.API_KEYS.AGENCY_RATE.limit,
    burst: l.burst[LOAD_TIER],
    burstWindowSeconds: l.burstWindowSeconds,
    dailyQuota: l.dailyQuota[LOAD_TIER],
    // S7-F9: feed-api's keyed website routes have no per-IP request limit (`KEYED_ROUTE_LIMITS`; a site's server calls
    // from one IP); only failed key checks count per IP. Pinned by `tests/load/website-mix.test.ts`.
    ipPerMinute: null,
  };
}

/**
 * Load-test keys are made only where the environment says, explicitly, it is not production: `DEPLOY_ENV` (if set)
 * development, test or staging; `NODE_ENV` development or test — or production only with `DEPLOY_ENV=staging` and
 * `--staging` (like the scale seed). Neither set: refused. A staging target always needs `--staging`.
 */
export function assertLoadTarget(env: Record<string, string | undefined>, staging: boolean): void {
  const deploy = env.DEPLOY_ENV?.trim() || undefined;
  const node = env.NODE_ENV?.trim() || undefined;
  if (!deploy && !node) throw new Error('refusing to create load-test keys: neither DEPLOY_ENV nor NODE_ENV is set');
  if (deploy && !['development', 'test', 'staging'].includes(deploy)) {
    throw new Error(`refusing to create load-test keys with DEPLOY_ENV=${deploy}`);
  }
  if (node === 'production' ? deploy !== 'staging' : node !== undefined && !['development', 'test'].includes(node)) {
    throw new Error(
      `refusing to create load-test keys with NODE_ENV=${node}${deploy ? ` and DEPLOY_ENV=${deploy}` : ''}`,
    );
  }
  if (deploy === 'staging' && !staging) throw new Error('a staging target needs --staging');
}

/** Each site's inventory policy, in turn: the shapes PLAN §9 sites take, incl. a CUSTOM minimum commission. */
const POLICIES = [
  { name: 'OWN_ONLY', inventoryPolicy: 'OWN_ONLY', inventoryFilters: null },
  { name: 'OWN_PLUS_NETWORK', inventoryPolicy: 'OWN_PLUS_NETWORK', inventoryFilters: null },
  {
    name: 'CUSTOM_NETWORK',
    inventoryPolicy: 'CUSTOM',
    inventoryFilters: { includeOwn: true, includeNetwork: true, locationIds: [], propertyTypeIds: [], newBuilds: true },
  },
  {
    name: 'CUSTOM_MIN_COMMISSION',
    inventoryPolicy: 'CUSTOM',
    inventoryFilters: {
      includeOwn: false,
      includeNetwork: true,
      locationIds: [],
      propertyTypeIds: [],
      newBuilds: true,
      minCommissionBp: 300,
    },
  },
] as const;
export type LoadPolicy = (typeof POLICIES)[number]['name'];
export const LOAD_LOCALES = ['en', 'es', 'de'];

export interface LoadKey {
  key: string;
  keyId: string;
  siteId: string;
  agencyId: string;
  policy: LoadPolicy;
  locales: string[];
}
export interface LoadKeysFile {
  createdAt: string;
  limits: KeyLimits;
  keys: LoadKey[];
}

/** The load policy a (reused) site has: its inventory policy, CUSTOM split by a minimum commission. */
function policyOf(site: {
  inventoryPolicy: string;
  inventoryFilters: { includeOwn: boolean; minCommissionBp?: number } | null;
}): LoadPolicy {
  if (site.inventoryPolicy !== 'CUSTOM') return site.inventoryPolicy as LoadPolicy;
  return site.inventoryFilters?.minCommissionBp ? 'CUSTOM_MIN_COMMISSION' : 'CUSTOM_NETWORK';
}

interface LoadAgency {
  agencyId: string;
  userId: string;
  listings: number;
}

/**
 * The `n` verified scale-seed agencies with the most public search documents, each with an active admin. One
 * statement (a group-by over `listing_search_docs`, once per setup).
 */
export async function loadTestAgencies(n: number, emailLike = SCALE_EMAIL_LIKE): Promise<LoadAgency[]> {
  return withSystem(`${REASON}.agencies`, async (tx) => {
    const rows = await tx.execute<{ agency_id: string; user_id: string; listings: number }>(sql`
      select a.agency_id, m.user_id, coalesce(d.n, 0)::int as listings
        from agencies a
        join lateral (select user_id from agency_members
                       where agency_id = a.agency_id and role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')
                         and deactivated_at is null and email like ${emailLike}
                       order by created_at, user_id limit 1) m on true
        left join (select owner_agency_id, count(*) as n from listing_search_docs group by owner_agency_id) d
               on d.owner_agency_id = a.agency_id
       where a.status = 'VERIFIED'
       order by d.n desc nulls last, a.agency_id
       limit ${n}`);
    return rows.rows.map((r) => ({ agencyId: r.agency_id, userId: r.user_id, listings: Number(r.listings) }));
  });
}

/** A system context in one agency (the actor carries the audited reason). */
const systemCtx = (tx: Tx, agencyId: string): Ctx => ({
  tx,
  tenant: { agencyId, verified: true, plan: 'none', locales: ['en'] },
  actor: { kind: 'system', reason: REASON },
  locale: 'en',
  requestId: newId(),
  clientMode: false,
});

const asAdmin = <T>(a: LoadAgency, fn: Parameters<typeof withMemberCtx<T>>[1]) =>
  withMemberCtx({ userId: a.userId, agencyId: a.agencyId, requestId: newId(), locale: 'en' }, fn);

/** Revokes the agency's active load-test keys (through identity, audited). */
async function revokeAgencyLoadKeys(a: LoadAgency): Promise<number> {
  return asAdmin(a, async (ctx) => {
    const page = await identity.listApiKeys(ctx, { limit: 100 });
    const live = page.items.filter((k) => k.name === LOAD_KEY_NAME && k.status === 'ACTIVE');
    for (const k of live) await identity.revokeApiKey(ctx, { keyId: k.id });
    return live.length;
  });
}

/**
 * Provisions `sites` load-test sites and keys (one per agency; the site is reused on re-runs, earlier load-test keys
 * are revoked first). Returns the keys file the k6 script reads — it holds secrets: write it outside the repo or under
 * the git-ignored `tests/load/.data/`.
 */
export async function provisionLoadSites(opts: { sites: number; emailLike?: string }): Promise<LoadKeysFile> {
  const agencies = await loadTestAgencies(opts.sites, opts.emailLike);
  if (agencies.length < opts.sites) {
    throw new Error(`${agencies.length} verified scale-seed agencies with an admin; ${opts.sites} needed`);
  }
  const keys: LoadKey[] = [];
  for (const [i, a] of agencies.entries()) {
    const policy = POLICIES[i % POLICIES.length] as (typeof POLICIES)[number];
    await revokeAgencyLoadKeys(a);
    const issued = await asAdmin(a, async (ctx) => {
      const existing = (await websites.listSites(ctx, { limit: 100 })).items.find((s) => s.name === LOAD_SITE_NAME);
      const site =
        existing ??
        (await websites.createSite(ctx, {
          name: LOAD_SITE_NAME,
          domains: [],
          mode: 'WP_PLUGIN',
          inventoryPolicy: policy.inventoryPolicy,
          inventoryFilters: policy.inventoryFilters
            ? { ...policy.inventoryFilters, locationIds: [], propertyTypeIds: [] }
            : null,
          referencePrefix: `LT${i % 10_000}`,
          locales: LOAD_LOCALES,
          contact: null,
        }));
      const key = await identity.createApiKey(ctx, {
        name: LOAD_KEY_NAME,
        kind: 'SECRET',
        scopes: ['listings:read', 'developments:read', 'taxonomy:read'],
        allowedOrigins: [],
        siteId: site.id,
      });
      return { site, key };
    });
    keys.push({
      key: issued.key.secret,
      keyId: issued.key.key.id,
      siteId: issued.site.id,
      agencyId: a.agencyId,
      policy: policyOf(issued.site),
      locales: issued.site.locales,
    });
  }
  // The tier is not an agency's choice: identity sets it for a system context only (audited, cached lookups dropped).
  for (const k of keys) {
    await withSystem(`${REASON}.tier`, (tx) =>
      identity.setApiKeyRateTier(systemCtx(tx, k.agencyId), { keyIds: [k.keyId], tier: LOAD_TIER, reason: REASON }),
    );
  }
  return { createdAt: new Date().toISOString(), limits: loadKeyLimits(), keys };
}

/** Revokes every active load-test key (after a run, or to clean up an interrupted one). */
export async function revokeLoadKeys(emailLike = SCALE_EMAIL_LIKE): Promise<number> {
  const agencies = await withSystem(`${REASON}.teardown`, async (tx) => {
    const rows = await tx.execute<{ agency_id: string; user_id: string }>(sql`
      select k.agency_id, m.user_id
        from (select distinct agency_id from api_keys where name = ${LOAD_KEY_NAME} and revoked_at is null) k
        join lateral (select user_id from agency_members
                       where agency_id = k.agency_id and role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')
                         and deactivated_at is null and email like ${emailLike}
                       order by created_at, user_id limit 1) m on true`);
    return rows.rows.map((r) => ({ agencyId: r.agency_id, userId: r.user_id, listings: 0 }));
  });
  let revoked = 0;
  for (const a of agencies) revoked += await revokeAgencyLoadKeys(a);
  return revoked;
}
