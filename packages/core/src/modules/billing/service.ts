import {
  type BillingOverviewDto,
  type BillingRedirectDto,
  type CatalogItemDto,
  FREE_PLAN,
  type GrantPlanBody,
  type InvoicePage,
  type ListInvoicesQuery,
  type PlanFeature,
  PlanFeature as PlanFeatureSchema,
  type PlanGrantDto,
  type PriceLockBody,
  STAFF_BILLING_LIST_LIMIT,
  type StaffAgencyBillingDto,
  type StartCheckoutBody,
  type SubscriptionDto,
} from '@inmolink/contracts';
import type { Tx } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { AppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { emit } from '@inmolink/platform/outbox';
import type { Ctx, CtxRunner, StaffCtx } from '../../context';
import { decodeCursor, toPage } from '../../pagination';
import { billingConfig, dunningGraceMs, stripeClient } from './config';
import { billingEvents } from './events';
import { billingJobs } from './jobs';
import { effectivePlan, planGate } from './plan';
import { assertCan, assertStaffCan, can } from './policy';
import * as repo from './repo';
import { StripeError, verifyStripeSignature } from './stripe';

/**
 * billing use cases (PATTERNS §7): `(ctx: Ctx, input) → DTO`. Authorize with `assertCan`, read and
 * write through `./repo`, emit outbox events in the same transaction, never call the network inside one.
 */

/** The start of the dunning grace window: a subscription past due since before it has lost its plan. */
const graceStart = (now: Date) => new Date(now.getTime() - dunningGraceMs());

/**
 * S13-02: the agency's plan in force (one statement) — the highest of its live subscription's (past due: within the
 * dunning grace) and its running grants' (trial, staff), else Free. Read by gates and seat checks when they run, never
 * per request (`ctx.tenant.plan` stays unset: a statement on every endpoint would break the query budgets).
 */
export async function planOf(tx: Tx, agencyId: string): Promise<repo.PlanInForce> {
  const now = clock.now();
  return repo.planInForce(tx, agencyId, now, graceStart(now));
}

/**
 * S13-02: the gate of a plan feature (PLAN §11). A gated use case calls it after its policy check; without the feature
 * on the agency's plan it answers `PLAN_REQUIRED` with the cheapest plan that has it (`requiredPlan`, null when only a
 * custom plan would). Off while plans are not enforced (`BILLING_ENFORCE_PLANS`, until billing is live: H3).
 */
export async function requirePlan(ctx: Ctx, feature: PlanFeature): Promise<void> {
  if (!billingConfig().enforcePlans) return;
  const plan = (await planOf(ctx.tx, ctx.tenant.agencyId)).code;
  const gate = planGate(await repo.planMatrix(ctx.tx), plan, feature);
  if (!gate.allowed) throw new AppError('PLAN_REQUIRED', { feature, plan, requiredPlan: gate.requiredPlan });
}

/**
 * S13-02: serialises the seat checks of the caller's agency until the transaction ends. Call it before counting the
 * seats in use (two concurrent invites must not both take the last seat; S1-02 review).
 */
export async function lockSeats(ctx: Ctx): Promise<void> {
  await repo.lockSeats(ctx.tx, ctx.tenant.agencyId);
}

/**
 * Seat check before a new member is added (S1-02). `used` counts active members plus open invites, counted by the
 * caller after `lockSeats` (billing never reads another module's tables). S13-02: `PLAN_REQUIRED` (`reason: seats`)
 * when `used + 1` exceeds the plan's seats plus extra-user add-ons — only while plans are enforced.
 */
export async function assertSeat(ctx: Ctx, seats: { used: number }): Promise<void> {
  if (!billingConfig().enforcePlans) return;
  const limit = await seatLimit(ctx.tx, ctx.tenant.agencyId);
  if (limit.seats !== null && seats.used + 1 > limit.seats) {
    throw new AppError('PLAN_REQUIRED', { reason: 'seats', plan: limit.plan, seats: limit.seats });
  }
}

/** Members the agency may have: its plan's seats (null: no limit) plus the seats of its live subscription's add-ons. */
async function seatLimit(tx: Tx, agencyId: string): Promise<{ plan: string; seats: number | null }> {
  const now = clock.now();
  const plan = await repo.planInForce(tx, agencyId, now, graceStart(now));
  if (plan.seats === null) return { plan: plan.code, seats: null };
  const sub = await repo.subscriptionOf(tx, agencyId);
  if (!sub || effectivePlan(sub, graceStart(now)) === FREE_PLAN || sub.addons.length === 0) {
    return { plan: plan.code, seats: plan.seats };
  }
  const perUnit = await repo.addonSeats(
    tx,
    sub.addons.map((a) => a.code),
  );
  const extra = sub.addons.reduce((n, a) => n + (perUnit.get(a.code) ?? 0) * a.quantity, 0);
  return { plan: plan.code, seats: plan.seats + extra };
}

/** The billing page: the plan in force, the subscription, and what can be bought. */
export async function getBillingOverview(ctx: Ctx): Promise<BillingOverviewDto> {
  assertCan(ctx, 'billing.read');
  const { agencyId } = ctx.tenant;
  const sub = await repo.subscriptionOf(ctx.tx, agencyId);
  const customer = await repo.customerOf(ctx.tx, agencyId);
  const catalog = await repo.offeredCatalog(ctx.tx);
  const plan = await planOf(ctx.tx, agencyId);
  const seats = await seatLimit(ctx.tx, agencyId);
  return {
    plan: plan.code,
    seats: seats.seats,
    grant: plan.grant ? { ...plan.grant, endsAt: plan.grant.endsAt.toISOString() } : null,
    graceEndsAt:
      sub?.status === 'PAST_DUE' && sub.pastDueSince
        ? new Date(sub.pastDueSince.getTime() + dunningGraceMs()).toISOString()
        : null,
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
    const rowOf = (code: string, kind: 'PLAN' | 'ADDON') =>
      catalog.find(
        (r) => r.code === code && r.kind === kind && r.interval === input.interval && r.currency === input.currency,
      );
    const priceOf = (code: string, kind: 'PLAN' | 'ADDON') => rowOf(code, kind)?.stripePriceId ?? null;
    const planPrice = priceOf(input.planCode, 'PLAN');
    if (!planPrice) throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: input.planCode });
    // S13-02: a founding price lock discounts the plan's current price down to the locked amount until it ends.
    const now = clock.now();
    const lock = await repo.priceLockFor(ctx.tx, agencyId, input, now);
    const planRow = rowOf(input.planCode, 'PLAN');
    const amount = planRow?.amountCents ?? 0;
    const product = planRow?.stripeProductId ?? null;
    const coupon =
      lock && product && lock.amountCents < amount ? lockCoupon(lock, amount, input.currency, product, now) : null;
    const lineItems = [{ price: planPrice, quantity: 1 }];
    const seen = new Set<string>();
    for (const a of input.addons) {
      const price = priceOf(a.code, 'ADDON');
      if (!price || seen.has(a.code)) throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: a.code });
      seen.add(a.code);
      lineItems.push({ price, quantity: a.quantity });
    }
    return { agencyId, customer, lineItems, coupon, locale: ctx.locale, requestId: ctx.requestId };
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
  const coupon = plan.coupon;
  const couponId = coupon ? await callStripe(() => stripe.ensureCoupon(coupon)) : null;
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
      ...(couponId ? { couponId } : {}),
    }),
  );
  return { url: session.url };
}

/**
 * The coupon of a price lock: the difference off every invoice until the lock ends (whole months, at least one). Its
 * id names the lock, the amount and the months, so a changed lock is a new coupon and a repeated checkout reuses it.
 * Security review: it applies to the locked plan's Stripe product only — never to add-ons or another plan. (A switch to
 * another interval or currency of the same plan in the Customer Portal loses it: S13-F23, `billing.applyStripeEvent`.)
 */
function lockCoupon(
  lock: { id: string; amountCents: number; endsAt: Date },
  priceCents: number,
  currency: string,
  productId: string,
  now: Date,
) {
  const amountOffCents = priceCents - lock.amountCents;
  const months = Math.max(1, Math.ceil((lock.endsAt.getTime() - now.getTime()) / MONTH_MS));
  return { id: `founding_${lock.id}_${amountOffCents}_${months}`, amountOffCents, currency, months, productId };
}

/** An average calendar month (365.25 / 12 days). */
const MONTH_MS = 30.4375 * 86_400_000;

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
      item = {
        code: r.code,
        kind: r.kind,
        seatsIncluded: r.seatsIncluded,
        // S13-02: only known feature keys (a catalog row ahead of this release keeps its others for later).
        features: r.features.filter((f): f is PlanFeature => PlanFeatureSchema.safeParse(f).success),
        prices: [],
      };
      items.set(r.code, item);
    }
    if (r.interval && r.amountCents !== null && (r.currency === 'EUR' || r.currency === 'GBP')) {
      item.prices.push({ interval: r.interval, currency: r.currency, amountCents: r.amountCents });
    }
  }
  return [...items.values()];
}

// ---- staff: plan grants and founding price locks (S13-02) ----

/**
 * Puts an agency on a plan until `endsAt` without a subscription (founding parallel run, pilot, goodwill). Super admins
 * only; the grant row records who, why and until when (never deleted). The plan applies on the agency's next request.
 */
export async function grantPlan(ctx: StaffCtx, input: GrantPlanBody): Promise<PlanGrantDto> {
  assertStaffCan(ctx, 'staff.billing.grant');
  const now = clock.now();
  const endsAt = new Date(input.endsAt);
  if (endsAt <= now) throw new AppError('VALIDATION_FAILED', { field: 'endsAt', reason: 'past' });
  if (!(await repo.isPlan(ctx.tx, input.planCode))) {
    throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: input.planCode });
  }
  const id = newId();
  await repo.insertGrant(ctx.tx, {
    id,
    agencyId: input.agencyId,
    kind: 'STAFF',
    planCode: input.planCode,
    startsAt: now,
    endsAt,
    reason: input.reason,
    grantedBy: ctx.actor.userId,
  });
  const plan = await repo.planInForce(ctx.tx, input.agencyId, now, graceStart(now));
  await emit(ctx.tx, billingEvents.planChanged({ agencyId: input.agencyId, plan: plan.code, reason: 'GRANT_STARTED' }));
  return toGrantDto((await repo.grantById(ctx.tx, id)) as repo.GrantRow);
}

/**
 * Ends a grant now (super admins) and announces the plan in force (`billing.plan.changed`). The plan falls back on the
 * agency's next request; the row stays, revoked, with who revoked it and why (S13-03: the reason stays on the row, for
 * staff — never in the agency's audit log).
 */
export async function revokePlanGrant(ctx: StaffCtx, grantId: string, reason: string): Promise<PlanGrantDto> {
  assertStaffCan(ctx, 'staff.billing.grant');
  const now = clock.now();
  const row = await repo.revokeGrant(ctx.tx, grantId, ctx.actor.userId, now, reason);
  if (!row) throw new AppError('BILLING_GRANT_NOT_FOUND');
  const plan = await repo.planInForce(ctx.tx, row.agencyId, now, graceStart(now));
  await emit(ctx.tx, billingEvents.planChanged({ agencyId: row.agencyId, plan: plan.code, reason: 'GRANT_ENDED' }));
  return toGrantDto(row);
}

/**
 * Sets a founding price lock (super admins): Checkout of that plan price discounts it down to `amountCents` until
 * `endsAt` (a Stripe coupon). Setting it again replaces the earlier lock of the same plan, interval and currency.
 */
export async function setPriceLock(ctx: StaffCtx, input: PriceLockBody): Promise<{ id: string }> {
  assertStaffCan(ctx, 'staff.billing.grant');
  const endsAt = new Date(input.endsAt);
  if (endsAt <= clock.now()) throw new AppError('VALIDATION_FAILED', { field: 'endsAt', reason: 'past' });
  if (!(await repo.isPlan(ctx.tx, input.planCode))) {
    throw new AppError('BILLING_PRICE_UNAVAILABLE', { code: input.planCode });
  }
  const id = await repo.upsertPriceLock(ctx.tx, {
    id: newId(),
    agencyId: input.agencyId,
    planCode: input.planCode,
    interval: input.interval,
    currency: input.currency,
    amountCents: input.amountCents,
    endsAt,
    reason: input.reason,
    grantedBy: ctx.actor.userId,
  });
  return { id };
}

/**
 * S13-03, the staff console: an agency's plan grants (trials and staff grants, revoked ones too) and price locks, at
 * most `STAFF_BILLING_LIST_LIMIT` of each (an agency has a handful). Every staff role reads them. Two statements.
 */
export async function listAgencyBillingForStaff(ctx: StaffCtx, agencyId: string): Promise<StaffAgencyBillingDto> {
  assertStaffCan(ctx, 'staff.billing.read');
  const grants = await repo.listAgencyGrants(ctx.tx, agencyId, STAFF_BILLING_LIST_LIMIT);
  const locks = await repo.listAgencyPriceLocks(ctx.tx, agencyId, STAFF_BILLING_LIST_LIMIT);
  return {
    grants: grants.map((g) => ({
      ...toGrantDto(g),
      reason: g.reason,
      grantedBy: g.grantedBy,
      revokedBy: g.revokedBy,
      revokeReason: g.revokeReason,
    })),
    priceLocks: locks.map((l) => ({ ...l, endsAt: l.endsAt.toISOString() })),
  };
}

function toGrantDto(g: repo.GrantRow): PlanGrantDto {
  return {
    id: g.id,
    agencyId: g.agencyId,
    kind: g.kind,
    planCode: g.planCode,
    startsAt: g.startsAt.toISOString(),
    endsAt: g.endsAt.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
  };
}
