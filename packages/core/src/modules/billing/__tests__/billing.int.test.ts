import { closeDb, withSystem } from '@inmolink/db';
import { createStaffUser, loadStackEnv, setupTestDb } from '@inmolink/db/testing';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { closeQueues, configureQueue, queueFor, stableJobId } from '@inmolink/platform/queue';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { withStaffCtx } from '../../../staff';
import { countQueries, createFounder, type Founder } from '../../../testing/factories';
import * as billing from '../index';
import { type FakeStripe, startFakeStripe } from './fake-stripe';

/**
 * Billing end to end (S13-01) against a fake Stripe API (the real test-mode account waits on H3): the catalog synced to
 * Stripe, Checkout for Pro annual with SEPA Direct Debit, Stripe Tax and VAT ID, signed webhooks queued and applied by
 * re-reading Stripe's state (idempotent, out-of-order safe), cancellation falling back to Free at period end with data
 * intact, invoices, and who may do what.
 */

const RUN = newId().slice(-8);
const PRO = `pro_${RUN}`;
const SEAT = `seat_${RUN}`;
const RETURN_URL = 'http://web.test/billing';
const log = createLogger({ service: 'billing-int', level: 'silent' });
const jobCtx = () => ({
  log,
  jobId: newId(),
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

let stripe: FakeStripe;
let a: Founder;
let b: Founder;

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>, patch: (ctx: Ctx) => Ctx = (c) => c) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'es' }, (ctx) => fn(patch(ctx)));
const run =
  (m: Founder, patch?: (ctx: Ctx) => Ctx) =>
  <T>(fn: (ctx: Ctx) => Promise<T>) =>
    as(m, fn, patch);
const asAgent = (ctx: Ctx): Ctx =>
  ({ ...ctx, actor: { ...(ctx.actor as { kind: 'user'; userId: string; role: string }), role: 'AGENT' } }) as Ctx;
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('billing.int.test', fn);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

function configureEnabled() {
  billing.configureBilling({
    stripe: {
      secretKey: stripe.secretKey,
      apiUrl: stripe.origin,
      webhookSecret: stripe.webhookSecret,
      returnUrl: RETURN_URL,
      redirectHosts: ['checkout.stripe.test', 'billing.stripe.test'],
    },
  });
}

/** Stripe delivers `type` about `object`: the webhook is received, its queued job taken from the queue and run. */
async function deliver(type: string, object: Record<string, unknown>, opts: { id?: string } = {}) {
  const { body, signature } = stripe.event(type, object, opts);
  await billing.receiveStripeWebhook({ payload: body, signature });
  const eventId = JSON.parse(body.toString()).id as string;
  const job = await queueFor('maintenance').getJob(stableJobId('billing.applyStripeEvent', `stripe:${eventId}`));
  if (!job) return { queued: false as const };
  const payload = (job.data as { p: unknown }).p as Parameters<typeof billing.billingJobs.applyStripeEvent.spec.run>[0];
  const result = await billing.billingJobs.applyStripeEvent.spec.run(payload, jobCtx());
  await job.remove();
  return { queued: true as const, result, payload };
}

const stripePriceOf = (code: string, interval: 'YEAR' | 'MONTH', currency: 'EUR' | 'GBP') =>
  system(async (tx) => {
    const r = await tx.execute<{ id: string | null }>(sql`select p.stripe_price_id as id from billing_prices p
      join billing_catalog_items i on i.id = p.item_id
      where i.code = ${code} and p.interval = ${interval} and p.currency = ${currency} and p.active`);
    return r.rows[0]?.id ?? null;
  });

const lastCheckout = () =>
  [...stripe.calls].reverse().find((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions');

const changedEvents = (agencyId: string) =>
  system(async (tx) => {
    const r = await tx.execute<{ plan: string; status: string }>(
      sql`select payload->>'plan' as plan, payload->>'status' as status from outbox_events
          where type = 'billing.subscription.changed' and agency_id = ${agencyId}::uuid order by id`,
    );
    return r.rows;
  });

beforeAll(async () => {
  await setupTestDb('worker');
  loadStackEnv('test');
  await configureQueue({ prefix: `test-billing-${RUN}`, logger: log });
  stripe = await startFakeStripe();
  configureEnabled();
  a = await createFounder();
  b = await createFounder();
  await system((tx) =>
    billing.upsertCatalog(
      tx,
      [
        {
          code: PRO,
          kind: 'PLAN',
          seatsIncluded: 4,
          rank: 10,
          prices: [
            { interval: 'YEAR', currency: 'EUR', amountCents: 80_000 },
            { interval: 'MONTH', currency: 'EUR', amountCents: 7_900 },
            { interval: 'YEAR', currency: 'GBP', amountCents: 70_000 },
          ],
        },
        {
          code: SEAT,
          kind: 'ADDON',
          seatsIncluded: null,
          rank: 100,
          prices: [{ interval: 'YEAR', currency: 'EUR', amountCents: 10_000 }],
        },
      ],
      newId,
    ),
  );
}, 180_000);

afterAll(async () => {
  await stripe?.close();
  await closeQueues();
  await closeDb();
});

describe('billing', () => {
  it('[S13-01] the catalog syncs to Stripe once: a product per item, a VAT-exclusive recurring price per price', async () => {
    expect(await stripePriceOf(PRO, 'YEAR', 'EUR')).toBeNull();
    // Nothing on offer before Stripe knows the prices.
    const before = await as(a, (ctx) => billing.getBillingOverview(ctx));
    expect(before.catalog.find((i) => i.code === PRO)?.prices ?? []).toEqual([]);

    await billing.billingJobs.syncCatalog.spec.run({}, jobCtx());
    const yearly = await stripePriceOf(PRO, 'YEAR', 'EUR');
    expect(yearly).toMatch(/^price_/);
    expect(stripe.prices.get(yearly as string)).toMatchObject({
      unit_amount: 80_000,
      currency: 'eur',
      recurring: { interval: 'year' },
      tax_behavior: 'exclusive',
    });
    const created = stripe.calls.filter((c) => c.path === '/v1/prices').length;
    await billing.billingJobs.syncCatalog.spec.run({}, jobCtx());
    expect(stripe.calls.filter((c) => c.path === '/v1/prices').length).toBe(created);
    expect(stripe.calls.filter((c) => c.method === 'POST').every((c) => c.idempotencyKey)).toBe(true);

    const after = await as(a, (ctx) => billing.getBillingOverview(ctx));
    expect(after.plan).toBe('free');
    expect(after.catalog.find((i) => i.code === PRO)).toMatchObject({
      kind: 'PLAN',
      seatsIncluded: 4,
      prices: expect.arrayContaining([{ interval: 'YEAR', currency: 'EUR', amountCents: 80_000 }]),
    });
  });

  it('[S13-01] Pro annual Checkout: card + SEPA Direct Debit, Stripe Tax, VAT ID, one customer per agency', async () => {
    const { url } = await billing.startCheckout(run(a), {
      planCode: PRO,
      interval: 'YEAR',
      currency: 'EUR',
      addons: [{ code: SEAT, quantity: 2 }],
    });
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const call = lastCheckout();
    expect(call?.fields).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': (await stripePriceOf(PRO, 'YEAR', 'EUR')) as string,
      'line_items[0][quantity]': '1',
      'line_items[1][price]': (await stripePriceOf(SEAT, 'YEAR', 'EUR')) as string,
      'line_items[1][quantity]': '2',
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'sepa_debit',
      'automatic_tax[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
      billing_address_collection: 'required',
      client_reference_id: a.agencyId,
      locale: 'es',
      success_url: `${RETURN_URL}?checkout=success`,
    });
    const firstSession = [...stripe.sessions.keys()].at(-1) as string;
    // A second visit reuses the customer, and expires the first tab's open Checkout (never two paid subscriptions).
    await billing.startCheckout(run(a), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] });
    expect(stripe.sessions.get(firstSession)?.status).toBe('expired');
    expect(stripe.calls.filter((c) => c.path === '/v1/customers').length).toBe(1);
    expect((await as(a, (ctx) => billing.getBillingOverview(ctx))).hasCustomer).toBe(true);
    // GBP: card only (SEPA charges euros).
    await billing.startCheckout(run(a), { planCode: PRO, interval: 'YEAR', currency: 'GBP', addons: [] });
    expect(lastCheckout()?.fields['payment_method_types[1]']).toBeUndefined();
  });

  it('[S13-01] refuses prices not on offer and non-admins, Client Mode and impersonation', async () => {
    expect(
      await refusal(billing.startCheckout(run(a), { planCode: PRO, interval: 'MONTH', currency: 'GBP', addons: [] })),
    ).toBe('BILLING_PRICE_UNAVAILABLE');
    expect(
      await refusal(billing.startCheckout(run(a), { planCode: SEAT, interval: 'YEAR', currency: 'EUR', addons: [] })),
    ).toBe('BILLING_PRICE_UNAVAILABLE');
    expect(
      await refusal(
        billing.startCheckout(run(a, asAgent), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] }),
      ),
    ).toBe('FORBIDDEN');
    expect(await refusal(billing.openCustomerPortal(run(a, (c) => ({ ...c, clientMode: true }))))).toBe('FORBIDDEN');
    expect(
      await refusal(
        billing.openCustomerPortal(
          run(a, (c) => ({ ...c, actor: { ...c.actor, impersonatedBy: newId() } as Ctx['actor'] })),
        ),
      ),
    ).toBe('FORBIDDEN');
    // An agent may see the plan, never manage it.
    expect(await as(a, (ctx) => billing.getBillingOverview(ctx), asAgent)).toMatchObject({
      plan: 'free',
      canManage: false,
    });
    // Invoices are the admins' (hosted links show the billing address and VAT ID).
    expect(await refusal(as(a, (ctx) => billing.listInvoices(ctx, { limit: 25 }), asAgent))).toBe('FORBIDDEN');
    expect(await refusal(billing.openCustomerPortal(run(b)))).toBe('BILLING_NO_CUSTOMER');
    billing.configureBilling({});
    try {
      expect(
        await refusal(billing.startCheckout(run(a), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] })),
      ).toBe('BILLING_NOT_ENABLED');
    } finally {
      configureEnabled();
    }
  });

  it('[S13-01] webhooks: a wrong, missing or stale signature is refused before anything is queued', async () => {
    const { body } = stripe.event('customer.subscription.updated', {
      id: 'sub_x',
      object: 'subscription',
      customer: 'cus_x',
    });
    expect(await refusal(billing.receiveStripeWebhook({ payload: body, signature: undefined }))).toBe(
      'BILLING_WEBHOOK_INVALID',
    );
    expect(
      await refusal(
        billing.receiveStripeWebhook({
          payload: body,
          signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        }),
      ),
    ).toBe('BILLING_WEBHOOK_INVALID');
    const stale = stripe.event(
      'customer.subscription.updated',
      { id: 'sub_x', object: 'subscription', customer: 'cus_x' },
      { signedAtMs: Date.now() - 10 * 60_000 },
    );
    expect(await refusal(billing.receiveStripeWebhook({ payload: stale.body, signature: stale.signature }))).toBe(
      'BILLING_WEBHOOK_INVALID',
    );
    // A tampered body under a valid header.
    const ok = stripe.event('customer.subscription.updated', {
      id: 'sub_x',
      object: 'subscription',
      customer: 'cus_x',
    });
    const tampered = Buffer.from(ok.body.toString().replace('sub_x', 'sub_y'));
    expect(await refusal(billing.receiveStripeWebhook({ payload: tampered, signature: ok.signature }))).toBe(
      'BILLING_WEBHOOK_INVALID',
    );
  });

  let subscriptionId: string;
  const periodEnd = Math.floor(Date.now() / 1000) + 365 * 86_400;

  it('[S13-01] subscribe Pro annual with SEPA → active', async () => {
    await billing.startCheckout(run(a), {
      planCode: PRO,
      interval: 'YEAR',
      currency: 'EUR',
      addons: [{ code: SEAT, quantity: 1 }],
    });
    const sessionId = [...stripe.sessions.keys()].at(-1) as string;
    const sub = stripe.completeCheckout(sessionId, { paymentMethod: 'sepa_debit', periodEnd });
    subscriptionId = sub.id as string;
    const done = await deliver('checkout.session.completed', {
      id: sessionId,
      object: 'checkout.session',
      customer: sub.customer,
    });
    expect(done.queued).toBe(true);
    expect(done.result).toMatchObject({ applied: 'subscription', plan: PRO, status: 'ACTIVE' });
    const overview = await as(a, (ctx) => billing.getBillingOverview(ctx));
    expect(overview.plan).toBe(PRO);
    expect(overview.subscription).toMatchObject({
      planCode: PRO,
      status: 'ACTIVE',
      interval: 'YEAR',
      currency: 'EUR',
      paymentMethod: 'sepa_debit',
      addons: [{ code: SEAT, quantity: 1 }],
      currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
      cancelAt: null,
    });
    expect(await changedEvents(a.agencyId)).toEqual([{ plan: PRO, status: 'ACTIVE' }]);
    // Live: a second checkout is refused (changes go through the portal).
    expect(
      await refusal(billing.startCheckout(run(a), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] })),
    ).toBe('BILLING_ALREADY_SUBSCRIBED');
    expect((await billing.openCustomerPortal(run(a))).url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    // Another agency sees none of it.
    expect((await as(b, (ctx) => billing.getBillingOverview(ctx))).subscription).toBeNull();
  });

  it('[S13-01] a redelivered event is applied once', async () => {
    const id = `evt_${RUN}dup`;
    const object = {
      id: subscriptionId,
      object: 'subscription',
      customer: stripe.subscriptions.get(subscriptionId)?.customer,
    };
    const first = await deliver('customer.subscription.updated', object, { id });
    expect(first.result).toMatchObject({ applied: 'subscription' });
    const again = await billing.billingJobs.applyStripeEvent.spec.run(first.payload as never, jobCtx());
    expect(again).toEqual({ skipped: 'seen' });
    expect(await changedEvents(a.agencyId)).toHaveLength(1);
  });

  it('[S13-01] invoices are listed for their own agency only, newest first, by cursor', async () => {
    const customer = stripe.subscriptions.get(subscriptionId)?.customer as string;
    const base = Math.floor(Date.now() / 1000) - 3_600;
    for (const [i, status] of (['paid', 'open'] as const).entries()) {
      stripe.upsertInvoice({
        id: `in_${RUN}${i}`,
        customer,
        number: `INL-${RUN}-${i}`,
        status,
        currency: 'eur',
        total: 96_800,
        total_taxes: [{ amount: 16_800 }],
        amount_paid: status === 'paid' ? 96_800 : 0,
        hosted_invoice_url: `https://invoice.stripe.test/i/${i}`,
        invoice_pdf: 'http://not-https.example/pdf',
        created: base + i * 60,
      });
      await deliver(status === 'paid' ? 'invoice.paid' : 'invoice.finalized', {
        id: `in_${RUN}${i}`,
        object: 'invoice',
        customer,
      });
    }
    // A draft is not an invoice yet: not listed.
    stripe.upsertInvoice({ id: `in_${RUN}draft`, customer, status: 'draft', currency: 'eur', total: 1, created: base });
    await deliver('invoice.created', { id: `in_${RUN}draft`, object: 'invoice', customer });
    const page1 = await as(a, (ctx) => billing.listInvoices(ctx, { limit: 1 }));
    expect(page1.items).toEqual([
      expect.objectContaining({
        number: `INL-${RUN}-1`,
        status: 'OPEN',
        totalCents: 96_800,
        taxCents: 16_800,
        pdfUrl: null,
      }),
    ]);
    const page2 = await as(a, (ctx) => billing.listInvoices(ctx, { limit: 1, cursor: page1.nextCursor as string }));
    expect(page2.items).toEqual([
      expect.objectContaining({ number: `INL-${RUN}-0`, status: 'PAID', amountPaidCents: 96_800 }),
    ]);
    expect(page2.nextCursor).toBeNull();
    expect((await as(b, (ctx) => billing.listInvoices(ctx, { limit: 25 }))).items).toEqual([]);
    // Dashboard list budget (CLAUDE.md): ≤ 10 statements, one for the page.
    const n = await countQueries(() => as(a, (ctx) => billing.listInvoices(ctx, { limit: 25 })));
    expect(n).toBeLessThanOrEqual(10);
  });

  it('[S13-01] cancel → stays on Pro until the period ends, then falls back to Free with data intact', async () => {
    const customer = stripe.subscriptions.get(subscriptionId)?.customer;
    stripe.updateSubscription(subscriptionId, { cancel_at_period_end: true });
    await deliver('customer.subscription.updated', { id: subscriptionId, object: 'subscription', customer });
    const cancelling = await as(a, (ctx) => billing.getBillingOverview(ctx));
    expect(cancelling.plan).toBe(PRO);
    expect(cancelling.subscription).toMatchObject({
      status: 'ACTIVE',
      cancelAt: new Date(periodEnd * 1000).toISOString(),
    });

    // The period ends: Stripe deletes the subscription.
    stripe.updateSubscription(subscriptionId, { status: 'canceled' });
    const ended = await deliver('customer.subscription.deleted', {
      id: subscriptionId,
      object: 'subscription',
      customer,
    });
    expect(ended.result).toMatchObject({ plan: 'free', status: 'CANCELED' });
    const free = await as(a, (ctx) => billing.getBillingOverview(ctx));
    expect(free.plan).toBe('free');
    expect(free.subscription).toMatchObject({ planCode: PRO, status: 'CANCELED' });
    // Data intact: the customer (portal, invoices) and every invoice remain.
    expect(free.hasCustomer).toBe(true);
    expect((await as(a, (ctx) => billing.listInvoices(ctx, { limit: 25 }))).items).toHaveLength(2);
    expect((await changedEvents(a.agencyId)).at(-1)).toEqual({ plan: 'free', status: 'CANCELED' });

    // Out of order: an older "updated" delivered late does not bring Pro back (the job re-reads Stripe's state).
    const late = await deliver('customer.subscription.updated', {
      id: subscriptionId,
      object: 'subscription',
      customer,
    });
    expect(late.result).toMatchObject({ plan: 'free', status: 'CANCELED' });
    expect((await as(a, (ctx) => billing.getBillingOverview(ctx))).plan).toBe('free');

    // A new checkout after the end is allowed again; its subscription replaces the ended one.
    await billing.startCheckout(run(a), { planCode: PRO, interval: 'MONTH', currency: 'EUR', addons: [] });
    const renewed = stripe.completeCheckout([...stripe.sessions.keys()].at(-1) as string, {
      paymentMethod: 'card',
      periodEnd,
    });
    // Stripe knows it before the webhook arrives: another checkout is refused already.
    expect(
      await refusal(billing.startCheckout(run(a), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] })),
    ).toBe('BILLING_ALREADY_SUBSCRIBED');
    const back = await deliver('customer.subscription.created', { id: renewed.id, object: 'subscription', customer });
    expect(back.result).toMatchObject({ applied: 'subscription', plan: PRO, status: 'ACTIVE' });
    // The old subscription's late news is ignored: it never replaces the live one.
    const stale = await deliver('customer.subscription.deleted', {
      id: subscriptionId,
      object: 'subscription',
      customer,
    });
    expect(stale.result).toEqual({ applied: 'ignored' });
    expect(await as(a, (ctx) => billing.getBillingOverview(ctx))).toMatchObject({
      plan: PRO,
      subscription: { interval: 'MONTH', paymentMethod: 'card', status: 'ACTIVE' },
    });
  });

  it('[S13-01] a price outside the catalog is Free (never the plan in Stripe metadata)', async () => {
    await billing.startCheckout(run(b), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] });
    const session = [...stripe.sessions.keys()].at(-1) as string;
    const sub = stripe.completeCheckout(session, { paymentMethod: 'card', periodEnd });
    // Changed in the portal to a price Inmolink does not sell; the metadata still says Pro.
    stripe.updateSubscription(sub.id as string, {
      items: {
        data: [{ price: { id: `price_${RUN}x`, currency: 'eur', recurring: { interval: 'year' } }, quantity: 1 }],
      },
    });
    const r = await deliver('customer.subscription.updated', {
      id: sub.id,
      object: 'subscription',
      customer: sub.customer,
    });
    expect(r.result).toMatchObject({ plan: 'free', status: 'ACTIVE' });
    expect((await as(b, (ctx) => billing.getBillingOverview(ctx))).plan).toBe('free');
  });

  it('[S13-01] events about customers that are not ours, or objects Stripe no longer has, change nothing', async () => {
    const foreign = {
      id: `sub_${RUN}foreign`,
      object: 'subscription',
      customer: 'cus_foreign',
      status: 'active',
      items: { data: [] },
      metadata: {},
    };
    stripe.subscriptions.set(foreign.id, foreign);
    const r = await deliver('customer.subscription.created', {
      id: foreign.id,
      object: 'subscription',
      customer: 'cus_foreign',
    });
    expect(r.result).toEqual({ applied: 'foreign' });
    const gone = await deliver('invoice.paid', { id: 'in_missing', object: 'invoice', customer: 'cus_foreign' });
    expect(gone.result).toEqual({ applied: 'nothing' });
    // Not an event type billing handles: acknowledged, nothing queued.
    expect((await deliver('product.updated', { id: 'prod_x', object: 'product' })).queued).toBe(false);
  });

  let c: Founder;
  let cSubscription: string;

  it('[S13-02] a founding price lock: Checkout discounts the plan down to the locked price with a Stripe coupon', async () => {
    c = await createFounder();
    const staff = (await createStaffUser('SUPER_ADMIN')).userId;
    await withStaffCtx({ userId: staff, requestId: newId(), reason: 'billing test' }, (ctx) =>
      billing.setPriceLock(ctx, {
        agencyId: c.agencyId,
        planCode: PRO,
        interval: 'YEAR',
        currency: 'EUR',
        amountCents: 50_000,
        endsAt: new Date(Date.now() + 3 * 365 * 86_400_000).toISOString(),
        reason: 'founding offer: migrated agency',
      }),
    );
    // Monthly is not locked: no discount.
    await billing.startCheckout(run(c), { planCode: PRO, interval: 'MONTH', currency: 'EUR', addons: [] });
    expect(lastCheckout()?.fields['discounts[0][coupon]']).toBeUndefined();

    await billing.startCheckout(run(c), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] });
    const couponId = lastCheckout()?.fields['discounts[0][coupon]'] as string;
    expect(couponId).toMatch(/^founding_[0-9a-f-]{36}_30000_36$/);
    expect(stripe.coupons.get(couponId)).toMatchObject({
      amount_off: 30_000,
      currency: 'eur',
      duration: 'repeating',
      duration_in_months: '36',
    });
    // Only the locked plan's product: never the add-ons on the same invoice, nor another plan.
    const product = stripe.prices.get((await stripePriceOf(PRO, 'YEAR', 'EUR')) as string)?.product;
    expect(stripe.calls.find((x) => x.path === '/v1/coupons' && x.method === 'POST')?.fields).toMatchObject({
      'applies_to[products][0]': product,
    });
    // A second visit reuses the coupon.
    await billing.startCheckout(run(c), { planCode: PRO, interval: 'YEAR', currency: 'EUR', addons: [] });
    expect(lastCheckout()?.fields['discounts[0][coupon]']).toBe(couponId);
    expect(stripe.calls.filter((x) => x.method === 'POST' && x.path === '/v1/coupons')).toHaveLength(1);
  });

  it('[S13-02] dunning grace: a failed payment keeps the plan until the grace ends (with notice), then Free', async () => {
    const sessionId = [...stripe.sessions.keys()].at(-1) as string;
    const sub = stripe.completeCheckout(sessionId, { paymentMethod: 'card', periodEnd });
    cSubscription = sub.id as string;
    await deliver('checkout.session.completed', { id: sessionId, object: 'checkout.session', customer: sub.customer });
    expect((await as(c, (ctx) => billing.getBillingOverview(ctx))).plan).toBe(PRO);

    stripe.updateSubscription(cSubscription, { status: 'past_due' });
    const pastDue = await deliver('customer.subscription.updated', {
      id: cSubscription,
      object: 'subscription',
      customer: sub.customer,
    });
    expect(pastDue.result).toMatchObject({ plan: PRO, status: 'PAST_DUE' });
    const notice = await as(c, (ctx) => billing.getBillingOverview(ctx));
    expect(notice.plan).toBe(PRO);
    const graceDays = (Date.parse(notice.graceEndsAt as string) - Date.now()) / 86_400_000;
    expect(graceDays).toBeGreaterThan(13.9);
    expect(graceDays).toBeLessThanOrEqual(14);
    const dunning = await system(async (tx) => {
      const r = await tx.execute<{ grace: string }>(
        sql`select payload->>'graceEndsAt' as grace from outbox_events
            where type = 'billing.dunning.started' and agency_id = ${c.agencyId}::uuid`,
      );
      return r.rows.map((x) => x.grace);
    });
    expect(dunning).toEqual([notice.graceEndsAt]);

    // Stripe retries and reports past due again: the grace still counts from the first failure.
    await deliver('customer.subscription.updated', {
      id: cSubscription,
      object: 'subscription',
      customer: sub.customer,
    });
    expect((await as(c, (ctx) => billing.getBillingOverview(ctx))).graceEndsAt).toBe(notice.graceEndsAt);

    // The grace runs out: Free (the subscription row and every other datum stay).
    await system((tx) =>
      tx.execute(sql`update billing_subscriptions set past_due_since = now() - interval '15 days'
                     where agency_id = ${c.agencyId}::uuid`),
    );
    const lapsed = await as(c, (ctx) => billing.getBillingOverview(ctx));
    expect(lapsed.plan).toBe('free');
    expect(lapsed.subscription).toMatchObject({ planCode: PRO, status: 'PAST_DUE' });
    expect(await as(c, async (ctx) => (await billing.planOf(ctx.tx, ctx.tenant.agencyId)).code)).toBe('free');
  });
});
