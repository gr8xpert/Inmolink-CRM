import { type BillingCurrency, type BillingInterval, FREE_PLAN, type SubscriptionStatus } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  billingCatalogItems,
  billingCustomers,
  billingInvoices,
  billingPlanGrants,
  billingPriceLocks,
  billingPrices,
  billingStripeEvents,
  billingSubscriptions,
} from '@inmolink/db/schema/billing';
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type KeysetCursor, rowAfter, rowOrder } from '../../pagination';

/**
 * billing queries (PATTERNS §5). Takes `tx`, selects only the columns it needs, paginates by cursor.
 * Queries only `@inmolink/db/schema/billing` — other modules' tables fail `pnpm check:boundaries`.
 */

export interface CatalogPriceRow {
  itemId: string;
  code: string;
  kind: 'PLAN' | 'ADDON';
  seatsIncluded: number | null;
  rank: number;
  features: string[];
  priceId: string | null;
  interval: BillingInterval | null;
  currency: string | null;
  amountCents: number | null;
  stripePriceId: string | null;
  /** S13-02: the item's Stripe product (a founding coupon applies to it only). */
  stripeProductId: string | null;
}

/** Active catalog items with their active prices that Stripe knows (synced): what members may buy. ≤ a few dozen rows. */
export async function offeredCatalog(tx: Tx): Promise<CatalogPriceRow[]> {
  return tx
    .select({
      itemId: billingCatalogItems.id,
      code: billingCatalogItems.code,
      kind: billingCatalogItems.kind,
      seatsIncluded: billingCatalogItems.seatsIncluded,
      rank: billingCatalogItems.rank,
      features: billingCatalogItems.features,
      priceId: billingPrices.id,
      interval: billingPrices.interval,
      currency: billingPrices.currency,
      amountCents: billingPrices.amountCents,
      stripePriceId: billingPrices.stripePriceId,
      stripeProductId: billingCatalogItems.stripeProductId,
    })
    .from(billingCatalogItems)
    .leftJoin(
      billingPrices,
      and(
        eq(billingPrices.itemId, billingCatalogItems.id),
        eq(billingPrices.active, true),
        isNotNull(billingPrices.stripePriceId),
      ),
    )
    .where(eq(billingCatalogItems.active, true))
    .orderBy(asc(billingCatalogItems.rank), asc(billingCatalogItems.code), asc(billingPrices.interval));
}

/** What our Stripe prices are (any, retired ones too: old subscriptions keep them). */
export async function pricesByStripeIds(
  tx: Tx,
  stripePriceIds: string[],
): Promise<Map<string, { code: string; kind: 'PLAN' | 'ADDON'; interval: BillingInterval; currency: string }>> {
  if (stripePriceIds.length === 0) return new Map();
  const rows = await tx
    .select({
      stripePriceId: billingPrices.stripePriceId,
      code: billingCatalogItems.code,
      kind: billingCatalogItems.kind,
      interval: billingPrices.interval,
      currency: billingPrices.currency,
    })
    .from(billingPrices)
    .innerJoin(billingCatalogItems, eq(billingCatalogItems.id, billingPrices.itemId))
    .where(inArray(billingPrices.stripePriceId, stripePriceIds));
  return new Map(rows.map((r) => [r.stripePriceId as string, r]));
}

export async function customerOf(tx: Tx, agencyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.agencyId, agencyId));
  return row?.id ?? null;
}

/**
 * Records the agency's Stripe customer and answers the one on record: a concurrent first checkout's row wins (the
 * create is idempotent per agency, so it is the same customer — the stored id is used either way).
 */
export async function insertCustomer(tx: Tx, agencyId: string, stripeCustomerId: string): Promise<string> {
  await tx.insert(billingCustomers).values({ agencyId, stripeCustomerId }).onConflictDoNothing();
  return (await customerOf(tx, agencyId)) ?? stripeCustomerId;
}

/** Webhook job: the agency a Stripe customer is ours for, or null (another account's customer, or never ours). */
export async function agencyOfCustomer(tx: Tx, stripeCustomerId: string): Promise<string | null> {
  const [row] = await tx
    .select({ agencyId: billingCustomers.agencyId })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId));
  return row?.agencyId ?? null;
}

const subscriptionColumns = {
  stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
  planCode: billingSubscriptions.planCode,
  status: billingSubscriptions.status,
  interval: billingSubscriptions.interval,
  currency: billingSubscriptions.currency,
  addons: billingSubscriptions.addons,
  paymentMethod: billingSubscriptions.paymentMethod,
  currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
  cancelAt: billingSubscriptions.cancelAt,
  pastDueSince: billingSubscriptions.pastDueSince,
};
export interface SubscriptionRow {
  stripeSubscriptionId: string;
  planCode: string;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currency: string | null;
  addons: { code: string; quantity: number }[];
  paymentMethod: string | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  pastDueSince: Date | null;
}

export async function subscriptionOf(tx: Tx, agencyId: string, forUpdate = false): Promise<SubscriptionRow | null> {
  const q = tx
    .select(subscriptionColumns)
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.agencyId, agencyId));
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export interface SubscriptionWrite {
  agencyId: string;
  stripeSubscriptionId: string;
  planCode: string;
  status: SubscriptionStatus;
  interval: BillingInterval | null;
  currency: BillingCurrency | null;
  addons: { code: string; quantity: number }[];
  paymentMethod: string | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  pastDueSince: Date | null;
  syncedAt: Date;
}

/** Webhook job: Stripe's state of the agency's subscription (replaces the row: one subscription per agency). */
export async function upsertSubscription(tx: Tx, row: SubscriptionWrite): Promise<void> {
  const { agencyId, ...rest } = row;
  await tx
    .insert(billingSubscriptions)
    .values(row)
    .onConflictDoUpdate({ target: billingSubscriptions.agencyId, set: rest });
}

export interface InvoiceWrite {
  id: string;
  agencyId: string;
  stripeInvoiceId: string;
  number: string | null;
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  currency: string;
  totalCents: number;
  taxCents: number;
  amountPaidCents: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  issuedAt: Date;
  syncedAt: Date;
}

/** Webhook job: Stripe's state of an invoice (keyed by Stripe's id; the agency never changes). */
export async function upsertInvoice(tx: Tx, row: InvoiceWrite): Promise<void> {
  const { id: _id, agencyId: _agencyId, stripeInvoiceId: _stripeId, issuedAt: _issuedAt, ...rest } = row;
  await tx
    .insert(billingInvoices)
    .values(row)
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: rest,
      // never move an invoice to another agency
      setWhere: eq(billingInvoices.agencyId, row.agencyId),
    });
}

const invoiceColumns = {
  id: billingInvoices.id,
  number: billingInvoices.number,
  status: billingInvoices.status,
  currency: billingInvoices.currency,
  totalCents: billingInvoices.totalCents,
  taxCents: billingInvoices.taxCents,
  amountPaidCents: billingInvoices.amountPaidCents,
  hostedUrl: billingInvoices.hostedUrl,
  pdfUrl: billingInvoices.pdfUrl,
  issuedAt: billingInvoices.issuedAt,
};
export type InvoiceRow = Awaited<ReturnType<typeof listInvoices>>[number];

/** The invoices list, newest first: `billing_invoices_agency_issued_idx` (issued_at is whole seconds: raw keyset). */
export async function listInvoices(tx: Tx, agencyId: string, q: { limit: number; cursor?: KeysetCursor | undefined }) {
  return tx
    .select(invoiceColumns)
    .from(billingInvoices)
    .where(
      and(eq(billingInvoices.agencyId, agencyId), rowAfter(billingInvoices.issuedAt, billingInvoices.id, q.cursor)),
    )
    .orderBy(...rowOrder(billingInvoices.issuedAt, billingInvoices.id))
    .limit(q.limit + 1);
}

/** Webhook job: true when the event was already applied. */
export async function eventSeen(tx: Tx, eventId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: billingStripeEvents.id })
    .from(billingStripeEvents)
    .where(eq(billingStripeEvents.id, eventId));
  return Boolean(row);
}

/** Webhook job: records the event in the transaction that applies it; false when another run recorded it first. */
export async function markEvent(tx: Tx, eventId: string, type: string): Promise<boolean> {
  const rows = await tx
    .insert(billingStripeEvents)
    .values({ id: eventId, type: type.slice(0, 100) })
    .onConflictDoNothing()
    .returning({ id: billingStripeEvents.id });
  return rows.length > 0;
}

/** Applied events older than `before`, at most `limit` (Stripe stops retrying an event after three days). */
export async function pruneEvents(tx: Tx, before: Date, limit: number): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from ${billingStripeEvents} where ${billingStripeEvents.id} in (
      select ${billingStripeEvents.id} from ${billingStripeEvents}
      where ${billingStripeEvents.processedAt} < ${before.toISOString()}::timestamptz
      limit ${limit}
    ) returning ${billingStripeEvents.id}`);
  return rows.rows.length;
}

// ---- catalog (seed, staff, sync) ----

export interface CatalogInput {
  code: string;
  kind: 'PLAN' | 'ADDON';
  seatsIncluded: number | null;
  rank: number;
  /** S13-02: gated features a plan includes (`PlanFeature` keys). */
  features?: string[];
  prices: { interval: BillingInterval; currency: BillingCurrency; amountCents: number }[];
}

/**
 * Upserts catalog items and their offered prices (seed and scripts, `withSystem`). A changed amount retires the old
 * price and adds a new one (Stripe prices are immutable; subscriptions on the old one keep it).
 */
export async function upsertCatalog(
  tx: Tx,
  items: CatalogInput[],
  newId: () => string,
): Promise<{ items: number; prices: number }> {
  let prices = 0;
  for (const item of items) {
    const [row] = await tx
      .insert(billingCatalogItems)
      .values({
        id: newId(),
        code: item.code,
        kind: item.kind,
        seatsIncluded: item.seatsIncluded,
        rank: item.rank,
        features: item.features ?? [],
      })
      .onConflictDoUpdate({
        target: billingCatalogItems.code,
        set: {
          kind: item.kind,
          seatsIncluded: item.seatsIncluded,
          rank: item.rank,
          features: item.features ?? [],
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: billingCatalogItems.id });
    const itemId = (row as { id: string }).id;
    const current = await tx
      .select({
        id: billingPrices.id,
        interval: billingPrices.interval,
        currency: billingPrices.currency,
        amountCents: billingPrices.amountCents,
      })
      .from(billingPrices)
      .where(and(eq(billingPrices.itemId, itemId), eq(billingPrices.active, true)));
    for (const p of item.prices) {
      const same = current.find((c) => c.interval === p.interval && c.currency === p.currency);
      if (same?.amountCents === p.amountCents) continue;
      if (same) await tx.update(billingPrices).set({ active: false }).where(eq(billingPrices.id, same.id));
      await tx.insert(billingPrices).values({ id: newId(), itemId, ...p });
      prices++;
    }
  }
  return { items: items.length, prices };
}

/** Catalog items without a Stripe product yet that have a price to sell (Free and Enterprise have none: S13-02). */
export async function itemsToSync(tx: Tx, limit: number) {
  return tx
    .select({ id: billingCatalogItems.id, code: billingCatalogItems.code })
    .from(billingCatalogItems)
    .where(
      and(
        isNull(billingCatalogItems.stripeProductId),
        exists(
          tx
            .select({ one: sql`1` })
            .from(billingPrices)
            .where(and(eq(billingPrices.itemId, billingCatalogItems.id), eq(billingPrices.active, true))),
        ),
      ),
    )
    .orderBy(asc(billingCatalogItems.id))
    .limit(limit);
}

export async function setProductId(tx: Tx, itemId: string, stripeProductId: string): Promise<void> {
  await tx
    .update(billingCatalogItems)
    .set({ stripeProductId, updatedAt: sql`now()` })
    .where(and(eq(billingCatalogItems.id, itemId), isNull(billingCatalogItems.stripeProductId)));
}

/** Active prices without a Stripe price yet whose item has a product (sync). */
export async function pricesToSync(tx: Tx, limit: number) {
  return tx
    .select({
      id: billingPrices.id,
      productId: billingCatalogItems.stripeProductId,
      interval: billingPrices.interval,
      currency: billingPrices.currency,
      amountCents: billingPrices.amountCents,
    })
    .from(billingPrices)
    .innerJoin(billingCatalogItems, eq(billingCatalogItems.id, billingPrices.itemId))
    .where(
      and(
        eq(billingPrices.active, true),
        isNull(billingPrices.stripePriceId),
        isNotNull(billingCatalogItems.stripeProductId),
      ),
    )
    .orderBy(asc(billingPrices.id))
    .limit(limit);
}

export async function setStripePriceId(tx: Tx, priceId: string, stripePriceId: string): Promise<void> {
  await tx
    .update(billingPrices)
    .set({ stripePriceId })
    .where(and(eq(billingPrices.id, priceId), isNull(billingPrices.stripePriceId)));
}

// ---- plans in force, grants and price locks (S13-02) ----

export interface PlanInForce {
  code: string;
  /** Members the plan includes; null: no limit. */
  seats: number | null;
  features: string[];
  /** The running grant that sets the plan, if one does (a live subscription of the same rank wins). */
  grant: { kind: 'TRIAL' | 'STAFF'; planCode: string; endsAt: Date } | null;
}

/**
 * The agency's plan now (one statement): the highest-ranked catalog plan among its subscription's (TRIALING, ACTIVE, or
 * PAST_DUE since after `graceStart` — a row without `past_due_since` counts from its last sync) and its running grants', else Free's row. A plan code the catalog does not know
 * (an unknown price) counts as Free. Retired (inactive) plans still apply to whoever has them.
 */
export async function planInForce(tx: Tx, agencyId: string, now: Date, graceStart: Date): Promise<PlanInForce> {
  const at = now.toISOString();
  const rows = await tx.execute<{
    code: string;
    seats_included: number | null;
    features: string[];
    grant_kind: 'TRIAL' | 'STAFF' | null;
    ends_at: Date | string | null;
  }>(sql`
    with candidates as (
      select s.plan_code, null::billing_plan_grant_kind as grant_kind, null::timestamptz as ends_at
      from ${billingSubscriptions} s
      where s.agency_id = ${agencyId}::uuid
        and (s.status in ('TRIALING', 'ACTIVE')
          or (s.status = 'PAST_DUE'
            and coalesce(s.past_due_since, s.synced_at) > ${graceStart.toISOString()}::timestamptz))
      union all
      select g.plan_code, g.kind, g.ends_at
      from ${billingPlanGrants} g
      where g.agency_id = ${agencyId}::uuid and g.revoked_at is null
        and g.starts_at <= ${at}::timestamptz and g.ends_at > ${at}::timestamptz
      union all
      select ${FREE_PLAN}, null, null
    )
    select i.code, i.seats_included, i.features, c.grant_kind, c.ends_at
    from candidates c
    join ${billingCatalogItems} i on i.code = c.plan_code and i.kind = 'PLAN'
    order by i.rank desc, c.grant_kind nulls first, c.ends_at desc
    limit 1`);
  const row = rows.rows[0];
  // No Free row in the catalog (a bare test database): Free without limits or features.
  if (!row) return { code: FREE_PLAN, seats: null, features: [], grant: null };
  return {
    code: row.code,
    seats: row.seats_included,
    features: row.features,
    grant:
      row.grant_kind && row.ends_at
        ? { kind: row.grant_kind, planCode: row.code, endsAt: new Date(row.ends_at) }
        : null,
  };
}

/** The plans of the catalog with their rank and gated features (a few rows): `requirePlan`'s matrix. */
export async function planMatrix(tx: Tx) {
  return tx
    .select({
      code: billingCatalogItems.code,
      rank: billingCatalogItems.rank,
      active: billingCatalogItems.active,
      features: billingCatalogItems.features,
    })
    .from(billingCatalogItems)
    .where(eq(billingCatalogItems.kind, 'PLAN'))
    .orderBy(asc(billingCatalogItems.rank), asc(billingCatalogItems.code));
}

/** Seats each add-on unit adds (extra user), for the add-on codes given. */
export async function addonSeats(tx: Tx, codes: string[]): Promise<Map<string, number>> {
  if (codes.length === 0) return new Map();
  const rows = await tx
    .select({ code: billingCatalogItems.code, seats: billingCatalogItems.seatsIncluded })
    .from(billingCatalogItems)
    .where(and(eq(billingCatalogItems.kind, 'ADDON'), inArray(billingCatalogItems.code, codes)));
  return new Map(rows.map((r) => [r.code, r.seats ?? 0]));
}

/** Seat checks of one agency run one at a time (two concurrent invites must not both take the last seat). */
export async function lockSeats(tx: Tx, agencyId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing.seats:${agencyId}`}, 0))`);
}

/** Whether the agency ever had a subscription, a customer, a grant or a price lock (migrated or founding agencies). */
export async function hasBillingHistory(tx: Tx, agencyId: string): Promise<boolean> {
  const rows = await tx.execute<{ any: boolean }>(sql`select
    exists (select 1 from ${billingSubscriptions} where agency_id = ${agencyId}::uuid)
    or exists (select 1 from ${billingCustomers} where agency_id = ${agencyId}::uuid)
    or exists (select 1 from ${billingPlanGrants} where agency_id = ${agencyId}::uuid)
    or exists (select 1 from ${billingPriceLocks} where agency_id = ${agencyId}::uuid) as any`);
  return rows.rows[0]?.any === true;
}

/** Whether `code` is a plan of the catalog. */
export async function isPlan(tx: Tx, code: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: billingCatalogItems.id })
    .from(billingCatalogItems)
    .where(and(eq(billingCatalogItems.code, code), eq(billingCatalogItems.kind, 'PLAN')));
  return Boolean(row);
}

export interface GrantWrite {
  id: string;
  agencyId: string;
  kind: 'TRIAL' | 'STAFF';
  planCode: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  grantedBy: string | null;
}

const grantColumns = {
  id: billingPlanGrants.id,
  agencyId: billingPlanGrants.agencyId,
  kind: billingPlanGrants.kind,
  planCode: billingPlanGrants.planCode,
  startsAt: billingPlanGrants.startsAt,
  endsAt: billingPlanGrants.endsAt,
  revokedAt: billingPlanGrants.revokedAt,
};
export interface GrantRow {
  id: string;
  agencyId: string;
  kind: 'TRIAL' | 'STAFF';
  planCode: string;
  startsAt: Date;
  endsAt: Date;
  revokedAt: Date | null;
}

/** Inserts a grant; false when the agency already had its trial (one per agency, ever). */
export async function insertGrant(tx: Tx, row: GrantWrite): Promise<boolean> {
  const rows = await tx
    .insert(billingPlanGrants)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: billingPlanGrants.id });
  return rows.length > 0;
}

export async function grantById(tx: Tx, id: string): Promise<GrantRow | null> {
  const [row] = await tx.select(grantColumns).from(billingPlanGrants).where(eq(billingPlanGrants.id, id));
  return row ?? null;
}

/** Revokes a grant not revoked yet (staff) and marks it ended (the revoke announces it); null when there is none. */
export async function revokeGrant(tx: Tx, id: string, by: string, at: Date, reason: string): Promise<GrantRow | null> {
  const [row] = await tx
    .update(billingPlanGrants)
    .set({ revokedAt: at, revokedBy: by, revokeReason: reason, endedAt: at })
    .where(and(eq(billingPlanGrants.id, id), isNull(billingPlanGrants.revokedAt)))
    .returning(grantColumns);
  return row ?? null;
}

/**
 * `billing.endPlanGrants`: grants that ended (or were revoked) and were not announced yet, at most `limit`, claimed and
 * marked in one statement (`for update skip locked`: a concurrent run takes others). Answers their agencies.
 */
export async function claimEndedGrants(tx: Tx, now: Date, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ agency_id: string }>(sql`
    update ${billingPlanGrants} g set ended_at = ${now.toISOString()}::timestamptz
    where g.id in (
      select id from ${billingPlanGrants}
      where ended_at is null and (ends_at <= ${now.toISOString()}::timestamptz or revoked_at is not null)
      order by ends_at
      limit ${limit}
      for update skip locked
    )
    returning g.agency_id`);
  return [...new Set(rows.rows.map((r) => r.agency_id))];
}

export interface PriceLockWrite {
  id: string;
  agencyId: string;
  planCode: string;
  interval: BillingInterval;
  currency: BillingCurrency;
  amountCents: number;
  endsAt: Date;
  reason: string;
  grantedBy: string;
}

/** Sets the agency's lock for a plan, interval and currency (replacing an earlier one). Answers the lock's id. */
export async function upsertPriceLock(tx: Tx, row: PriceLockWrite): Promise<string> {
  const { amountCents, endsAt, reason, grantedBy } = row;
  const [saved] = await tx
    .insert(billingPriceLocks)
    .values(row)
    .onConflictDoUpdate({
      target: [
        billingPriceLocks.agencyId,
        billingPriceLocks.planCode,
        billingPriceLocks.interval,
        billingPriceLocks.currency,
      ],
      set: { amountCents, endsAt, reason, grantedBy, updatedAt: sql`now()` },
    })
    .returning({ id: billingPriceLocks.id });
  return (saved as { id: string }).id;
}

/** The agency's running lock for a plan price, if any. */
export async function priceLockFor(
  tx: Tx,
  agencyId: string,
  key: { planCode: string; interval: BillingInterval; currency: string },
  now: Date,
): Promise<{ id: string; amountCents: number; endsAt: Date } | null> {
  const [row] = await tx
    .select({ id: billingPriceLocks.id, amountCents: billingPriceLocks.amountCents, endsAt: billingPriceLocks.endsAt })
    .from(billingPriceLocks)
    .where(
      and(
        eq(billingPriceLocks.agencyId, agencyId),
        eq(billingPriceLocks.planCode, key.planCode),
        eq(billingPriceLocks.interval, key.interval),
        eq(billingPriceLocks.currency, key.currency),
        sql`${billingPriceLocks.endsAt} > ${now.toISOString()}::timestamptz`,
      ),
    );
  return row ?? null;
}

// ---- staff console: an agency's grants and price locks (S13-03) ----

export interface StaffGrantRow extends GrantRow {
  reason: string;
  grantedBy: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** The agency's grants, latest end first (`billing_plan_grants_agency_idx`), at most `limit`. */
export async function listAgencyGrants(tx: Tx, agencyId: string, limit: number): Promise<StaffGrantRow[]> {
  return tx
    .select({
      ...grantColumns,
      reason: billingPlanGrants.reason,
      grantedBy: billingPlanGrants.grantedBy,
      revokedBy: billingPlanGrants.revokedBy,
      revokeReason: billingPlanGrants.revokeReason,
    })
    .from(billingPlanGrants)
    .where(eq(billingPlanGrants.agencyId, agencyId))
    .orderBy(desc(billingPlanGrants.endsAt), desc(billingPlanGrants.id))
    .limit(limit);
}

export interface PriceLockRow {
  id: string;
  planCode: string;
  interval: string;
  currency: string;
  amountCents: number;
  endsAt: Date;
  reason: string;
}

/** The agency's price locks (`billing_price_locks_uq` prefix), at most `limit`. */
export async function listAgencyPriceLocks(tx: Tx, agencyId: string, limit: number): Promise<PriceLockRow[]> {
  return tx
    .select({
      id: billingPriceLocks.id,
      planCode: billingPriceLocks.planCode,
      interval: billingPriceLocks.interval,
      currency: billingPriceLocks.currency,
      amountCents: billingPriceLocks.amountCents,
      endsAt: billingPriceLocks.endsAt,
      reason: billingPriceLocks.reason,
    })
    .from(billingPriceLocks)
    .where(eq(billingPriceLocks.agencyId, agencyId))
    .orderBy(billingPriceLocks.planCode, billingPriceLocks.interval, billingPriceLocks.currency)
    .limit(limit);
}
