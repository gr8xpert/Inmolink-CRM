import {
  BillingOverviewDto,
  BillingRedirectDto,
  InvoicePage,
  ListInvoicesQuery,
  StartCheckoutBody,
  StripeWebhookAck,
} from '@inmolink/contracts';
import * as billing from '@inmolink/core/modules/billing';
import { AppError } from '@inmolink/platform/errors';
import { ipBucket, type RateLimiter, type RateLimitRule, replyRateLimited } from '@inmolink/platform/rate-limit';
import type { FastifyZod } from '@inmolink/platform/server';

const READ_LIMITS: readonly RateLimitRule[] = [
  { name: 'billing.read.ip', scope: 'ip', limit: 600, windowSeconds: 60 },
  { name: 'billing.read.user', scope: 'user', limit: 120, windowSeconds: 60 },
];
// Checkout and the portal talk to Stripe during the request: a few a minute per member, and per agency.
const STRIPE_LIMITS: readonly RateLimitRule[] = [
  { name: 'billing.stripe.ip', scope: 'ip', limit: 60, windowSeconds: 60 },
  { name: 'billing.stripe.user', scope: 'user', limit: 10, windowSeconds: 60 },
  { name: 'billing.stripe.tenant', scope: 'tenant', limit: 60, windowSeconds: 3_600 },
];
/**
 * Stripe's webhook, counted after the signature check (S13-F20): signed deliveries and unsigned junk have their own
 * per-address buckets, so a flood of junk from one address (even one in Stripe's egress range, which is shared) cannot
 * push Stripe's own deliveries into 429. Signed: Stripe's bursts (retries after an outage) come from a handful of
 * Stripe addresses. Unsigned: a misconfigured secret or a probe gets a few honest 400s a minute, then 429.
 */
export const WEBHOOK_SIGNED_LIMIT: RateLimitRule = {
  name: 'billing.webhook.signed.ip',
  scope: 'ip',
  limit: 1_200,
  windowSeconds: 60,
};
export const WEBHOOK_UNSIGNED_LIMIT: RateLimitRule = {
  name: 'billing.webhook.unsigned.ip',
  scope: 'ip',
  limit: 60,
  windowSeconds: 60,
};
/**
 * Security review (S13-F20): a pre-body backstop per address, far above Stripe's bursts, so junk with a well-formed
 * signature header cannot make the route read bodies and compute HMACs without bound.
 */
export const WEBHOOK_BACKSTOP_LIMITS: RateLimitRule[] = [
  { name: 'billing.webhook.backstop.ip', scope: 'ip', limit: 12_000, windowSeconds: 60 },
];
/** Stripe's event payloads are small; anything larger is not Stripe. */
const WEBHOOK_MAX_BYTES = 256 * 1024;

const NO_STORE = 'no-store';

/**
 * Billing (S13-01, PLAN §3 #28): the plan in force and the catalog, Stripe Checkout and the Customer Portal (admins),
 * invoices, and Stripe's webhook.
 */
export async function billingRoutes(app: FastifyZod, opts: { limiter: RateLimiter }): Promise<void> {
  app.get(
    '/v1/billing',
    {
      schema: {
        tags: ['billing'],
        operationId: 'billing.getOverview',
        summary: 'The plan in force, the subscription and the plans and add-ons on offer',
        response: { 200: BillingOverviewDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => billing.getBillingOverview(ctx));
    },
  );

  app.get(
    '/v1/billing/invoices',
    {
      schema: {
        tags: ['billing'],
        operationId: 'billing.listInvoices',
        summary: "The agency's invoices, newest first",
        querystring: ListInvoicesQuery,
        response: { 200: InvoicePage },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: READ_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return app.withCtx(req, (ctx) => billing.listInvoices(ctx, req.query));
    },
  );

  app.post(
    '/v1/billing/checkout',
    {
      schema: {
        tags: ['billing'],
        operationId: 'billing.startCheckout',
        summary: 'Start a Stripe Checkout for a plan and add-ons: the URL to send the member to (admins)',
        body: StartCheckoutBody,
        response: { 200: BillingRedirectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STRIPE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return billing.startCheckout(app.ctxRunner(req), req.body);
    },
  );

  app.post(
    '/v1/billing/portal',
    {
      schema: {
        tags: ['billing'],
        operationId: 'billing.openPortal',
        summary: "A Stripe Customer Portal session's URL (admins)",
        response: { 200: BillingRedirectDto },
      },
      onRequest: [app.requireSession],
      config: { rateLimit: STRIPE_LIMITS },
    },
    async (req, reply) => {
      reply.header('cache-control', NO_STORE);
      return billing.openCustomerPortal(app.ctxRunner(req));
    },
  );

  await app.register(stripeWebhookRoute, { limiter: opts.limiter });
}

/**
 * Stripe's webhook, in its own plugin: only here is a JSON body kept raw (the signature covers the exact bytes). No
 * session: the `Stripe-Signature` is the authentication, checked before anything is parsed; the event is queued and
 * answered at once (rules/api.md).
 * The plugin's pre-body IP limit is off here (it cannot tell Stripe from junk on a shared address); the route counts
 * each delivery in its signed or unsigned bucket instead. The body is capped at 256 KB and the check is one HMAC.
 */
async function stripeWebhookRoute(hook: FastifyZod, opts: { limiter: RateLimiter }): Promise<void> {
  hook.removeContentTypeParser('application/json');
  hook.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  hook.post(
    '/v1/billing/stripe/webhook',
    {
      schema: {
        tags: ['billing'],
        operationId: 'billing.stripeWebhook',
        summary: "Stripe's webhook (signed with the endpoint's secret)",
        response: { 200: StripeWebhookAck },
      },
      bodyLimit: WEBHOOK_MAX_BYTES,
      config: { rateLimit: WEBHOOK_BACKSTOP_LIMITS },
    },
    async (req, reply) => {
      const header = req.headers['stripe-signature'];
      const delivery = {
        payload: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        signature: typeof header === 'string' ? header : undefined,
      };
      const rule = billing.isSignedStripeDelivery(delivery) ? WEBHOOK_SIGNED_LIMIT : WEBHOOK_UNSIGNED_LIMIT;
      const limited = await opts.limiter.consume(rule, ipBucket(req.ip));
      if (!limited.allowed) {
        req.log.info({ rule: rule.name, scope: rule.scope }, 'rate limited');
        return replyRateLimited(reply, rule.scope, limited.retryAfterSeconds);
      }
      if (!Buffer.isBuffer(req.body)) throw new AppError('BILLING_WEBHOOK_INVALID');
      await billing.receiveStripeWebhook(delivery);
      return { received: true as const };
    },
  );
}
