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
import { UNKNOWN_PLAN } from './plan';

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
    .onConflictDoUpdate({
      target: billingSubscriptions.agencyId,
      set: {
        ...rest,
        // S13 review: the grace-end announcement belongs to one past-due spell; a new spell (or none) clears it.
        graceEndedAt: sql`case when ${billingSubscriptions.pastDueSince} is not distinct from excluded.past_due_since
          then ${billingSubscriptions.graceEndedAt} end`,
      },
    });
}

/**
 * S13 review: claims past-due subscriptions whose dunning grace ended (`past_due_since <= graceStart`) and whose end is
 * not announced yet — marks them (`grace_ended_at`) and answers their agencies. One claim per spell: a rerun finds
 * nothing; a new spell clears the mark (`upsertSubscription`). `billing_subscriptions_grace_idx`.
 */
export async function claimEndedGraces(tx: Tx, now: Date, graceStart: Date, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ agency_id: string }>(sql`
    update ${billingSubscriptions} s set grace_ended_at = ${now.toISOString()}::timestamptz
    where s.agency_id in (
      select agency_id from ${billingSubscriptions}
      where status = 'PAST_DUE' and grace_ended_at is null
        and past_due_since <= ${graceStart.toISOString()}::timestamptz
      order by past_due_since
      limit ${limit}
      for update skip locked
    )
    returning s.agency_id`);
  return rows.rows.map((r) => r.agency_id);
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
  /** S13-F21: quotas (`PlanQuota` keys): a plan's limits, or what one add-on unit adds; undefined keeps the stored ones. */
  limits?: Record<string, number>;
  /** S13-F19: Stripe Tax product tax code (`txcd_…`); undefined keeps the stored one, null clears it. */
  taxCode?: string | null;
  prices: { interval: BillingInterval; currency: BillingCurrency; amountCents: number }[];
}

/**
 * Upserts catalog items and their offered prices (seed and scripts, `withSystem`). A changed amount retires the old
 * price and adds a new one (Stripe prices are immutable; subscriptions on the old one keep it). S13-F18: an item's
 * active price its input no longer lists is retired too; `billing.syncCatalog` then deactivates both kinds in Stripe.
 * Items absent from the input are left as they are (a partial file never retires another item's prices).
 */
export async function upsertCatalog(
  tx: Tx,
  items: CatalogInput[],
  newId: () => string,
): Promise<{ items: number; prices: number; retired: number }> {
  let prices = 0;
  let retired = 0;
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
        limits: item.limits ?? {},
        taxCode: item.taxCode ?? null,
      })
      .onConflictDoUpdate({
        target: billingCatalogItems.code,
        set: {
          kind: item.kind,
          seatsIncluded: item.seatsIncluded,
          rank: item.rank,
          features: item.features ?? [],
          ...(item.limits !== undefined ? { limits: item.limits } : {}),
          ...(item.taxCode !== undefined ? { taxCode: item.taxCode } : {}),
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
    const kept = new Set<string>();
    const retire: string[] = [];
    for (const p of item.prices) {
      const same = current.find((c) => c.interval === p.interval && c.currency === p.currency);
      if (same?.amountCents === p.amountCents) {
        kept.add(same.id);
        continue;
      }
      if (same) {
        // before the insert: one active price per item, interval and currency (partial unique index)
        await tx.update(billingPrices).set({ active: false }).where(eq(billingPrices.id, same.id));
        kept.add(same.id);
        retired++;
      }
      await tx.insert(billingPrices).values({ id: newId(), itemId, ...p });
      prices++;
    }
    for (const c of current) if (!kept.has(c.id)) retire.push(c.id);
    if (retire.length) {
      await tx.update(billingPrices).set({ active: false }).where(inArray(billingPrices.id, retire));
      retired += retire.length;
    }
  }
  return { items: items.length, prices, retired };
}

/** Catalog items without a Stripe product yet that have a price to sell (Free and Enterprise have none: S13-02). */
export async function itemsToSync(tx: Tx, limit: number) {
  return tx
    .select({ id: billingCatalogItems.id, code: billingCatalogItems.code, taxCode: billingCatalogItems.taxCode })
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

export async function setProductId(
  tx: Tx,
  itemId: string,
  stripeProductId: string,
  stripeTaxCode: string | null = null,
): Promise<void> {
  await tx
    .update(billingCatalogItems)
    .set({ stripeProductId, stripeTaxCode, updatedAt: sql`now()` })
    .where(and(eq(billingCatalogItems.id, itemId), isNull(billingCatalogItems.stripeProductId)));
}

/**
 * S13-F19: products whose tax code changed since Stripe last got it (sync updates the product, outside transactions).
 * A few dozen rows; no index needed.
 */
export async function productsToTax(tx: Tx, limit: number) {
  return tx
    .select({
      id: billingCatalogItems.id,
      stripeProductId: billingCatalogItems.stripeProductId,
      taxCode: billingCatalogItems.taxCode,
    })
    .from(billingCatalogItems)
    .where(
      and(
        isNotNull(billingCatalogItems.stripeProductId),
        sql`${billingCatalogItems.taxCode} is distinct from ${billingCatalogItems.stripeTaxCode}`,
      ),
    )
    .orderBy(asc(billingCatalogItems.id))
    .limit(limit);
}

/** S13-F19: Stripe has `taxCode` on the product now (the value sent is recorded: a later change syncs again). */
export async function setStripeTaxCode(tx: Tx, itemId: string, taxCode: string | null): Promise<void> {
  await tx.update(billingCatalogItems).set({ stripeTaxCode: taxCode }).where(eq(billingCatalogItems.id, itemId));
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

/**
 * S13-F18: retired (inactive) prices Stripe still sells — created there, not yet deactivated (sync). The catalog is a
 * few dozen rows; the predicate needs no index.
 */
export async function pricesToRetire(tx: Tx, limit: number) {
  return tx
    .select({ id: billingPrices.id, stripePriceId: billingPrices.stripePriceId })
    .from(billingPrices)
    .where(
      and(
        eq(billingPrices.active, false),
        isNotNull(billingPrices.stripePriceId),
        isNull(billingPrices.stripeRetiredAt),
      ),
    )
    .orderBy(asc(billingPrices.id))
    .limit(limit);
}

/** S13-F18: the price is deactivated in Stripe (still inactive here: a re-offered amount is a new row). */
export async function setPriceRetired(tx: Tx, priceId: string): Promise<void> {
  await tx
    .update(billingPrices)
    .set({ stripeRetiredAt: sql`now()` })
    .where(and(eq(billingPrices.id, priceId), eq(billingPrices.active, false), isNull(billingPrices.stripeRetiredAt)));
}

// ---- plans in force, grants and price locks (S13-02) ----

export interface PlanInForce {
  code: string;
  /** Members the plan includes; null: no limit. */
  seats: number | null;
  features: string[];
  /** S13-F21: the plan's quotas (`PlanQuota` keys; a key not listed has no limit). */
  limits: Record<string, number>;
  /** The running grant that sets the plan, if one does (a live subscription of the same rank wins). */
  grant: { kind: 'TRIAL' | 'STAFF'; planCode: string; endsAt: Date } | null;
}

/** The plans an agency has now (`planInForce`): its live subscription's, its running grants', and Free. */
function candidatesSql(agencyId: string, now: Date, graceStart: Date) {
  const at = now.toISOString();
  return sql`
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
      select ${FREE_PLAN}, null, null`;
}

/**
 * The agency's plan now (one statement): the highest-ranked catalog plan among its subscription's (TRIALING, ACTIVE, or
 * PAST_DUE since after `graceStart` — a row without `past_due_since` counts from its last sync) and its running grants', else Free's row. A plan code the catalog does not know
 * (an unknown price) counts as Free. Retired (inactive) plans still apply to whoever has them.
 */
export async function planInForce(tx: Tx, agencyId: string, now: Date, graceStart: Date): Promise<PlanInForce> {
  const rows = await tx.execute<{
    code: string;
    seats_included: number | null;
    features: string[];
    limits: Record<string, number> | null;
    grant_kind: 'TRIAL' | 'STAFF' | null;
    ends_at: Date | string | null;
  }>(sql`
    with candidates as (${candidatesSql(agencyId, now, graceStart)})
    select i.code, i.seats_included, i.features, i.limits, c.grant_kind, c.ends_at
    from candidates c
    join ${billingCatalogItems} i on i.code = c.plan_code and i.kind = 'PLAN'
    order by i.rank desc, c.grant_kind nulls first, c.ends_at desc
    limit 1`);
  const row = rows.rows[0];
  // No Free row in the catalog (a bare test database): Free without limits or features.
  if (!row) return { code: FREE_PLAN, seats: null, features: [], limits: {}, grant: null };
  return {
    code: row.code,
    seats: row.seats_included,
    features: row.features,
    limits: row.limits ?? {},
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
      limits: billingCatalogItems.limits,
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

/**
 * S13-F21: what the live subscription's add-ons add to `quota` (units × the add-on's `limits[quota]`), in one
 * statement; 0 without a live subscription (TRIALING, ACTIVE, or PAST_DUE within the grace; not an unknown plan).
 */
export async function addonQuotaUnits(tx: Tx, agencyId: string, quota: string, graceStart: Date): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select coalesce(sum((a.item->>'quantity')::int * coalesce((ai.limits->>${quota})::int, 0)), 0)::int as n
    from ${billingSubscriptions} s
    cross join lateral jsonb_array_elements(s.addons) as a(item)
    join ${billingCatalogItems} ai on ai.code = a.item->>'code' and ai.kind = 'ADDON'
    where s.agency_id = ${agencyId}::uuid and s.plan_code <> ${UNKNOWN_PLAN}
      and (s.status in ('TRIALING', 'ACTIVE')
        or (s.status = 'PAST_DUE' and coalesce(s.past_due_since, s.synced_at) > ${graceStart.toISOString()}::timestamptz))`);
  return rows.rows[0]?.n ?? 0;
}

/**
 * S13-F21: the plan in force's limit of `quota` plus what the live subscription's add-ons add — one statement (the
 * `planInForce` candidates and the add-on sum). `limit` undefined: the plan has no limit for it.
 */
export async function quotaInForce(
  tx: Tx,
  agencyId: string,
  quota: string,
  now: Date,
  graceStart: Date,
): Promise<{ code: string; limit: number | undefined; extra: number }> {
  const grace = graceStart.toISOString();
  const rows = await tx.execute<{ code: string; base: number | null; extra: number }>(sql`
    with candidates as (${candidatesSql(agencyId, now, graceStart)}),
    plan as (
      select i.code, (i.limits->>${quota})::int as base
      from candidates c
      join ${billingCatalogItems} i on i.code = c.plan_code and i.kind = 'PLAN'
      order by i.rank desc, c.grant_kind nulls first, c.ends_at desc
      limit 1
    )
    select p.code, p.base,
      (select coalesce(sum((a.item->>'quantity')::int * coalesce((ai.limits->>${quota})::int, 0)), 0)::int
       from ${billingSubscriptions} s
       cross join lateral jsonb_array_elements(s.addons) as a(item)
       join ${billingCatalogItems} ai on ai.code = a.item->>'code' and ai.kind = 'ADDON'
       where s.agency_id = ${agencyId}::uuid and s.plan_code <> ${UNKNOWN_PLAN}
         and (s.status in ('TRIALING', 'ACTIVE')
           or (s.status = 'PAST_DUE' and coalesce(s.past_due_since, s.synced_at) > ${grace}::timestamptz))) as extra
    from plan p`);
  const row = rows.rows[0];
  // No Free row in the catalog (a bare test database): Free without limits.
  if (!row) return { code: FREE_PLAN, limit: undefined, extra: 0 };
  return { code: row.code, limit: row.base ?? undefined, extra: row.extra };
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

/**
 * S13-F23: the agency's price locks among `ids` (the locks a subscription's founding coupons name; primary key), by id.
 * Another agency's lock is never answered: a coupon naming it is not this agency's to keep.
 */
export async function priceLocksByIds(
  tx: Tx,
  agencyId: string,
  ids: string[],
): Promise<Map<string, { planCode: string; interval: BillingInterval; currency: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: billingPriceLocks.id,
      planCode: billingPriceLocks.planCode,
      interval: billingPriceLocks.interval,
      currency: billingPriceLocks.currency,
    })
    .from(billingPriceLocks)
    .where(and(eq(billingPriceLocks.agencyId, agencyId), inArray(billingPriceLocks.id, ids)));
  return new Map(rows.map(({ id, ...lock }) => [id, lock]));
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

export interface EndingGrantRow {
  id: string;
  agencyId: string;
  kind: 'TRIAL' | 'STAFF';
  planCode: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * S13-F22 (`billing.noticeEndingGrants`): running grants (not revoked, not ended) that end within the window, whose
 * agency has no live subscription (a subscribed agency loses nothing when its trial ends), after `afterId`, at most
 * `limit`, by id.
 */
export async function grantsEndingBetween(
  tx: Tx,
  from: Date,
  to: Date,
  afterId: string | null,
  limit: number,
): Promise<EndingGrantRow[]> {
  const rows = await tx.execute<{
    id: string;
    agency_id: string;
    kind: 'TRIAL' | 'STAFF';
    plan_code: string;
    starts_at: Date | string;
    ends_at: Date | string;
  }>(sql`
    select g.id, g.agency_id, g.kind, g.plan_code, g.starts_at, g.ends_at
    from ${billingPlanGrants} g
    where g.ended_at is null and g.revoked_at is null
      and g.starts_at <= ${from.toISOString()}::timestamptz
      and g.ends_at > ${from.toISOString()}::timestamptz and g.ends_at <= ${to.toISOString()}::timestamptz
      and (${afterId}::uuid is null or g.id > ${afterId}::uuid)
      and not exists (
        select 1 from ${billingSubscriptions} s
        where s.agency_id = g.agency_id and s.status in ('TRIALING', 'ACTIVE', 'PAST_DUE'))
    order by g.id
    limit ${limit}`);
  return rows.rows.map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    kind: r.kind,
    planCode: r.plan_code,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
  }));
}
