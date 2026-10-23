import { closeDb, withMemberCtx } from '@inmolink/core';
import * as identity from '@inmolink/core/modules/identity';
import * as migration from '@inmolink/core/modules/migration';
import * as search from '@inmolink/core/modules/search';
import * as taxonomy from '@inmolink/core/modules/taxonomy';
import * as websiteApi from '@inmolink/core/modules/website-api';
import * as websites from '@inmolink/core/modules/websites';
import { createFounder, withSystem } from '@inmolink/core/test';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { cache, closeCache, configureCache } from '@inmolink/platform/cache';
import { etagFor } from '@inmolink/platform/http';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import type { RateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../apps/feed-api/src/app';

/**
 * The v1 shim's test world (S8-02): a golden fixture's public read-path rows (`listing_search_docs`,
 * `listing_read_models`, `listing_public_codes`, `legacy_id_maps`) loaded for a new agency with one OWN_ONLY site, and
 * feed-api from source with the search engine unreachable (the Postgres fallback answers: a deterministic order).
 * Recorded golden files (H2) replay against `tests/golden/fixture.json` in this same format: the H2 test account's
 * read-path rows once the legacy migration (S14) has loaded them.
 */

export interface FixtureListing {
  legacyId: string | null;
  /** Public code (`listing_public_codes`). */
  code: string;
  /** The `listing_search_docs` row's filter fields. */
  search: {
    kind: 'LISTING' | 'UNIT';
    status: string;
    transactionType: string;
    propertyTypeId: string;
    locationIds: string[];
    featureIds: string[];
    priceCents: number | null;
    priceOnRequest: boolean;
    beds: number | null;
    baths: number | null;
    areaM2: number | null;
    plotM2: number | null;
    lat: number | null;
    lng: number | null;
    ref: string;
    publishedAt: number;
  };
  /** The read model's card document (`id` is the target id); the detail document is the card plus `detail`. */
  card: Record<string, unknown> & { id: string };
  detail: Record<string, unknown>;
}

export interface Fixture {
  synthetic?: boolean;
  /** Replaced by `{LEGACY_BASE}` in the shim's answers (the recorder does so with the legacy base URL). */
  base: string | null;
  site: {
    locales: string[];
    referencePrefix: string | null;
    contact: { name?: string; email?: string; phone?: string } | null;
  };
  legacyIds: { entity: string; legacyId: string; newId: string }[];
  listings: FixtureListing[];
  /**
   * The property-type catalog `/v1/types` serves (the v2 `WebsiteTypesDto.propertyTypes`), seeded into this run's
   * taxonomy cache: the shared test database holds other suites' types, so the real catalog is not deterministic.
   */
  catalog?: { propertyTypes: unknown[] };
}

const allow = {
  consume: async () => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0 }),
  credit: async () => undefined,
  consumeMany: async (checks: readonly unknown[]) =>
    checks.map(() => ({ allowed: true, limit: 1, remaining: 1, retryAfterSeconds: 0, resetAtMs: 0 })),
} as unknown as RateLimiter;

const RUN = newId().slice(-8);
const loaded: string[][] = [];
const uuids = (ids: readonly string[]) => `{${ids.join(',')}}`;
const READ_PATH_TABLES = ['listing_read_models', 'listing_search_docs', 'listing_public_codes'] as const;

export type FeedApp = Awaited<ReturnType<typeof buildApp>>;

/** Test stack, caches, website API settings, an unreachable engine and feed-api. */
export async function startWorld(prefix: string): Promise<FeedApp> {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:${prefix}:${RUN}` });
  identity.configureIdentity({ hmacKey: 'test-hmac-key-0123456789abcdef0123456789', apiKeyEnv: 'test' });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker({ failureThreshold: 1, openMs: 3_600_000 });
  return buildApp({
    logger: createLogger({ level: 'silent' }),
    trustProxy: false,
    docsUi: false,
    limiter: allow,
    checks: {},
  });
}

/** Removes the loaded rows (test agencies are pruned by the test setup), closes feed-api and the pools. */
export async function stopWorld(app: FeedApp | undefined): Promise<void> {
  search.resetSearchBreaker();
  await app?.close();
  const ids = loaded.flat();
  if (ids.length > 0) {
    await withSystem('golden.legacy-v1', async (tx) => {
      for (const table of READ_PATH_TABLES) {
        await tx.execute(sql`delete from ${sql.identifier(table)} where target_id = any(${uuids(ids)}::uuid[])`);
      }
    }).catch(() => undefined);
  }
  await closeCache();
  await closeDb();
}

export interface World {
  agencyId: string;
  siteId: string;
  /** The site's secret key (scopes `listings:read`, `taxonomy:read`), marked as a migrated legacy key. */
  key: string;
  /** Another secret key of the site, not marked: refused as the legacy `api_key` query parameter. */
  v2Key: string;
}

/**
 * Loads a fixture's rows for a new agency with one OWN_ONLY site. Target ids are the fixture's own (a re-run replaces
 * its rows); legacy maps are upserted (the last load wins).
 */
export async function loadWorld(fixture: Fixture): Promise<World> {
  const founder = await createFounder();
  await setAgencyStatus(founder.agencyId, 'VERIFIED');
  const ids = fixture.listings.map((l) => l.card.id);
  loaded.push(ids);
  await withSystem('golden.legacy-v1', async (tx) => {
    for (const table of READ_PATH_TABLES) {
      await tx.execute(sql`delete from ${sql.identifier(table)} where target_id = any(${uuids(ids)}::uuid[])`);
    }
    for (const l of fixture.listings) {
      const s = l.search;
      await tx.execute(sql`insert into listing_public_codes (target_id, code) values (${l.card.id}::uuid, ${l.code})`);
      await tx.execute(sql`
        insert into listing_search_docs (target_id, kind, owner_agency_id, status, transaction_type, property_type_id,
          location_ids, feature_ids, price_cents, price_on_request, beds, baths, area_m2, plot_m2, lat, lng, ref,
          public_code, share_scope, preferred_agency_ids, network_hidden, published_at, version, source_hash)
        values (${l.card.id}::uuid, ${s.kind}, ${founder.agencyId}::uuid, ${s.status}, ${s.transactionType},
          ${s.propertyTypeId}::uuid, ${uuids(s.locationIds)}::uuid[], ${uuids(s.featureIds)}::uuid[], ${s.priceCents},
          ${s.priceOnRequest}, ${s.beds}, ${s.baths}, ${s.areaM2}, ${s.plotM2}, ${s.lat}, ${s.lng}, ${s.ref}, ${l.code},
          'ALL', '{}', false, ${s.publishedAt}, 1, ${`golden-${l.code}`})`);
      for (const locale of fixture.site.locales) {
        await tx.execute(sql`
          insert into listing_read_models (target_id, locale, kind, agency_id, public, status, share_scope, version,
            card, detail, etag)
          values (${l.card.id}::uuid, ${locale}, ${s.kind}, ${founder.agencyId}::uuid, true, ${s.status}, 'ALL', 1,
            ${JSON.stringify(l.card)}::jsonb, ${JSON.stringify({ ...l.card, ...l.detail })}::jsonb,
            ${`golden-${l.code}`})`);
      }
    }
    const maps = [
      ...fixture.legacyIds,
      ...fixture.listings.flatMap((l) =>
        l.legacyId === null
          ? []
          : [{ entity: l.search.kind === 'UNIT' ? 'unit' : 'listing', legacyId: l.legacyId, newId: l.card.id }],
      ),
    ];
    for (const m of maps) {
      await tx.execute(sql`
        insert into legacy_id_maps (id, entity, legacy_id, new_id, method)
        values (${newId()}::uuid, ${m.entity}, ${m.legacyId}, ${m.newId}::uuid, 'golden')
        on conflict (entity, legacy_id) do update set new_id = excluded.new_id, updated_at = now()`);
    }
  });
  const as = <T>(fn: Parameters<typeof withMemberCtx<T>>[1]) =>
    withMemberCtx({ userId: founder.userId, agencyId: founder.agencyId, requestId: newId(), locale: 'en' }, fn);
  const site = await as((ctx) =>
    websites.createSite(ctx, {
      name: `Golden ${RUN}`,
      domains: [`www.golden-${RUN}-${loaded.length}.example`],
      mode: 'WP_PLUGIN',
      inventoryPolicy: 'OWN_ONLY',
      inventoryFilters: null,
      referencePrefix: fixture.site.referencePrefix,
      locales: fixture.site.locales,
      contact: fixture.site.contact,
    }),
  );
  const issue = (name: string) =>
    as((ctx) =>
      identity.createApiKey(ctx, {
        name,
        kind: 'SECRET',
        scopes: ['listings:read', 'taxonomy:read'],
        allowedOrigins: [],
        siteId: site.id,
      }),
    );
  const key = await issue('golden');
  const v2Key = await issue('golden v2');
  // A migrated legacy key: the only kind the v1 shim accepts as its `api_key` query parameter.
  await withSystem('golden.legacy-v1', (tx) =>
    identity.setLegacyQueryKey(
      {
        tx,
        tenant: { agencyId: founder.agencyId, verified: true, plan: 'none', locales: ['en'] },
        actor: { kind: 'system', reason: 'golden.legacy-v1' },
        locale: 'en',
        requestId: newId(),
        clientMode: false,
      },
      { prefix: key.key.prefix, enabled: true, reason: 'golden.test' },
    ),
  );
  if (fixture.catalog) {
    for (const locale of fixture.site.locales) {
      const json = JSON.stringify({ locale, propertyTypes: fixture.catalog.propertyTypes });
      await cache.get(
        taxonomy.taxonomyCacheKey('webtypes', locale as Parameters<typeof taxonomy.taxonomyCacheKey>[1]),
        { ttlSeconds: taxonomy.TAXONOMY_CACHE_TTL_SECONDS, tags: [taxonomy.TAXONOMY_CACHE_TAG], local: true },
        async () => ({ etag: etagFor(json), json }),
      );
    }
  }
  // The maps just written: this process's taxonomy maps reload, resolved listing ids are forgotten.
  await migration.reloadLegacyTaxonomy();
  migration.resetLegacyIdCache();
  return { agencyId: founder.agencyId, siteId: site.id, key: key.secret, v2Key: v2Key.secret };
}
