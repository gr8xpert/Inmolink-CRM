import { z } from 'zod';

/** billing DTOs (PATTERNS §9): Zod schemas and inferred types for params, bodies and responses. */

/**
 * S13-01: the plan an agency is on when it has no live subscription (PLAN §11 "Free"). Every other plan and add-on is
 * catalog data (`billing_catalog_items`, synced to Stripe), never a constant.
 */
export const FREE_PLAN = 'free';

export const BillingInterval = z.enum(['MONTH', 'YEAR']);
export type BillingInterval = z.infer<typeof BillingInterval>;

/** Currencies a price may be in (PLAN §3 #28: EUR and GBP). */
export const BillingCurrency = z.enum(['EUR', 'GBP']);
export type BillingCurrency = z.infer<typeof BillingCurrency>;

/** Stripe's subscription statuses, upper-cased (`incomplete_expired` → `INCOMPLETE_EXPIRED`). */
export const SubscriptionStatus = z.enum([
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'CANCELED',
  'PAUSED',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** A catalog code: lower-case letters, digits and underscores (`pro`, `extra_user`). */
export const CatalogCode = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const BillingPriceDto = z.object({
  interval: BillingInterval,
  currency: BillingCurrency,
  /** Excluding VAT: Stripe Tax adds it at checkout (or reverse-charges it on a valid EU VAT ID). */
  amountCents: z.number().int(),
});
export type BillingPriceDto = z.infer<typeof BillingPriceDto>;

export const CatalogItemDto = z.object({
  code: CatalogCode,
  kind: z.enum(['PLAN', 'ADDON']),
  /** Members included (plans); null for add-ons. */
  seatsIncluded: z.number().int().nullable(),
  /** Only prices Stripe knows (synced) are offered. */
  prices: z.array(BillingPriceDto),
});
export type CatalogItemDto = z.infer<typeof CatalogItemDto>;

export const SubscriptionDto = z.object({
  planCode: z.string(),
  status: SubscriptionStatus,
  interval: BillingInterval.nullable(),
  currency: BillingCurrency.nullable(),
  addons: z.array(z.object({ code: z.string(), quantity: z.number().int() })),
  /** `card`, `sepa_debit`, …: the default payment method's type, when Stripe says. */
  paymentMethod: z.string().nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  /** The subscription ends (falls back to Free) at `cancelAt`; data is never touched. */
  cancelAt: z.iso.datetime().nullable(),
});
export type SubscriptionDto = z.infer<typeof SubscriptionDto>;

export const BillingOverviewDto = z.object({
  /** The plan in force now: the subscription's while it is live (trialing, active, past due), else `free`. */
  plan: z.string(),
  subscription: SubscriptionDto.nullable(),
  /** Whether the agency has a Stripe customer (the Customer Portal opens only then). */
  hasCustomer: z.boolean(),
  /** Whether the caller may check out, open the portal and see invoices (the agency's admins). */
  canManage: z.boolean(),
  catalog: z.array(CatalogItemDto),
});
export type BillingOverviewDto = z.infer<typeof BillingOverviewDto>;

export const StartCheckoutBody = z
  .object({
    planCode: CatalogCode,
    /** Annual is the default (PLAN §3 #28). */
    interval: BillingInterval.default('YEAR'),
    currency: BillingCurrency.default('EUR'),
    addons: z
      .array(z.object({ code: CatalogCode, quantity: z.number().int().min(1).max(100) }).strict())
      .max(10)
      .default([]),
  })
  .strict();
export type StartCheckoutBody = z.infer<typeof StartCheckoutBody>;

/** A Stripe-hosted page (Checkout or the Customer Portal) to send the member to. */
export const BillingRedirectDto = z.object({ url: z.url() });
export type BillingRedirectDto = z.infer<typeof BillingRedirectDto>;

export const InvoiceDto = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  status: z.enum(['DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE']),
  currency: z.string(),
  totalCents: z.number().int(),
  taxCents: z.number().int(),
  amountPaidCents: z.number().int(),
  issuedAt: z.iso.datetime(),
  /** Stripe's hosted invoice page and PDF (both open without signing in to Stripe). */
  hostedUrl: z.url().nullable(),
  pdfUrl: z.url().nullable(),
});
export type InvoiceDto = z.infer<typeof InvoiceDto>;

export const InvoicePage = z.object({ items: z.array(InvoiceDto), nextCursor: z.string().nullable() });
export type InvoicePage = z.infer<typeof InvoicePage>;

export const ListInvoicesQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuery>;

export const StripeWebhookAck = z.object({ received: z.literal(true) });
