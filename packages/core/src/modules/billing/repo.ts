import type { BillingCurrency, BillingInterval, SubscriptionStatus } from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import {
  billingCatalogItems,
  billingCustomers,
  billingInvoices,
  billingPrices,
  billingStripeEvents,
  billingSubscriptions,
} from '@inmolink/db/schema/billing';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
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
  priceId: string | null;
  interval: BillingInterval | null;
  currency: string | null;
  amountCents: number | null;
  stripePriceId: string | null;
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
      priceId: billingPrices.id,
      interval: billingPrices.interval,
      currency: billingPrices.currency,
      amountCents: billingPrices.amountCents,
      stripePriceId: billingPrices.stripePriceId,
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
      .values({ id: newId(), code: item.code, kind: item.kind, seatsIncluded: item.seatsIncluded, rank: item.rank })
      .onConflictDoUpdate({
        target: billingCatalogItems.code,
        set: { kind: item.kind, seatsIncluded: item.seatsIncluded, rank: item.rank, updatedAt: sql`now()` },
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

/** Catalog items without a Stripe product yet (sync). */
export async function itemsToSync(tx: Tx, limit: number) {
  return tx
    .select({ id: billingCatalogItems.id, code: billingCatalogItems.code })
    .from(billingCatalogItems)
    .where(isNull(billingCatalogItems.stripeProductId))
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
