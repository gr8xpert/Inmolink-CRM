/**
 * Tables owned by the billing module (S13-01, PATTERNS §2, PLAN §3 #28 / §7 M19). Only
 * `packages/core/src/modules/billing` imports this file (`pnpm check:boundaries`).
 *
 * The catalog (plans, add-ons and their prices) is platform data, the same for every agency, synced to Stripe by
 * `billing.syncCatalog`. An agency's Stripe customer is written when it first starts a checkout; its subscription and
 * invoices are Stripe's state mirrored by the webhook job (`billing.applyStripeEvent`, `withSystem`) — members only
 * read them. Nothing here is ever deleted when a subscription ends: the agency falls back to Free with its data intact.
 *
 * S13-02: plan grants (a trial, a staff grant) put an agency on a plan until a date without a subscription; price locks
 * keep a founding price. Both are written by staff (`app_staff`) or the worker, never by members, and never deleted
 * (a revoked grant keeps its row: who granted what, why, until when).
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
export const billingPlanGrantKindEnum = pgEnum('billing_plan_grant_kind', ['TRIAL', 'STAFF']);

/**
 * Plans (Free, Pro, Business, …) and add-ons (extra user, extra website, …). Free is the plan of an agency without a
 * live subscription or grant; its row (S13-02) only carries its seats and features and has no prices.
 */
export const billingCatalogItems = pgTable(
  'billing_catalog_items',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    kind: billingItemKindEnum('kind').notNull(),
    /** Members a plan includes (PLAN §11 "Users included"; null: no limit), or an add-on adds per unit (null: none). */
    seatsIncluded: integer('seats_included'),
    /** S13-02: the gated features a plan includes (`PlanFeature` keys; PLAN §11 matrix as data). */
    features: text('features').array().notNull().default(sql`'{}'::text[]`),
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
    /** S13-02: when it became PAST_DUE (the dunning grace counts from here); null in any other status. */
    pastDueSince: timestamp('past_due_since', { withTimezone: true }),
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
 * S13-02: a plan for an agency until `ends_at`, without a subscription: the 14-day trial of a new, non-migrated agency
 * (the worker, once per agency) or a staff grant (founding parallel run, pilot, goodwill). The plan in force is the
 * highest of the live subscription's and the running grants'. Revoking keeps the row.
 */
export const billingPlanGrants = pgTable(
  'billing_plan_grants',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    kind: billingPlanGrantKindEnum('kind').notNull(),
    planCode: text('plan_code').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    /** The staff member who granted it; null for a trial. */
    grantedBy: uuid('granted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    /** Set by `billing.endPlanGrants` once the end (or revocation) was announced (`billing.plan.changed`). */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // the plan in force: where agency_id = ? and revoked_at is null and ends_at > now()
    index('billing_plan_grants_agency_idx').on(t.agencyId, t.endsAt),
    // one trial per agency, ever
    uniqueIndex('billing_plan_grants_trial_uq').on(t.agencyId).where(sql`${t.kind} = 'TRIAL'`),
    // billing.endPlanGrants: grants past their end not yet announced
    index('billing_plan_grants_due_idx').on(t.endsAt).where(sql`${t.endedAt} is null`),
    check('billing_plan_grants_period_ck', sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/**
 * S13-02: a founding price lock — the agency pays at most `amount_cents` for the plan (interval, currency) until
 * `ends_at`; Checkout applies a Stripe coupon for the difference. One per agency, plan, interval and currency.
 */
export const billingPriceLocks = pgTable(
  'billing_price_locks',
  {
    id: uuid('id').primaryKey(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id),
    planCode: text('plan_code').notNull(),
    interval: billingIntervalEnum('interval').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_price_locks_uq').on(t.agencyId, t.planCode, t.interval, t.currency),
    check('billing_price_locks_amount_ck', sql`${t.amountCents} >= 0`),
    check('billing_price_locks_currency_ck', sql`${t.currency} in ('EUR', 'GBP')`),
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
