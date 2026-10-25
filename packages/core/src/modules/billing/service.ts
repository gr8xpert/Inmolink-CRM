import type {
  BillingOverviewDto,
  BillingRedirectDto,
  CatalogItemDto,
  InvoicePage,
  ListInvoicesQuery,
  StartCheckoutBody,
  SubscriptionDto,
} from '@inmolink/contracts';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import type { Ctx, CtxRunner } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { billingConfig, stripeClient } from './config';
import { billingJobs } from './jobs';
import { effectivePlan } from './plan';
import { assertCan, can } from './policy';
import * as repo from './repo';
import { StripeError, verifyStripeSignature } from './stripe';

/**
 * billing use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network inside one.
 */

/**
 * Seat check before a new member is added (S1-02). `used` counts active members plus open invites;
 * the caller counts them, since billing never reads another module's tables. A stub until seats are
 * enforced (S13-02): every agency has unlimited seats. S13-02 makes it throw `PLAN_REQUIRED` when
 * `used + 1` exceeds the plan's seats.
 */
export async function assertSeat(_ctx: Ctx, _seats: { used: number }): Promise<void> {}

/** The billing page: the plan in force, the subscription, and what can be bought. */
export async function getBillingOverview(ctx: Ctx): Promise<BillingOverviewDto> {
  assertCan(ctx, 'billing.read');
  const { agencyId } = ctx.tenant;
  const sub = await repo.subscriptionOf(ctx.tx, agencyId);
  const customer = await repo.customerOf(ctx.tx, agencyId);
  const catalog = await repo.offeredCatalog(ctx.tx);
  return {
    plan: effectivePlan(sub),
    subscription: sub ? toSubscriptionDto(sub) : null,
    hasCustomer: customer !== null,
    canManage: can(ctx, 'billing.manage'),
    catalog: toCatalogDto(catalog),
  };
}

/**
 * The agency's invoices: admins only (S13-01 security review) — Stripe's hosted invoice and PDF links open without a
 * login and show the billing address and VAT ID.
 */
export async function listInvoices(ctx: Ctx, q: ListInvoicesQuery): Promise<InvoicePage> {
  assertCan(ctx, 'billing.manage');
  const rows = await repo.listInvoices(ctx.tx, ctx.tenant.agencyId, { limit: q.limit, cursor: decodeCursor(q.cursor) });
  return toPage(
    rows,
    q.limit,
    (r) => ({ at: r.issuedAt, id: r.id }),
    (r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      currency: r.currency,
      totalCents: r.totalCents,
      taxCents: r.taxCents,
      amountPaidCents: r.amountPaidCents,
      issuedAt: r.issuedAt.toISOString(),
      hostedUrl: r.hostedUrl,
      pdfUrl: r.pdfUrl,
    }),
  );
}

/**
 * Starts a Stripe Checkout for a plan (annual by default) and optional add-ons: card, SEPA Direct Debit on EUR, Stripe
 * Tax, VAT ID. Admins only. The agency's Stripe customer is created on its first checkout. Network I/O runs between
 * short transactions (PATTERNS §4): read → create the customer → record it → create the session. The subscription
 * itself is recorded by the webhook job when Stripe confirms it.
 */
export async function startCheckout(run: CtxRunner, input: StartCheckoutBody): Promise<BillingRedirectDto> {
  const { stripe, returnUrl } = enabled();
  const plan = await run(async (ctx) => {
    assertCan(ctx, 'billing.manage');
    const { agencyId } = ctx.tenant;
    const sub = await repo.subscriptionOf(ctx.tx, agencyId);
    const customer = await repo.customerOf(ctx.tx, agencyId);
    const catalog = await repo.offeredCatalog(ctx.tx);
    // A live (or still paying-up) subscription is changed in the Customer Portal, never doubled.
    if (sub && !['CANCELED', 'INCOMPLETE_EXPIRED'].includes(sub.status))
      throw new AppError('BILLING_ALREADY_SUBSCRIBED');
    const priceOf = (code: string, kind: 'PLAN' | 'ADDON') =>
      catalog.find(
        (r) => r.code === code && r.kind === kind && r.interval === input.interval && r.currency === input.currency,
      )?.stripePriceId ?? null;
    const planPrice = priceOf(input.planCode, 'PLAN');
    if (!planPrice) throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: input.planCode });
    const lineItems = [{ price: planPrice, quantity: 1 }];
    const seen = new Set<string>();
    for (const a of input.addons) {
      const price = priceOf(a.code, 'ADDON');
      if (!price || seen.has(a.code)) throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: a.code });
      seen.add(a.code);
      lineItems.push({ price, quantity: a.quantity });
    }
    return { agencyId, customer, lineItems, locale: ctx.locale, requestId: ctx.requestId };
  });

  // S13-01 security review: the webhook may not have reported a subscription yet, and another tab may hold an open
  // Checkout — ask Stripe, and expire open sessions so only this one can be paid.
  if (plan.customer && (await callStripe(() => stripe.settleOpenCheckouts(plan.customer as string))).live) {
    throw new AppError('BILLING_ALREADY_SUBSCRIBED');
  }
  let customerId = plan.customer;
  if (!customerId) {
    const created = (await callStripe(() => stripe.createCustomer(plan.agencyId))).id;
    customerId = await run(async (ctx) => {
      assertCan(ctx, 'billing.manage');
      return repo.insertCustomer(ctx.tx, ctx.tenant.agencyId, created);
    });
  }
  const customer = customerId;
  const session = await callStripe(() =>
    stripe.createCheckoutSession({
      customerId: customer,
      agencyId: plan.agencyId,
      planCode: input.planCode,
      lineItems: plan.lineItems,
      // Stripe: SEPA Direct Debit charges euros only.
      paymentMethods: input.currency === 'EUR' ? ['card', 'sepa_debit'] : ['card'],
      successUrl: `${returnUrl}?checkout=success`,
      cancelUrl: `${returnUrl}?checkout=cancelled`,
      locale: checkoutLocale(plan.locale),
      idempotencyKey: `checkout:${plan.agencyId}:${plan.requestId}`,
    }),
  );
  return { url: session.url };
}

/** A Customer Portal session (plan changes, payment methods, VAT ID, cancellation, invoices). Admins only. */
export async function openCustomerPortal(run: CtxRunner): Promise<BillingRedirectDto> {
  const { stripe, returnUrl } = enabled();
  const customer = await run(async (ctx) => {
    assertCan(ctx, 'billing.manage');
    return repo.customerOf(ctx.tx, ctx.tenant.agencyId);
  });
  if (!customer) throw new AppError('BILLING_NO_CUSTOMER');
  return { url: (await callStripe(() => stripe.createPortalSession(customer, returnUrl))).url };
}

/**
 * A Stripe webhook (no member, no tenant): the signature is checked on the raw body first, then the event's id, type
 * and object are queued for `billing.applyStripeEvent` (one job per event id: Stripe's retries collapse). Nothing of the
 * payload is trusted beyond those ids — the job re-reads the object from Stripe. Unsigned or stale → `BILLING_WEBHOOK_INVALID`.
 */
export async function receiveStripeWebhook(input: { payload: Buffer; signature: string | undefined }): Promise<void> {
  const secret = billingConfig().stripe?.webhookSecret;
  if (!secret) throw new AppError('BILLING_NOT_ENABLED');
  const event = verifyStripeSignature(input.payload, input.signature, secret, clock.nowMs());
  if (!event) throw new AppError('BILLING_WEBHOOK_INVALID');
  const id = typeof event.id === 'string' ? event.id : '';
  const type = typeof event.type === 'string' ? event.type : '';
  const object = ((event.data as { object?: unknown } | undefined)?.object ?? {}) as Record<string, unknown>;
  if (!/^evt_[A-Za-z0-9]{1,250}$/.test(id) || !/^[a-z_.]{1,100}$/.test(type)) {
    throw new AppError('BILLING_WEBHOOK_INVALID', { reason: 'shape' });
  }
  if (!HANDLED.some((prefix) => type.startsWith(prefix))) return;
  const objectId = typeof object.id === 'string' ? object.id.slice(0, 255) : null;
  if (!objectId) return;
  const customer = object.object === 'customer' ? object.id : object.customer;
  const customerId = typeof customer === 'string' ? customer.slice(0, 255) : null;
  await billingJobs.applyStripeEvent.enqueue({ eventId: id, type, objectId, customerId });
}

/** Event types the job applies; Stripe sends others only if the endpoint subscribes to them (acknowledged, ignored). */
const HANDLED = ['checkout.session.', 'customer.subscription.', 'invoice.'];

function enabled() {
  const stripe = stripeClient();
  const returnUrl = billingConfig().stripe?.returnUrl;
  if (!stripe || !returnUrl) throw new AppError('BILLING_NOT_ENABLED');
  return { stripe, returnUrl };
}

async function callStripe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StripeError) {
      throw new AppError('BILLING_PROVIDER_UNAVAILABLE', {
        status: err.status,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    throw err;
  }
}

/** Languages Stripe Checkout supports among the ones Inmolink may use; anything else lets Stripe pick from the browser. */
const CHECKOUT_LOCALES = new Set(['en', 'es', 'fr', 'de', 'it', 'nl', 'pt', 'sv', 'da', 'fi', 'nb', 'pl']);
const checkoutLocale = (locale: string) => {
  const lang = locale.slice(0, 2).toLowerCase();
  return CHECKOUT_LOCALES.has(lang) ? lang : 'auto';
};

function toSubscriptionDto(sub: repo.SubscriptionRow): SubscriptionDto {
  return {
    planCode: sub.planCode,
    status: sub.status,
    interval: sub.interval,
    currency: sub.currency === 'EUR' || sub.currency === 'GBP' ? sub.currency : null,
    addons: sub.addons,
    paymentMethod: sub.paymentMethod,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAt: sub.cancelAt?.toISOString() ?? null,
  };
}

function toCatalogDto(rows: repo.CatalogPriceRow[]): CatalogItemDto[] {
  const items = new Map<string, CatalogItemDto>();
  for (const r of rows) {
    let item = items.get(r.code);
    if (!item) {
      item = { code: r.code, kind: r.kind, seatsIncluded: r.seatsIncluded, prices: [] };
      items.set(r.code, item);
    }
    if (r.interval && r.amountCents !== null && (r.currency === 'EUR' || r.currency === 'GBP')) {
      item.prices.push({ interval: r.interval, currency: r.currency, amountCents: r.amountCents });
    }
  }
  return [...items.values()];
}
