# Inmolink — Reference Patterns

Copy these shapes. Every module, route, job and page should look like this. Code is illustrative: adapt imports and signatures to the library versions pinned in ADR 0001, but keep the structure. If a pattern does not fit, propose a change in `docs/build/STATUS.md` → **Decisions**; do not invent a parallel pattern.

Contents: §0 Conventions · §1 Module layout · §2 Schema + tenant registry + RLS · §3 Tenant-scoped DB access · §4 Context (`ctx`) · §5 Repo · §6 Policy · §7 Service · §8 Events + outbox · §9 Contracts + errors · §10 Dashboard route · §11 feed-api route · §12 Worker job · §13 Bulk load · §14 Read models · §15 Cache · §16 Safe fetch + XML · §17 AI call · §18 Dashboard page · §19 Public page · §20 Tests · §21 i18n

---

## §0 Conventions

| Thing | Convention |
|---|---|
| Package names | `@inmolink/core`, `@inmolink/db`, `@inmolink/platform`, `@inmolink/contracts`, `@inmolink/ui`, `@inmolink/i18n`, `@inmolink/sdk` |
| Module names | kebab-case folder, camelCase import alias: `import * as properties from '@inmolink/core/modules/properties'` |
| Tables / columns | snake_case plural tables, snake_case columns; TS fields camelCase |
| IDs | UUIDv7 via `newId()` from `@inmolink/platform/ids` |
| Public refs | `INL-` + 7 base32 chars per listing; site reference prefix applied at serialization |
| Money / percent | `{ amountCents: number, currency: 'EUR' }` · basis points (`500` = 5%) |
| Time | `timestamptz`, ISO strings in DTOs, `clock.now()` from platform (fakeable) |
| Errors | `throw new AppError('CODE', { details })`; codes in `packages/contracts/src/errors.ts` |
| Events | `<module>.<entity>.<verb>` past tense, e.g. `properties.listing.updated` |
| Jobs | `<module>.<verb><Entity>`, e.g. `search.reindexListing` |
| Commits | `feat(properties): listing CRUD [S3-02]` |

---

## §1 Module layout

```
packages/core/src/modules/properties/
├── index.ts          # public API — the ONLY import path for other modules and apps
├── service.ts        # use cases: (ctx, input) → DTO. Authorization + orchestration.
├── repo.ts           # Drizzle queries on THIS module's tables only
├── policy.ts         # can(ctx, action, resource) rules
├── events.ts         # event types (Zod) + constructors
├── jobs.ts           # job definitions handled by the worker
├── errors.ts         # module error codes (re-exported in contracts)
├── mappers.ts        # row ↔ DTO mapping (optional)
└── __tests__/
    ├── service.int.test.ts
    └── policy.test.ts
```

```ts
// packages/core/src/modules/properties/index.ts
export { createListing, updateListing, getListing, listListings } from './service';
export { listingEvents, type ListingEvent } from './events';
export { propertiesJobs } from './jobs';
// Never export repo or schema from index.
```

---

## §2 Schema + tenant registry + RLS

```ts
// packages/db/src/schema/properties.ts
import { pgTable, pgEnum, uuid, text, integer, bigint, char, numeric, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

export const visibilityEnum = pgEnum('visibility', ['PRIVATE', 'SHARED', 'PUBLIC']);
export const shareScopeEnum = pgEnum('share_scope', ['ALL', 'PREFERRED']);
export const listingStatusEnum = pgEnum('listing_status', ['DRAFT', 'ACTIVE', 'UNDER_OFFER', 'SOLD', 'RENTED', 'WITHDRAWN']);

export const properties = pgTable('properties', {
  id: uuid('id').primaryKey(),
  agencyId: uuid('agency_id').notNull().references(() => agencies.id),
  ownerUserId: uuid('owner_user_id').notNull(),
  ref: text('ref').notNull(),
  source: text('source').notNull(),            // MANUAL | KYERO | ...
  externalRef: text('external_ref'),
  status: listingStatusEnum('status').notNull().default('DRAFT'),
  visibility: visibilityEnum('visibility').notNull().default('PRIVATE'),
  shareScope: shareScopeEnum('share_scope').notNull().default('ALL'),
  priceCents: bigint('price_cents', { mode: 'number' }),
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  shareCommissionBp: integer('share_commission_bp'),
  shareCommissionFixedCents: bigint('share_commission_fixed_cents', { mode: 'number' }),
  builtM2: numeric('built_m2', { precision: 10, scale: 2 }),
  bedrooms: integer('bedrooms'),
  locationId: uuid('location_id').notNull(),
  propertyTypeId: uuid('property_type_id').notNull(),
  lockedFields: text('locked_fields').array().notNull().default([]),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  // own-listings list in dashboard: where agency_id = ? order by created_at desc, id desc
  index('properties_agency_created_idx').on(t.agencyId, t.createdAt, t.id),
  // network search fallback: shared/public active listings by location + type + price
  index('properties_network_idx').on(t.visibility, t.status, t.locationId, t.propertyTypeId, t.priceCents),
  // re-import dedupe
  uniqueIndex('properties_source_ref_uq').on(t.agencyId, t.source, t.externalRef),
  uniqueIndex('properties_ref_uq').on(t.ref),
]);

// Private fields never readable by other tenants live in a STRICT side table.
export const propertyPrivates = pgTable('property_privates', {
  propertyId: uuid('property_id').primaryKey().references(() => properties.id),
  agencyId: uuid('agency_id').notNull(),
  cadastralRef: text('cadastral_ref'),
  sellerContactId: uuid('seller_contact_id'),
  internalNotes: text('internal_notes'),
});
```

```ts
// packages/db/src/tenancy/registry.ts — single source of truth for RLS + isolation tests
export type PolicyKind = 'STRICT' | 'NETWORK_READ' | 'PUBLIC_READ';

export const tenantTables: Record<string, { kind: PolicyKind; networkReadSql?: string }> = {
  property_privates: { kind: 'STRICT' },
  contacts: { kind: 'STRICT' },
  properties: {
    kind: 'NETWORK_READ',
    networkReadSql: `visibility in ('SHARED','PUBLIC') and status = 'ACTIVE' and deleted_at is null
      and app_agency_verified()
      and (share_scope = 'ALL' or app_is_preferred_by(agency_id))`,
  },
  // ...every table with agency_id must appear here; CI fails otherwise
};
```

`pnpm db:rls` generates and applies SQL like this (never hand-edit the output):

```sql
-- helper functions (created once; SECURITY DEFINER so they can read across tenants safely)
create or replace function app_agency() returns uuid language sql stable
  as $$ select nullif(current_setting('app.agency_id', true), '')::uuid $$;
create or replace function app_agency_verified() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from agencies where id = app_agency() and status = 'VERIFIED') $$;
create or replace function app_is_preferred_by(owner uuid) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from preferred_agencies
         where agency_id = owner and preferred_agency_id = app_agency()) $$;

alter table properties enable row level security;
alter table properties force row level security;
create policy own_rows on properties
  using (agency_id = app_agency()) with check (agency_id = app_agency());
create policy network_read on properties for select
  using (visibility in ('SHARED','PUBLIC') and status = 'ACTIVE' and deleted_at is null
         and app_agency_verified() and (share_scope = 'ALL' or app_is_preferred_by(agency_id)));
```

---

## §3 Tenant-scoped DB access

```ts
// packages/db/src/tenancy/scope.ts
import { sql } from 'drizzle-orm';
import { appDb, systemDb, type Tx } from '../client'; // appDb: role app_user · systemDb: role app_system

export async function withTenant<T>(scope: { agencyId: string; userId?: string }, fn: (tx: Tx) => Promise<T>) {
  return appDb.transaction(async (tx) => {
    // transaction-local settings: safe with PgBouncer transaction pooling
    await tx.execute(sql`select set_config('app.agency_id', ${scope.agencyId}, true),
                                set_config('app.user_id', ${scope.userId ?? ''}, true)`);
    return fn(tx);
  });
}

export async function withSystem<T>(reason: string, fn: (tx: Tx) => Promise<T>) {
  if (process.env.APP_ROLE === 'http') throw new Error('withSystem is not allowed in request paths');
  return systemDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_reason', ${reason}, true)`);
    return fn(tx);
  });
}

// Public read paths (portal, feed-api) use a read-only role restricted to read models + PUBLIC_READ tables.
export async function withPublicRead<T>(fn: (tx: Tx) => Promise<T>) { /* role app_public, read-only tx */ }
```

---

## §4 Context (`ctx`)

```ts
// packages/core/src/context.ts
export interface Ctx {
  tx: Tx;
  tenant: { agencyId: string; verified: boolean; plan: PlanTier; locales: Locale[] };
  actor:
    | { kind: 'user'; userId: string; role: Role; impersonatedBy?: string }
    | { kind: 'apiKey'; keyId: string; siteId: string; scopes: string[] }
    | { kind: 'system'; reason: string };
  locale: Locale;
  requestId: string;
  clientMode: boolean;
}
```

Apps build `ctx` once per request (see §10). Services never construct their own transactions except via helpers that take `ctx`.

---

## §5 Repo

```ts
// packages/core/src/modules/properties/repo.ts
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { properties } from '@inmolink/db/schema/properties';
import type { Tx } from '@inmolink/db';

const listColumns = {
  id: properties.id, ref: properties.ref, status: properties.status, visibility: properties.visibility,
  priceCents: properties.priceCents, currency: properties.currency, bedrooms: properties.bedrooms,
  locationId: properties.locationId, createdAt: properties.createdAt,
};

export async function listOwn(tx: Tx, agencyId: string, q: { limit: number; cursor?: { createdAt: Date; id: string } }) {
  const rows = await tx.select(listColumns).from(properties)
    .where(and(
      eq(properties.agencyId, agencyId),               // RLS also enforces; explicit filter lets the index work
      isNull(properties.deletedAt),
      q.cursor ? or(
        lt(properties.createdAt, q.cursor.createdAt),
        and(eq(properties.createdAt, q.cursor.createdAt), lt(properties.id, q.cursor.id)),
      ) : undefined,
    ))
    .orderBy(desc(properties.createdAt), desc(properties.id))
    .limit(q.limit + 1);                               // +1 to know if there is a next page
  return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

export async function getForUpdate(tx: Tx, id: string) {
  const [row] = await tx.select().from(properties).where(eq(properties.id, id)).for('update');
  return row ?? null;
}

export async function updateWithVersion(tx: Tx, id: string, version: number, patch: Partial<typeof properties.$inferInsert>) {
  const [row] = await tx.update(properties)
    .set({ ...patch, version: sql`${properties.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(properties.id, id), eq(properties.version, version)))
    .returning();
  return row ?? null;                                  // null → version conflict
}
```

---

## §6 Policy

```ts
// packages/core/src/modules/properties/policy.ts
import { AppError } from '@inmolink/contracts';
import type { Ctx } from '../../context';

type Action = 'listing.create' | 'listing.update' | 'listing.delete' | 'listing.publish';

export function can(ctx: Ctx, action: Action, listing?: { agencyId: string; ownerUserId: string }): boolean {
  if (ctx.actor.kind !== 'user') return false;
  if (ctx.clientMode && action !== 'listing.create') return false;      // Client Mode is read-only
  const sameAgency = !listing || listing.agencyId === ctx.tenant.agencyId;
  switch (action) {
    case 'listing.create': return true;
    case 'listing.update':
    case 'listing.delete':
      return sameAgency && (ctx.actor.role === 'AGENCY_ADMIN' || listing?.ownerUserId === ctx.actor.userId);
    case 'listing.publish':
      return sameAgency && ctx.tenant.verified;
  }
}

export function assertCan(...args: Parameters<typeof can>) {
  if (!can(...args)) throw new AppError('FORBIDDEN');
}
```

---

## §7 Service

```ts
// packages/core/src/modules/properties/service.ts
import { AppError } from '@inmolink/contracts';
import type { UpdateListingInput, ListingDto } from '@inmolink/contracts/properties';
import { emit } from '@inmolink/platform/outbox';
import * as repo from './repo';
import { assertCan } from './policy';
import { listingEvents } from './events';
import { toListingDto } from './mappers';

export async function updateListing(ctx: Ctx, input: UpdateListingInput): Promise<ListingDto> {
  const current = await repo.getForUpdate(ctx.tx, input.id);
  if (!current) throw new AppError('LISTING_NOT_FOUND');          // also what other tenants see (RLS)
  assertCan(ctx, 'listing.update', current);
  if (input.visibility && input.visibility !== 'PRIVATE') assertCan(ctx, 'listing.publish', current);

  const updated = await repo.updateWithVersion(ctx.tx, current.id, input.version, toPatch(input));
  if (!updated) throw new AppError('VERSION_CONFLICT');

  if (updated.priceCents !== current.priceCents) {
    await repo.insertPriceHistory(ctx.tx, { propertyId: current.id, agencyId: current.agencyId,
      fromCents: current.priceCents, toCents: updated.priceCents });
  }

  // same transaction → the event exists if and only if the change committed
  await emit(ctx.tx, listingEvents.updated({
    listingId: updated.id, agencyId: updated.agencyId, version: updated.version,
    changed: changedFields(current, updated),
  }));

  return toListingDto(updated, { clientMode: ctx.clientMode });
}
```

Rules shown here: authorization in the service, optimistic concurrency, history rows, outbox emit in the same transaction, DTO mapping that respects Client Mode, no network calls.

---

## §8 Events + outbox

```ts
// packages/core/src/modules/properties/events.ts
import { z } from 'zod';
import { defineEvent } from '@inmolink/platform/outbox';

export const listingEvents = {
  updated: defineEvent('properties.listing.updated', 1, z.object({
    listingId: z.string().uuid(), agencyId: z.string().uuid(), version: z.number().int(),
    changed: z.array(z.string()),
  })),
  // created, deleted, statusChanged, visibilityChanged ...
};
```

```ts
// packages/core/src/modules/search/subscriptions.ts — consumers subscribe by event type
import { subscribe } from '@inmolink/platform/outbox';
import { listingEvents } from '@inmolink/core/modules/properties';
import { searchJobs } from './jobs';

subscribe(listingEvents.updated, (e) =>
  searchJobs.reindexListing.enqueue(
    { listingId: e.listingId, version: e.version },
    { debounceMs: 5_000 },                         // collapse bursts of edits per listing
  ));
```

The dispatcher (`apps/worker` pool `outbox`) claims rows with `FOR UPDATE SKIP LOCKED`, calls subscribers, marks `processed_at`. Consumers must be idempotent and ignore stale versions.

---

## §9 Contracts + errors

```ts
// packages/contracts/src/properties.ts
import { z } from 'zod';
import { Money, Cursor, Locale } from './common';

export const ListingDto = z.object({
  id: z.string().uuid(), ref: z.string(), status: z.enum(['DRAFT','ACTIVE','UNDER_OFFER','SOLD','RENTED','WITHDRAWN']),
  visibility: z.enum(['PRIVATE','SHARED','PUBLIC']), price: Money.nullable(),
  shareCommission: z.object({ bp: z.number().int().nullable(), fixed: Money.nullable() }).nullable(), // null in Client Mode
  version: z.number().int(), updatedAt: z.string().datetime(),
});
export type ListingDto = z.infer<typeof ListingDto>;

export const UpdateListingBody = z.object({
  version: z.number().int(),
  priceCents: z.number().int().positive().optional(),
  visibility: z.enum(['PRIVATE','SHARED','PUBLIC']).optional(),
  shareScope: z.enum(['ALL','PREFERRED']).optional(),
  lockedFields: z.array(z.string()).optional(),
}).strict();
export type UpdateListingInput = z.infer<typeof UpdateListingBody> & { id: string };
```

```ts
// packages/contracts/src/errors.ts
export const ErrorCodes = {
  FORBIDDEN: 403, NOT_AUTHENTICATED: 401, VALIDATION_FAILED: 422, VERSION_CONFLICT: 409,
  PLAN_REQUIRED: 402, VERIFICATION_REQUIRED: 403, RATE_LIMITED: 429,
  LISTING_NOT_FOUND: 404, /* modules add their codes here */
} as const;
export type ErrorCode = keyof typeof ErrorCodes;
export class AppError extends Error {
  constructor(public code: ErrorCode, public details?: Record<string, unknown>, public retryable = false) { super(code); }
}
```

---

## §10 Dashboard route (apps/api)

```ts
// apps/api/src/routes/properties/listings.ts
import type { FastifyZod } from '../../types';
import { IdParams, UpdateListingBody, ListingDto } from '@inmolink/contracts/properties';
import * as properties from '@inmolink/core/modules/properties';

export async function listingRoutes(app: FastifyZod) {
  app.patch('/listings/:id', {
    schema: {
      tags: ['properties'], operationId: 'properties.updateListing', summary: 'Update a listing',
      params: IdParams, body: UpdateListingBody, response: { 200: ListingDto },
    },
    preHandler: [app.requireSession],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, (req) => app.withCtx(req, (ctx) => properties.updateListing(ctx, { id: req.params.id, ...req.body })));
}
```

`app.withCtx(req, fn)` (plugin in `apps/api/src/plugins/ctx.ts`) resolves the session, opens `withTenant`, builds `ctx`, runs `fn`, and lets the error plugin map `AppError`. Handlers stay one expression long.

---

## §11 feed-api route (public website traffic)

```ts
// apps/feed-api/src/routes/v2/listings.ts
import * as websites from '@inmolink/core/modules/websites';
import { cacheControl, weakCompareEtag } from '@inmolink/platform/http';

export async function listingDetailRoute(app: FastifyZod) {
  app.get('/v2/listings/:ref', {
    schema: { tags: ['website-v2'], operationId: 'websiteV2.getListing',
      params: RefParams, querystring: LangQuery, response: { 200: WebsiteListingDetail } },
    preHandler: [app.requireApiKey('listings:read')],          // resolves req.site (cached 60 s)
  }, async (req, reply) => {
    // ≤ 3 queries: read model by (ref, locale) + site content + override — all PK lookups
    const doc = await websites.getListingDetail(req.site, { ref: req.params.ref, locale: req.query.lang });
    if (!doc) throw new AppError('LISTING_NOT_FOUND');

    reply.header('Cache-Control', cacheControl.feed({ sMaxAge: 300 }))  // + SWR + stale-if-error=86400
         .header('ETag', doc.etag)
         .header('Vary', 'Accept-Encoding');
    if (weakCompareEtag(req.headers['if-none-match'], doc.etag)) return reply.code(304).send();
    return doc.body;                                                  // already white-labelled for this site
  });
}
```

---

## §12 Worker job

```ts
// packages/core/src/modules/search/jobs.ts
import { z } from 'zod';
import { defineJob } from '@inmolink/platform/queue';
import { withSystem } from '@inmolink/db';

export const searchJobs = {
  reindexListing: defineJob({
    name: 'search.reindexListing',
    pool: 'indexing',
    payload: z.object({ listingId: z.string().uuid(), version: z.number().int() }),
    jobId: (p) => `reindex:${p.listingId}:${p.version}`,          // idempotent
    attempts: 5, backoff: { type: 'exponential', delay: 2_000 },
    async run(p, { log, search }) {
      const docs = await withSystem('search.reindexListing', (tx) => buildSearchDocs(tx, p.listingId));
      if (!docs) return search.delete(p.listingId);                 // deleted or no longer visible
      if (docs.version < p.version) throw new RetryableError('read model behind');
      await search.upsert(docs.items);                              // network call OUTSIDE the transaction
      log.info({ listingId: p.listingId }, 'reindexed');
    },
  }),

  importFeed: defineJob({
    name: 'imports.runFeed',
    pool: 'imports',
    payload: z.object({ connectionId: z.string().uuid(), agencyId: z.string().uuid(), runId: z.string().uuid() }),
    jobId: (p) => `feed:${p.runId}`,
    group: (p) => p.agencyId,                                       // fair share per tenant
    concurrencyPerGroup: 1,
    async run(p, ctx) { /* stream → staging → MERGE (§13), progress via ctx.progress() */ },
  }),
};
```

`apps/worker/src/processors/indexing.ts` only does `registerPool('indexing', [searchJobs.reindexListing, ...])`.

---

## §13 Bulk load (feeds, migration)

```ts
// packages/core/src/modules/imports/load.ts
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { getPgClient } from '@inmolink/db';

export async function loadBatch(agencyId: string, rows: AsyncIterable<StagingRow>) {
  const client = await getPgClient('app_user');
  try {
    await client.query('begin');
    await client.query(`select set_config('app.agency_id', $1, true)`, [agencyId]);
    await client.query(`create temp table stg (like import_staging including defaults) on commit drop`);
    await pipeline(toCsvStream(rows), client.query(copyFrom(`copy stg (${STAGING_COLUMNS}) from stdin with (format csv)`)));

    // PostgreSQL 17+: MERGE ... RETURNING lets us emit outbox events for exactly what changed
    const { rows: changed } = await client.query(`
      merge into properties p
      using stg s on (p.agency_id = s.agency_id and p.source = s.source and p.external_ref = s.external_ref)
      when matched and s.hash <> p.import_hash then update set
        price_cents = case when 'price' = any(p.locked_fields) then p.price_cents else s.price_cents end,
        bedrooms    = case when 'bedrooms' = any(p.locked_fields) then p.bedrooms else s.bedrooms end,
        import_hash = s.hash, version = p.version + 1, updated_at = now()
      when not matched then insert (id, agency_id, ref, source, external_ref, price_cents, bedrooms, import_hash, ...)
        values (s.id, s.agency_id, s.ref, s.source, s.external_ref, s.price_cents, s.bedrooms, s.hash, ...)
      returning merge_action() as action, p.id, p.version`);

    await insertOutboxBulk(client, changed.map(toListingEvent));   // one INSERT ... SELECT unnest(...)
    await client.query('commit');
    return summarize(changed);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
```

Chunk feeds into batches of ~2,000 listings; images are queued separately (hash-first, §7 media).

---

## §14 Read models

```ts
// packages/core/src/modules/search/read-models.ts — consumer of listing events
export async function rebuildListingReadModel(tx: Tx, listingId: string) {
  // ≤ 4 queries: listing+private-safe fields · translations · media (ordered) · taxonomy names (cached)
  const data = await loadListingAggregate(tx, listingId);
  if (!data || !isPubliclyRelevant(data)) return deleteReadModels(tx, listingId);

  for (const locale of data.enabledLocales) {
    const card = buildCard(data, locale);          // small JSON for lists/search results
    const detail = buildDetail(data, locale);      // full JSON for detail pages (no owner contact!)
    await tx.insert(listingReadModels).values({
      listingId, locale, version: data.version, card, detail, etag: hashOf(card, detail),
    }).onConflictDoUpdate({
      target: [listingReadModels.listingId, listingReadModels.locale],
      set: { version: data.version, card, detail, etag: hashOf(card, detail), updatedAt: sql`now()` },
      where: sql`excluded.version >= ${listingReadModels.version}`,   // never go backwards
    });
  }
}
```

White-labelling is **not** baked into read models; it is applied per site at serialization (§11), together with overrides and site content.

---

## §15 Cache

```ts
import { cache } from '@inmolink/platform/cache';

// read-through with single-flight (stampede protection) and tags for invalidation
const taxonomy = await cache.get(
  `v1:taxonomy:${locale}`,
  { ttlSeconds: 3600, tags: ['taxonomy'] },
  () => taxonomyRepo.loadAll(tx, locale),
);

// invalidation is event-driven, never inline in a request
subscribe(taxonomyEvents.changed, () => cache.invalidateTag('taxonomy'));
```

Key format: `v<schema>:<module>:<entity>:<id>[:<locale>]`. Never cache per-user data under shared keys. In-process LRU (60 s) only for taxonomy and site configs.

---

## §16 Safe fetch + streaming XML

```ts
import { safeFetch } from '@inmolink/platform/safe-fetch';
import { SaxesParser } from 'saxes';   // no external entity / DTD expansion

const res = await safeFetch(connection.url, {
  timeoutMs: 120_000, maxBytes: 500 * 1024 * 1024, allowedContentTypes: ['application/xml', 'text/xml'],
});                                     // blocks private/loopback/metadata IPs, re-checks after redirects

const parser = new SaxesParser({ xmlns: false });
parser.on('doctype', () => { throw new AppError('FEED_DTD_NOT_ALLOWED'); });
// push `res.body` chunks into the parser; emit one property object per <property> element;
// never accumulate the whole document in memory.
```

---

## §17 AI call

```ts
import { ai } from '@inmolink/platform/ai';
import { ListingCopy } from './ai-schemas';

const copy = await ai.structured(ctx, {
  feature: 'listing-studio.describe',
  prompt: { id: 'listing-studio', version: 3 },     // prompts/listing-studio/v3.md
  tier: 'FAST',                                      // → env AI_MODEL_FAST
  input: { facts: factsFrom(listing), locale, tone },
  schema: ListingCopy,                               // Zod; validated, one retry on invalid output
  cacheKey: hashOf(listing.factsHash, locale, tone),
});
assertFactsUnchanged(copy, listing);                 // numbers in text must match data
await repo.saveTranslation(ctx.tx, { ..., origin: 'AI_DRAFT' });
```

Bulk (translations, unique site content) uses `ai.batch(...)` from a job in the `ai` pool; never from a request.

---

## §18 Dashboard page (apps/web)

```tsx
// apps/web/app/[locale]/(app)/listings/page.tsx — server component shell
import { getTranslations } from 'next-intl/server';
import { ListingsTable } from './listings-table';

export default async function ListingsPage() {
  const t = await getTranslations('listings');
  return (
    <section>
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <ListingsTable />
    </section>
  );
}
```

```tsx
// apps/web/app/[locale]/(app)/listings/listings-table.tsx
'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';                      // generated typed client
import { DataTable } from '@inmolink/ui/data-table';  // virtualized for > 200 rows

export function ListingsTable() {
  const q = useInfiniteQuery({
    queryKey: ['listings'],
    queryFn: ({ pageParam }) => api.properties.listListings({ cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });
  return <DataTable rows={q.data?.pages.flatMap((p) => p.items) ?? []} onEndReached={() => q.fetchNextPage()} />;
}
```

Maps, charts and editors: `const ListingMap = dynamic(() => import('./listing-map'), { ssr: false, loading: () => <MapSkeleton /> })`.

---

## §19 Public page (apps/public)

```tsx
// apps/public/app/[locale]/property/[slug]/page.tsx
import { notFound, permanentRedirect } from 'next/navigation';
import * as portal from '@inmolink/core/modules/websites/portal';   // read services only
import { serializeJsonLd } from '@/lib/seo';                          // escapes </script>

export const revalidate = 300;

export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  const l = await portal.getListingBySlug({ locale, slug });
  return l ? portal.metadataFor(l, locale) : {};                       // title, description, canonical, hreflang, OG
}

export default async function PropertyPage({ params }: Props) {
  const { locale, slug } = await params;
  const listing = await portal.getListingBySlug({ locale, slug });
  if (!listing) {
    const to = await portal.resolveRedirect({ locale, path: `/property/${slug}` });
    if (to) permanentRedirect(to);                                     // 301, never 404 for known URLs
    notFound();
  }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(portal.jsonLd(listing)) }} />
      <ListingDetail listing={listing} />
    </>
  );
}
```

---

## §20 Tests

```ts
// packages/core/src/modules/properties/__tests__/service.int.test.ts
import { describe, it, expect } from 'vitest';
import { factories, asAgency, countQueries, outboxEvents } from '@inmolink/core/test';
import * as properties from '../index';

describe('properties.updateListing', () => {
  it('[S3-02] another agency cannot update the listing', async () => {
    const [a, b] = await factories.agencies(2, { verified: true });
    const listing = await factories.listing({ agency: a });
    await expect(asAgency(b, (ctx) => properties.updateListing(ctx, { id: listing.id, version: 1, priceCents: 1 })))
      .rejects.toMatchObject({ code: 'LISTING_NOT_FOUND' });
  });

  it('[S3-02] emits properties.listing.updated in the same transaction', async () => {
    const a = await factories.agency({ verified: true });
    const listing = await factories.listing({ agency: a });
    await asAgency(a, (ctx) => properties.updateListing(ctx, { id: listing.id, version: 1, priceCents: 500_000_00 }));
    expect(await outboxEvents('properties.listing.updated')).toHaveLength(1);
  });

  it('[S3-07] own-listings page uses ≤ 10 queries', async () => {
    const a = await factories.agency();
    await factories.listings(60, { agency: a });
    const n = await countQueries(() => asAgency(a, (ctx) => properties.listListings(ctx, { limit: 50 })));
    expect(n).toBeLessThanOrEqual(10);
  });
});
```

- `asAgency(agency, fn)` builds a real `ctx` via `withTenant` — the same path production uses.
- Isolation tests are generated from the registry (`tests/isolation/generated.test.ts`) — do not hand-write them per table.
- External HTTP via MSW fixtures in `tests/fixtures/<provider>/`.

---

## §21 i18n

```ts
// packages/i18n/messages/en/listings.json → { "title": "Listings", "price": "Price" }
// Server: const t = await getTranslations('listings');   Client: const t = useTranslations('listings');
// Formatting: format.number(price.amountCents / 100, { style: 'currency', currency: price.currency })
```

- EN and ES are written by hand for every key; `pnpm i18n:draft` creates AI drafts for every other configured locale and marks them `draft` for review.
- Listing content languages (9) are separate from UI languages; both come from `packages/i18n/src/locales.ts`.
