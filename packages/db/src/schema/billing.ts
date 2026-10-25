/**
 * Tables owned by the billing module (S13-01, PATTERNS §2, PLAN §3 #28 / §7 M19). Only
 * `packages/core/src/modules/billing` imports this file (`pnpm check:boundaries`).
 *
 * The catalog (plans, add-ons and their prices) is platform data, the same for every agency, synced to Stripe by
 * `billing.syncCatalog`. An agency's Stripe customer is written when it first starts a checkout; its subscription and
 * invoices are Stripe's state mirrored by the webhook job (`billing.applyStripeEvent`, `withSystem`) — members only
 * read them. Nothing here is ever deleted when a subscription ends: the agency falls back to Free with its data intact.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agencies } from './agencies';

export const billingItemKindEnum = pgEnum('billing_item_kind', ['PLAN', 'ADDON']);
export const billingIntervalEnum = pgEnum('billing_interval', ['MONTH', 'YEAR']);
export const billingSubscriptionStatusEnum = pgEnum('billing_subscription_status', [
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'CANCELED',
  'PAUSED',
]);
export const billingInvoiceStatusEnum = pgEnum('billing_invoice_status', [
  'DRAFT',
  'OPEN',
  'PAID',
  'VOID',
  'UNCOLLECTIBLE',
]);

/** Plans (Pro, Business, …) and add-ons (extra user, extra website, …). Free is no subscription, not a row. */
export const billingCatalogItems = pgTable(
  'billing_catalog_items',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    kind: billingItemKindEnum('kind').notNull(),
    /** Members a plan includes (PLAN §11 "Users included"); null for add-ons. */
    seatsIncluded: integer('seats_included'),
    /** Display order of plans (lower first). */
    rank: integer('rank').notNull().default(0),
    active: boolean('active').notNull().default(true),
    /** The Stripe product, once `billing.syncCatalog` created it. */
    stripeProductId: text('stripe_product_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_catalog_items_code_uq').on(t.code),
    uniqueIndex('billing_catalog_items_stripe_uq').on(t.stripeProductId),
    check('billing_catalog_items_code_ck', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,39}$'`),
  ],
);

/**
 * A catalog item's price for one interval and currency, excluding VAT. Stripe prices are immutable: a new amount is a
 * new row (the old one deactivated); subscriptions on the old price keep it (legacy price locks, S13-02).
 */
export const billingPrices = pgTable(
  'billing_prices',
  {
    id: uuid('id').primaryKey(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => billingCatalogItems.id),
    interval: billingIntervalEnum('interval').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    active: boolean('active').notNull().default(true),
    /** The Stripe price, once `billing.syncCatalog` created it. */
    stripePriceId: text('stripe_price_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one offered price per item, interval and currency
    uniqueIndex('billing_prices_active_uq').on(t.itemId, t.interval, t.currency).where(sql`${t.active}`),
    uniqueIndex('billing_prices_stripe_uq').on(t.stripePriceId),
    // FK
    index('billing_prices_item_idx').on(t.itemId),
    check('billing_prices_amount_ck', sql`${t.amountCents} >= 0`),
    check('billing_prices_currency_ck', sql`${t.currency} in ('EUR', 'GBP')`),
  ],
);

/** The agency's Stripe customer (one per agency), created on its first checkout. */
export const billingCustomers = pgTable(
  'billing_customers',
  {
    agencyId: uuid('agency_id')
      .primaryKey()
      .references(() => agencies.id),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('billing_customers_stripe_uq').on(t.stripeCustomerId)],
);

/**
 * The agency's current subscription as Stripe last reported it (one per agency; a new subscription after a canceled one
 * replaces the row). Written only by the webhook job.
 */
export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    agencyId: uuid('agency_id')
      .primaryKey()
      .references(() => agencies.id),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    /** The plan item's code; the price's catalog item, or Stripe's `metadata.plan_code` for an unknown price. */
    planCode: text('plan_code').notNull(),
    status: billingSubscriptionStatusEnum('status').notNull(),
    interval: billingIntervalEnum('interval'),
    currency: char('currency', { length: 3 }),
    /** `[{ code, quantity }]` of the add-on items. */
    addons: jsonb('addons').$type<{ code: string; quantity: number }[]>().notNull().default([]),
    paymentMethod: text('payment_method'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /** When the subscription ends (cancel at period end, or a set date); null while it renews. */
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    /** When Stripe's state was last read (the job re-reads the object, so a late event never rolls it back). */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('billing_subscriptions_stripe_uq').on(t.stripeSubscriptionId)],
);

/** The agency's invoices as Stripe last reported them. Written only by the webhook job. */
export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    stripeInvoiceId: text('stripe_invoice_id').notNull(),
    number: text('number'),
    status: billingInvoiceStatusEnum('status').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    amountPaidCents: bigint('amount_paid_cents', { mode: 'number' }).notNull().default(0),
    hostedUrl: text('hosted_url'),
    pdfUrl: text('pdf_url'),
    /** Stripe's `created` (whole seconds, so the list keysets on the raw column). */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('billing_invoices_stripe_uq').on(t.stripeInvoiceId),
    // the invoices list: where agency_id = ? order by issued_at desc, id desc
    index('billing_invoices_agency_issued_idx').on(t.agencyId, t.issuedAt, t.id),
  ],
);

/**
 * Stripe webhook events already applied (idempotency: Stripe delivers at least once and retries for days). Platform
 * data, written by the webhook job only; pruned after `STRIPE_EVENT_RETENTION_DAYS` (Stripe stops retrying after 3).
 */
export const billingStripeEvents = pgTable(
  'billing_stripe_events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('billing_stripe_events_processed_idx').on(t.processedAt)],
);
