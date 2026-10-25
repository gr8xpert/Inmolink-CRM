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

/**
 * S13-02: features a plan gates (PLAN §11, §3 #29: gate on value — website API, exports, new-builds, AI — never on
 * sharing). The keys are code; which plans include them is catalog data (`billing-catalog.json` `features`). A gated
 * use case calls `billing.requirePlan(ctx, feature)`, which answers `PLAN_REQUIRED` with the cheapest plan that has it.
 */
export const PlanFeature = z.enum([
  'website_api',
  'portal_exports',
  'new_builds_full',
  'crm_full',
  'crm_automations',
  'client_matching',
  'matching_auto_send',
  'speed_to_lead',
  'social_posting',
  'pdfs_and_forms',
  'client_portal',
  'chat_agent',
  'crm_copilot',
  'email_campaigns',
  'ai_video',
  'reports_standard',
  'reports_advanced',
]);
export type PlanFeature = z.infer<typeof PlanFeature>;

/**
 * S13-F21: counted plan quotas (PLAN §11). The keys are code; each plan's limit is catalog data
 * (`billing-catalog.json` `limits`; a key a plan does not list has no limit; an add-on's value is what one unit adds).
 * A create path calls `billing.requireQuota(ctx, quota, used)`: over the limit it answers `PLAN_REQUIRED`
 * (`{ reason: 'quota', quota, plan, limit, requiredPlan }`).
 */
export const PlanQuota = z.enum(['sites', 'social_accounts', 'crm_contacts', 'studio_listings_month']);
export type PlanQuota = z.infer<typeof PlanQuota>;

/** S13-02: what put an agency on a plan without a subscription — a trial, or a staff grant (founding, pilot, support). */
export const PlanGrantKind = z.enum(['TRIAL', 'STAFF']);
export type PlanGrantKind = z.infer<typeof PlanGrantKind>;

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
  /** Members included (plans; null: no limit) or added per unit (add-ons; null: none). */
  seatsIncluded: z.number().int().nullable(),
  /** S13-02: the features a plan includes (empty for add-ons). */
  features: z.array(PlanFeature),
  /** Only prices Stripe knows (synced) are offered; a plan without any (Free, Enterprise) is not bought by Checkout. */
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
  /**
   * The plan in force now (S13-02): the highest of the subscription's while it is live (a past-due one only within the
   * dunning grace) and the agency's running grants (trial, staff), else `free`.
   */
  plan: z.string(),
  /** S13-02: members the agency may have (the plan's plus extra-user add-ons); null: no limit. */
  seats: z.number().int().nullable(),
  /** S13-02: the running grant that sets the plan (a trial, a staff grant), if one does. */
  grant: z.object({ kind: PlanGrantKind, planCode: z.string(), endsAt: z.iso.datetime() }).nullable(),
  /** S13-02: a past-due subscription keeps its plan until then (the notice before access changes). */
  graceEndsAt: z.iso.datetime().nullable(),
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

/** S13-02: staff put an agency on a plan until a date (founding parallel run, pilot, support goodwill). */
export const GrantPlanBody = z
  .object({
    agencyId: z.uuid(),
    planCode: CatalogCode,
    endsAt: z.iso.datetime(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type GrantPlanBody = z.infer<typeof GrantPlanBody>;

/**
 * S13-02: a price lock (the founding offer: migrated and pilot agencies keep a price for years). Checkout discounts the
 * plan's current price down to `amountCents` until `endsAt` with a Stripe coupon.
 */
export const PriceLockBody = z
  .object({
    agencyId: z.uuid(),
    planCode: CatalogCode,
    interval: BillingInterval,
    currency: BillingCurrency,
    amountCents: z.number().int().min(0),
    endsAt: z.iso.datetime(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type PriceLockBody = z.infer<typeof PriceLockBody>;

export const PlanGrantDto = z.object({
  id: z.uuid(),
  agencyId: z.uuid(),
  kind: PlanGrantKind,
  planCode: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type PlanGrantDto = z.infer<typeof PlanGrantDto>;

export const StripeWebhookAck = z.object({ received: z.literal(true) });
