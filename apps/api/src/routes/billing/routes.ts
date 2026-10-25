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
import type { RateLimitRule } from '@inmolink/platform/rate-limit';
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
/** Stripe's webhook bursts (retries after an outage) come from a handful of Stripe addresses. */
const WEBHOOK_LIMITS: readonly RateLimitRule[] = [
  { name: 'billing.webhook.ip', scope: 'ip', limit: 1_200, windowSeconds: 60 },
];
/** Stripe's event payloads are small; anything larger is not Stripe. */
const WEBHOOK_MAX_BYTES = 256 * 1024;

const NO_STORE = 'no-store';

/**
 * Billing (S13-01, PLAN §3 #28): the plan in force and the catalog, Stripe Checkout and the Customer Portal (admins),
 * invoices, and Stripe's webhook.
 */
export async function billingRoutes(app: FastifyZod): Promise<void> {
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

  await app.register(stripeWebhookRoute);
}

/**
 * Stripe's webhook, in its own plugin: only here is a JSON body kept raw (the signature covers the exact bytes). No
 * session: the `Stripe-Signature` is the authentication, checked before anything is parsed; the event is queued and
 * answered at once (rules/api.md).
 */
async function stripeWebhookRoute(hook: FastifyZod): Promise<void> {
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
      config: { rateLimit: WEBHOOK_LIMITS },
    },
    async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new AppError('BILLING_WEBHOOK_INVALID');
      const signature = req.headers['stripe-signature'];
      await billing.receiveStripeWebhook({
        payload: req.body,
        signature: typeof signature === 'string' ? signature : undefined,
      });
      return { received: true as const };
    },
  );
}
