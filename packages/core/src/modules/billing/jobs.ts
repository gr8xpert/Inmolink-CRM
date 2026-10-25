import type { BillingCurrency, BillingInterval, SubscriptionStatus } from '@inmolink/contracts';
import { SubscriptionStatus as SubscriptionStatusSchema } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { clock } from '@inmolink/platform/clock';
import { newId } from '@inmolink/platform/ids';
import type { Logger } from '@inmolink/platform/logger';
import { emit } from '@inmolink/platform/outbox';
import { defineJob, UnrecoverableError } from '@inmolink/platform/queue';
import { z } from 'zod';
import { stripeClient } from './config';
import { billingEvents } from './events';
import { effectivePlan, UNKNOWN_PLAN } from './plan';
import * as repo from './repo';
import { type StripeClient, StripeError, type StripeInvoice, type StripeSubscription } from './stripe';

/**
 * billing worker jobs (PATTERNS §12), all in the `maintenance` pool:
 * - `billing.applyStripeEvent` — one per Stripe event id (the webhook route queues it). Out-of-order safe by
 *   construction: it never applies the event's payload, it re-reads the object's current state from Stripe and writes
 *   that, one job at a time per Stripe customer. Idempotent: the event id is recorded in the transaction that applies it.
 * - `billing.syncCatalog` — every 15 minutes: Stripe products and prices for catalog rows that have none yet.
 * - `billing.pruneStripeEvents` — daily: applied event ids after `STRIPE_EVENT_RETENTION_DAYS`.
 */

const STRIPE_EVENT_RETENTION_DAYS = 30;
const PRUNE_BATCH = 5_000;
/** Stripe calls per catalog sync run (workers.md: ≤ 100 API calls per batch). */
const SYNC_BATCH = 50;

export const billingJobs = {
  applyStripeEvent: defineJob({
    name: 'billing.applyStripeEvent',
    pool: 'maintenance',
    payload: z
      .object({
        eventId: z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/),
        type: z.string().regex(/^[a-z_.]{1,100}$/),
        objectId: z.string().min(1).max(255),
        customerId: z.string().min(1).max(255).nullable(),
      })
      .strict(),
    jobId: (p) => `stripe:${p.eventId}`,
    // One customer's events in order of processing: each run reads Stripe's latest state, so the last write wins.
    group: (p) => `stripe:${p.customerId ?? p.objectId}`,
    concurrencyPerGroup: 1,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5_000 },
    timeoutMs: 60_000,
    async run(p, { log }) {
      if (await withSystem('billing.applyStripeEvent', (tx) => repo.eventSeen(tx, p.eventId)))
        return { skipped: 'seen' };
      const stripe = stripeClient();
      if (!stripe) throw new Error('billing: Stripe is not configured on this worker');
      const state = await failFast(() => readState(stripe, p));
      return withSystem('billing.applyStripeEvent', async (tx) => {
        if (!(await repo.markEvent(tx, p.eventId, p.type))) return { skipped: 'seen' };
        if (!state) return { applied: 'nothing' };
        const agencyId = await repo.agencyOfCustomer(tx, state.customerId);
        // Not one of our customers (another integration on the account, or a deleted agency's): acknowledged.
        if (!agencyId) return { applied: 'foreign' };
        if (state.kind === 'subscription') return applySubscription(tx, agencyId, state.subscription, log);
        await applyInvoice(tx, agencyId, state.invoice);
        return { applied: 'invoice' };
      });
    },
  }),

  syncCatalog: defineJob({
    name: 'billing.syncCatalog',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 15 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log }) {
      const stripe = stripeClient();
      if (!stripe) return { skipped: 'not_configured' };
      let products = 0;
      let prices = 0;
      const items = await withSystem('billing.syncCatalog', (tx) => repo.itemsToSync(tx, SYNC_BATCH));
      for (const item of items) {
        const product = await failFast(() => stripe.createProduct(item.id, item.code));
        await withSystem('billing.syncCatalog', (tx) => repo.setProductId(tx, item.id, product.id));
        products++;
      }
      const pending = await withSystem('billing.syncCatalog', (tx) => repo.pricesToSync(tx, SYNC_BATCH));
      for (const price of pending) {
        const created = await failFast(() =>
          stripe.createPrice({
            priceId: price.id,
            productId: price.productId as string,
            amountCents: price.amountCents,
            currency: price.currency,
            interval: price.interval === 'YEAR' ? 'year' : 'month',
          }),
        );
        await withSystem('billing.syncCatalog', (tx) => repo.setStripePriceId(tx, price.id, created.id));
        prices++;
      }
      if (products || prices) log.info({ products, prices }, 'billing catalog synced to Stripe');
      return { products, prices };
    },
  }),

  pruneStripeEvents: defineJob({
    name: 'billing.pruneStripeEvents',
    pool: 'maintenance',
    payload: z.object({}).strict(),
    every: 24 * 60 * 60_000,
    attempts: 3,
    timeoutMs: 5 * 60_000,
    async run(_p, { log, signal }) {
      const before = new Date(clock.now().getTime() - STRIPE_EVENT_RETENTION_DAYS * 86_400_000);
      let total = 0;
      for (;;) {
        const deleted = await withSystem('billing.pruneStripeEvents', (tx) =>
          repo.pruneEvents(tx, before, PRUNE_BATCH),
        );
        total += deleted;
        if (deleted < PRUNE_BATCH || signal.aborted) break;
      }
      if (total) log.info({ deleted: total }, 'stripe events pruned');
      return { deleted: total };
    },
  }),
};

type State =
  | { kind: 'subscription'; customerId: string; subscription: StripeSubscription }
  | { kind: 'invoice'; customerId: string; invoice: StripeInvoice }
  | null;

/** The event's object as Stripe has it now (network, outside any transaction). */
async function readState(stripe: StripeClient, p: { type: string; objectId: string }): Promise<State> {
  if (p.type.startsWith('customer.subscription.')) {
    const subscription = await stripe.getSubscription(p.objectId);
    return subscription ? { kind: 'subscription', customerId: subscription.customerId, subscription } : null;
  }
  if (p.type.startsWith('checkout.session.')) {
    const session = await stripe.getCheckoutSession(p.objectId);
    if (!session?.subscriptionId) return null;
    const subscription = await stripe.getSubscription(session.subscriptionId);
    return subscription ? { kind: 'subscription', customerId: subscription.customerId, subscription } : null;
  }
  if (p.type.startsWith('invoice.')) {
    const invoice = await stripe.getInvoice(p.objectId);
    return invoice ? { kind: 'invoice', customerId: invoice.customerId, invoice } : null;
  }
  return null;
}

/** Statuses after which a subscription never comes back: a late event about it never replaces a newer one. */
const ENDED: ReadonlySet<SubscriptionStatus> = new Set(['CANCELED', 'INCOMPLETE_EXPIRED']);
const LIVE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'PAUSED']);

async function applySubscription(tx: Tx, agencyId: string, s: StripeSubscription, log: Logger) {
  const status = toStatus(s.status);
  const current = await repo.subscriptionOf(tx, agencyId, true);
  if (current && current.stripeSubscriptionId !== s.id) {
    // Another subscription than the one on record: an old one's late news, or a second checkout. Replace the record
    // only when the recorded one has ended and the new one has not.
    if (ENDED.has(status) || !(ENDED.has(current.status) || current.status === 'INCOMPLETE')) {
      // A late event about an old subscription, or two live ones (Checkout guards against it; someone must refund
      // one): the second is an alert, never a silent drop.
      const late = ENDED.has(status);
      log[late ? 'info' : 'error'](
        { agencyId, recorded: current.stripeSubscriptionId, incoming: s.id, status },
        late ? 'billing: late event about another subscription' : 'billing: second live subscription (ALERT)',
      );
      return { applied: 'ignored' };
    }
  }
  const prices = await repo.pricesByStripeIds(
    tx,
    s.items.map((i) => i.priceId),
  );
  const planItem = s.items.find((i) => prices.get(i.priceId)?.kind === 'PLAN');
  // S13-01 security review: never Stripe metadata (it survives portal plan changes) — an unknown price is Free + an alert.
  const planCode = planItem ? (prices.get(planItem.priceId)?.code as string) : UNKNOWN_PLAN;
  if (!planItem && LIVE_STATUSES.has(status)) {
    log.error({ agencyId, subscription: s.id }, 'billing: live subscription without a catalog plan price (ALERT)');
  }
  const first = planItem ?? s.items[0];
  const interval: BillingInterval | null =
    first?.interval === 'year' ? 'YEAR' : first?.interval === 'month' ? 'MONTH' : null;
  const currency: BillingCurrency | null =
    first?.currency === 'EUR' || first?.currency === 'GBP' ? first.currency : null;
  const addons = s.items.flatMap((i) => {
    const p = prices.get(i.priceId);
    return p?.kind === 'ADDON' ? [{ code: p.code, quantity: i.quantity }] : [];
  });
  await repo.upsertSubscription(tx, {
    agencyId,
    stripeSubscriptionId: s.id,
    planCode,
    status,
    interval,
    currency,
    addons,
    paymentMethod: s.paymentMethod,
    currentPeriodEnd: first?.currentPeriodEnd ?? null,
    cancelAt: s.cancelAt,
    syncedAt: clock.now(),
  });
  const before = current ? effectivePlan(current) : null;
  const plan = effectivePlan({ planCode, status });
  if (before !== plan || current?.status !== status) {
    await emit(tx, billingEvents.subscriptionChanged({ agencyId, plan, status }));
  }
  return { applied: 'subscription', plan, status };
}

async function applyInvoice(tx: Tx, agencyId: string, i: StripeInvoice): Promise<void> {
  // Drafts are not invoices yet (Stripe may still change or delete them); they appear once finalized.
  if (i.status === 'draft') return;
  await repo.upsertInvoice(tx, {
    id: newId(),
    agencyId,
    stripeInvoiceId: i.id,
    number: i.number,
    status: toInvoiceStatus(i.status),
    currency: i.currency || 'EUR',
    totalCents: i.total,
    taxCents: i.tax,
    amountPaidCents: i.amountPaid,
    hostedUrl: i.hostedUrl,
    pdfUrl: i.pdfUrl,
    issuedAt: i.created,
    syncedAt: clock.now(),
  });
}

/** Stripe's refusals (400, 401, 404 on a write) never succeed on retry: fail the job for good (workers.md). */
async function failFast<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StripeError && !err.retryable)
      throw new UnrecoverableError(`Stripe ${err.status}: ${err.message}`);
    throw err;
  }
}

function toStatus(s: string): SubscriptionStatus {
  const parsed = SubscriptionStatusSchema.safeParse(s.toUpperCase());
  return parsed.success ? parsed.data : 'INCOMPLETE';
}

function toInvoiceStatus(s: string): repo.InvoiceWrite['status'] {
  switch (s) {
    case 'open':
      return 'OPEN';
    case 'paid':
      return 'PAID';
    case 'void':
      return 'VOID';
    case 'uncollectible':
      return 'UNCOLLECTIBLE';
    default:
      return 'DRAFT';
  }
}
