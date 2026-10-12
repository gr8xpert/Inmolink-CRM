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
├── index.ts          # public API — the ONLY import path for other modules and apps (audit writes: §8 exception)
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
  commissionBp: integer('commission_bp'),            // total commission, basis points of the sale price (agency default 500 = 5 %)
  commissionFixedCents: bigint('commission_fixed_cents', { mode: 'number' }), // a fixed amount instead of a %
  splitBp: integer('split_bp'),                      // collaborating agent's share of it (agency default 5000 = 50/50)
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
// packages/db/src/tenancy/registry.ts — single source of truth for RLS, grants + isolation tests
export const tenantTables: Record<string, TenantTable> = {
  property_privates: { kind: 'STRICT' },
  contacts: { kind: 'STRICT' },
  properties: {
    kind: 'NETWORK_READ',
    networkReadSql: `visibility in ('SHARED','PUBLIC') and status = 'ACTIVE' and deleted_at is null
      and app_agency_verified()
      and (share_scope = 'ALL' or app_is_preferred_by(agency_id))`,
    base: { location_id: '…' },             // values the isolation suite cannot invent
    samples: {                               // rows on each side of the predicate, for the generated suite
      visible: [{ visibility: 'SHARED', status: 'ACTIVE' }],
      hidden: [{ visibility: 'PRIVATE', status: 'ACTIVE' }, { visibility: 'SHARED', status: 'DRAFT' }],
    },
  },
  listing_read_models: { kind: 'PUBLIC_READ', publicReadSql: 'true', samples: { visible: [{}], hidden: [] } },
  // ...every table with agency_id must appear here; the guard fails otherwise
};
// Tables without agency_id: read-only for app_user, written by app_system (withSystem), app_public only if publicRead.
export const globalTables: Record<string, GlobalTable> = {
  locations: { reason: 'shared reference data', publicRead: true },
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
create policy own_rows on properties to app_user
  using (agency_id = app_agency()) with check (agency_id = app_agency());
create policy network_read on properties for select to app_user
  using (app_agency() is not null and (visibility in ('SHARED','PUBLIC') and status = 'ACTIVE' and deleted_at is null
         and app_agency_verified() and (share_scope = 'ALL' or app_is_preferred_by(agency_id))));
revoke all on table properties from app_user, app_system, app_public;
grant select, insert, update, delete on table properties to app_user, app_system;
-- PUBLIC_READ adds: create policy public_read … for select to app_public using (…); grant select … to app_public;
```

NETWORK_READ and PUBLIC_READ share whole rows (RLS is row-level): such tables hold only shareable columns; private fields go in a STRICT side table (`property_privates`). Forced RLS binds `app_owner` too, so data backfills belong in a `withSystem()` job, not in a migration.

Write-only queues (the outbox) register as `{ kind: 'STRICT', appendOnly: true }`: `app_user` may only INSERT its own agency's rows (no SELECT/UPDATE/DELETE); reads and acknowledgements go through `withSystem()`.

Append-only history (`audit_logs`, S1-08) registers as `{ kind: 'STRICT', immutable: true, partitioned: true }`: no app role — `app_system` included — gets UPDATE or DELETE (only SELECT/INSERT; `auth`/`staff` may open SELECT/INSERT, never UPDATE). Monthly partitions come from pg_partman (`partman.create_parent` in a separate custom migration after the table's, premake 4, `infinite_time_partitions`, no default partition, retention off unless a task sets one), with BEFORE UPDATE/DELETE and TRUNCATE triggers that refuse changes even for the owner; the generated `app_partition_maintenance()` (SECURITY DEFINER, owner `app_owner`, executable by `app_system` only) runs maintenance from the hourly `compliance.maintainPartitions` job. The primary key and every unique index include the partition column.

Identity data (`users`, `auth_tokens`) registers as a global table with `access: 'auth'`: only `app_auth` (`withAuth()`, the anonymous auth flows) and `app_system` reach it — `app_user` cannot even read it. `authAppend: true` on the outbox lets `app_auth` append platform events (nil agency) only. Services for those flows take `AuthCtx { requestId, transaction }` and do password hashing before opening the transaction (ADR 0004).

Grants come only from `pnpm db:rls` — app roles have no default privileges, so an unregistered table is unreachable. The guard (`checkRls`, run by `db:rls` and `pnpm test:isolation`) fails on: a `public` table not in the registry, `agency_id` on a global table, RLS off or not forced, missing or extra policies, stale entries, `app_public` grants on non-public tables, and direct grants on partitions, altered policies (command/roles), any privilege beyond the generated set (TRUNCATE, column grants), accessible views/materialized views/foreign tables or objects outside `public`, and functions an app role can execute other than the generated helpers.

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

The real `withTenant`, `withSystem` and `withStaff` (S1-F3) send the settings in the BEGIN round trip — `begin; select set_config(…), …` as one simple-protocol query with driver-escaped literals — so a request with one query costs three round trips (begin + settings, the query, commit), not four. `countQueries(fn)` (`@inmolink/db`, re-exported by `@inmolink/core/test`) counts the statements Drizzle sends while `fn` runs, excluding `begin`/`commit`/`rollback` unless asked (`{ includeTransactionControl: true }`); budgets in tests are written in statements. `withGlobalRead(fn)` is `app_user`, read-only, no tenant: for global tables every tenant may read (`feature_flags`), and for platform adapters that must not run on a request's transaction — the feature-flag reload uses it (`configureFlagReader`, wired by core's `configureDb`).

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

**Network I/O between two transactions** (uploads: check → store the file → record it): the use case takes a `CtxRunner` (`(fn) => withCtx(req, fn)`) instead of a `ctx`, and opens one short transaction per step, with the I/O between them and never inside one (S1-03 `agencies.uploadVerificationDocument`). Undo the I/O if the second step fails.

**Staff** (ADR 0015): staff use cases take `StaffCtx` — `{ tx, actor: { kind: 'staff', userId, role }, locale, requestId }`, no tenant — built by `withStaffCtx({ userId, requestId, reason }, fn)` over `withStaff()` (`app_staff`, RLS on). Authorize with the module's `canStaff(ctx, action)`. Tables reach staff only through registry `staff` predicates (§2), and guard triggers say which columns staff may change.

**Impersonation** (S1-09, ADR 0015 amendment): an impersonated request is an ordinary member `ctx` with `actor.impersonatedBy` set — built only by `withMemberCtx` after it checked the open session; `withTenant` then sets `app.impersonated_by`, which RLS requires on every `audit_logs` row. Services never read the field directly: record it with `impersonatorOf(ctx)` (events) or `compliance.audit(ctx, …)`. What staff may do while impersonating is decided per policy action: each module exports `<MODULE>_ACTIONS` (`as const`) and a `<MODULE>_IMPERSONATION: ImpersonationRules<Action>` map (`'allowed' | 'forbidden'` for every action — a new action does not compile without a decision), and `can()` starts with `if (deniedByImpersonation(ctx, RULES, action)) return false` (missing entries deny). The module's policy test calls `expectImpersonationRules(…)` (`packages/core/src/testing/impersonation-rules.ts`). Never a local `impersonatedBy` check. Tests that need an impersonated `ctx` without a session use `impersonatedCtx(ctx, staffId)` from `@inmolink/core/test`.

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

**Keyset on timestamps (S1-09 review):** Postgres keeps microseconds, a cursor (`Date`) only milliseconds — comparing the raw column skips rows (newest first) or repeats them (oldest first) when two rows share a millisecond. Use `keysetAfter(col, idCol, cursor, dir)` in the WHERE and `...keysetOrder(col, idCol, dir)` in ORDER BY (`packages/core/src/pagination.ts`): both work on `date_trunc('milliseconds', col)`. That gives up the index's order (a sort of the filtered rows), fine for per-agency lists and small staff lists; for a large hot list, write the column at millisecond precision (`date_trunc('milliseconds', now())`, like `audit_logs`) and keyset on the raw column.

**Indexes on partitioned tables (S1-09 review, migration 0027):** a plain `CREATE INDEX` on a partitioned parent builds every partition's index under a lock that blocks writes. Fine while the tables are small; at scale use `CREATE INDEX … ON ONLY parent` (invalid until attached), then `CREATE INDEX CONCURRENTLY` on each partition and `ALTER INDEX parent_idx ATTACH PARTITION partition_idx`, in a custom migration (no transaction for the concurrent steps).

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

The dispatcher (`apps/worker` pool `outbox`, `createDispatcher({ runSystem: withSystem, logger })`; it polls every 250 ms, no LISTEN/NOTIFY — ADR 0014, implemented in S1-F2) leases rows with `FOR UPDATE SKIP LOCKED`, shared fairly between the agencies that have due rows (one agency's import never delays another agency's event by more than one batch), calls subscribers outside any transaction, then marks `processed_at` (or retries with backoff / dead-letters; `pnpm ops:replay-outbox` re-queues). Delivery is at least once: consumers must be idempotent and ignore stale versions. **Each subscriber is idempotent on its own:** delivery is tracked per event, not per subscriber, so when one subscriber of an event fails, the retry re-runs every subscriber of that event — the ones that already succeeded included. Enqueue with a stable `jobId`, upsert, or check state before acting; never count on running once. Use `meta.agencyId` (RLS-checked) — not a payload field — as the tenant and fair-share group. Payloads ≤ 10 KB (IDs only).

**Named exception — the audit log (S1-08).** Cross-module reactions go through events, except audit rows: a module that performs a security-relevant action calls `compliance.audit(ctx, type, target, metadata)` (or `auditStaff(staffCtx, …)`, `auditSystem(tx, …)`) synchronously in the transaction of the change, so the row exists if and only if the change commits and carries the request id and both actors. One INSERT, no network. `compliance` imports no other module, so any module may call it. Anonymous auth flows use `auditAuth(tx, …)`: it narrows the `app_auth` scope to the user (RLS checks the agency is the user's own membership) for the INSERT and restores the caller's scope afterwards, so it is safe mid-transaction. Failed attempts (login, 2FA) are audited in their own short transaction before the error.

---

## §9 Contracts + errors

```ts
// packages/contracts/src/properties.ts
import { z } from 'zod';
import { Money, Cursor, Locale } from './common';

export const ListingDto = z.object({
  id: z.string().uuid(), ref: z.string(), status: z.enum(['DRAFT','ACTIVE','UNDER_OFFER','SOLD','RENTED','WITHDRAWN']),
  visibility: z.enum(['PRIVATE','SHARED','PUBLIC']), price: Money.nullable(),
  commission: z.object({ bp: z.number().int().nullable(), fixed: Money.nullable(), splitBp: z.number().int() }).nullable(), // null in Client Mode
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
    onRequest: [app.requireSession],   // onRequest, so the user/tenant rate limits (preHandler) see the caller
    config: { rateLimit: [
      { name: 'properties.write.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
      { name: 'properties.write.user', scope: 'user', limit: 120, windowSeconds: 60 },
    ] },
  }, (req) => app.withCtx(req, (ctx) => properties.updateListing(ctx, { id: req.params.id, ...req.body })));
}
```

Staff routes use `app.withStaffCtx(req, '<module>.<useCase>', (ctx) => …)` (the reason is set on the transaction for audit); tokens with an agency claim and non-staff users get 403. Upload routes register their binary body parser in their own child plugin, so no other route accepts binary bodies.

`app.requireSession` (`apps/api/src/plugins/session.ts`) verifies the `Authorization: Bearer` access token (audience `api`, 15 min, minted by web at `/session/token`) and sets `request.auth`; the API never reads cookies. `app.withCtx(req, fn)` (`apps/api/src/plugins/ctx.ts`) takes the caller's membership from `request.auth`, opens `withTenant`, builds `ctx`, runs `fn`, and lets the error plugin map `AppError`. Handlers stay one expression long.

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
import { cache, cacheKey } from '@inmolink/platform/cache';

// Keys come only from cacheKey(): every key names its scope — 'global' or the agency whose RLS the loader ran under.
const key = cacheKey({ v: 1, module: 'taxonomy', entity: 'tree', scope: 'global', locale });

// read-through with single-flight (stampede protection) and tags for invalidation
const taxonomy = await cache.get(key, { ttlSeconds: 3600, tags: ['taxonomy'], local: true }, () =>
  taxonomyRepo.loadAll(tx, locale),
);

// invalidation is event-driven, never inline in a request
subscribe(taxonomyEvents.changed, () => cache.invalidateTag('taxonomy'));
```

Key format (built by `cacheKey`): `v<schema>:<module>:<entity>:<g|a.<agencyId>>[:i.<id>][:l.<locale>][:agent|client]`. Tenant data is always `scope: { agencyId }`; Client Mode output sets `view: 'client'`. Never cache per-user data under shared keys. Values are JSON (a miss returns the same round trip as a hit). `local: true` (in-process LRU, ≤ 60 s, deep-frozen outside production) only for taxonomy and site configs. When redis-cache is down, `get` runs the loader uncached.

Rate limits (`@inmolink/platform/rate-limit`): register `rateLimitPlugin` with `identify.ip: (r) => ipBucket(r.ip)` (Fastify `trustProxy` = hop count or CIDR list, never `true`); route rules go in `config.rateLimit`, `false` opts out. Rule names `auth.*`, `password.*`, `2fa.*` must set `failClosed: true`.

Feature flags (`@inmolink/platform/flags`): `await flag(ctx, 'area.feature')` — one query per process per 60 s. Staff write with `setFlag`/`setFlagOverride` inside `withSystem()`, then `invalidateFlags()` after commit.

Object storage (`@inmolink/platform/storage`, S1-03): `storage().put(bucket, key, bytes, { contentType })`, `delete`, `head`, `signedGetUrl(bucket, key, { expiresInSeconds ≤ 3600, downloadName })`. Buckets `media`, `exports`, `private` (never public; signed URLs only). Keys are built from IDs, never from file names. Check uploads with `detectFileType(bytes)` (magic bytes) against an allowlist. All of it is network I/O: outside transactions.

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
- Isolation tests are generated from the registry (`tests/isolation/generated.int.test.ts`) — do not hand-write them per table. Register a table → it is covered.
- Integration tests never commit tables, views or functions in `public`: `pnpm test:isolation` runs in parallel and its guard fails on anything unregistered. Probe DDL goes in one transaction that is rolled back (see `packages/db/src/tenancy/scope.int.test.ts`).
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
