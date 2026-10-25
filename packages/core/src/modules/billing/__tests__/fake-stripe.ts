import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { allowLoopbackOriginsForTests } from '@inmolink/platform/safe-fetch';
import { signStripePayload } from '../stripe';

/**
 * A fake Stripe API (S13-01 tests; the real test-mode account waits on H3): customers, Checkout and portal sessions,
 * products and prices (`POST /v1/prices/:id` retires one: S13-F18), subscriptions (with discounts: `DELETE …/discount`) and invoices — enough state for the webhook job to re-read. Every call is recorded
 * (method, path, decoded form fields, idempotency key). Idempotency keys replay the first answer, like Stripe.
 * `completeCheckout`, `updateSubscription` and `upsertInvoice` play Stripe's side; `event` signs a webhook body.
 */

export interface StripeCall {
  method: string;
  path: string;
  fields: Record<string, string>;
  idempotencyKey: string | null;
}

type Obj = Record<string, unknown>;

export interface FakeStripe {
  origin: string;
  secretKey: string;
  webhookSecret: string;
  calls: StripeCall[];
  customers: Map<string, Obj>;
  sessions: Map<string, Obj>;
  coupons: Map<string, Obj>;
  subscriptions: Map<string, Obj>;
  invoices: Map<string, Obj>;
  prices: Map<string, Obj>;
  /** Stripe completes a Checkout: an active subscription with the session's line items. */
  completeCheckout(sessionId: string, opts: { paymentMethod: 'card' | 'sepa_debit'; periodEnd: number }): Obj;
  updateSubscription(id: string, patch: Obj): Obj;
  upsertInvoice(invoice: Obj): Obj;
  /** A signed webhook delivery of `type` about `object` (a fresh event id unless `id` is given). */
  event(type: string, object: Obj, opts?: { id?: string; signedAtMs?: number }): { body: Buffer; signature: string };
  failNext(status: number): void;
  close(): Promise<void>;
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const calls: StripeCall[] = [];
  const customers = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const coupons = new Map<string, Obj>();
  const subscriptions = new Map<string, Obj>();
  const invoices = new Map<string, Obj>();
  const products = new Map<string, Obj>();
  const prices = new Map<string, Obj>();
  const replays = new Map<string, { status: number; body: unknown }>();
  const failures: number[] = [];
  const secretKey = 'sk_test_fake0123456789abcdef';
  const webhookSecret = 'whsec_fake0123456789abcdefABCDEF';
  let seq = 1_000;
  // Unique across runs: the test database keeps earlier runs' Stripe ids (unique columns).
  const tag = randomBytes(6).toString('hex');
  const id = (prefix: string) => `${prefix}_${tag}${(seq++).toString(36)}`;

  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const missing = (res: ServerResponse) =>
    answer(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } });

  /** `line_items[0][price]=…` → `{ line_items: [{ price: … }] }` (enough of Stripe's decoding for these calls). */
  const decode = (fields: Record<string, string>): Obj => {
    const out: Obj = {};
    for (const [key, value] of Object.entries(fields)) {
      const path = key.split(/\[|\]\[|\]/).filter(Boolean);
      let node: Obj = out;
      path.forEach((part, i) => {
        if (i === path.length - 1) {
          node[part] = value;
        } else {
          node[part] ??= /^\d+$/.test(path[i + 1] as string) ? [] : {};
          node = node[part] as Obj;
        }
      });
    }
    return out;
  };

  const expandSubscription = (sub: Obj, expand: readonly string[]): Obj => {
    const pm = sub.default_payment_method as Obj | null;
    const discounts = (sub.discounts ?? []) as Obj[];
    return {
      ...sub,
      default_payment_method: pm ? (expand.includes('default_payment_method') ? pm : pm.id) : null,
      // S13-F23: ids unless expanded (like Stripe); the older single `discount` is the first one.
      discounts: expand.includes('discounts') ? discounts : discounts.map((d) => d.id),
      discount: discounts[0] ?? null,
    };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const fields: Record<string, string> = Object.fromEntries(url.searchParams);
      if (req.method === 'POST')
        Object.assign(fields, Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;
      calls.push({ method: req.method ?? 'GET', path: url.pathname, fields, idempotencyKey });
      if (req.headers.authorization !== `Bearer ${secretKey}`) {
        return answer(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
      }
      const failure = failures.shift();
      if (failure) return answer(res, failure, { error: { type: 'api_error', message: 'Fake failure' } });
      const replayKey = idempotencyKey ? `${url.pathname}:${idempotencyKey}` : null;
      const replay = replayKey ? replays.get(replayKey) : undefined;
      if (replay) return answer(res, replay.status, replay.body);
      const send = (status: number, body: unknown) => {
        if (replayKey) replays.set(replayKey, { status, body });
        answer(res, status, body);
      };
      const params = decode(fields);
      const p = url.pathname;

      if (req.method === 'POST' && p === '/v1/customers') {
        const c = { id: id('cus'), object: 'customer', metadata: params.metadata ?? {} };
        customers.set(c.id, c);
        return send(200, c);
      }
      if (req.method === 'POST' && p === '/v1/checkout/sessions') {
        if (!customers.has(String(params.customer))) return missing(res);
        // S13-F18: like Stripe, an inactive (retired) price cannot start a new Checkout.
        const lineItems = (params.line_items ?? []) as { price?: string }[];
        if (lineItems.some((li) => prices.get(String(li.price))?.active === false)) {
          return answer(res, 400, {
            error: { type: 'invalid_request_error', code: 'price_inactive', message: 'The price is not active' },
          });
        }
        const s = { id: id('cs'), object: 'checkout.session', ...params, status: 'open', subscription: null };
        (s as Obj).url = `https://checkout.stripe.test/c/pay/${s.id}`;
        sessions.set(s.id, s);
        return send(200, s);
      }
      if (req.method === 'POST' && p === '/v1/billing_portal/sessions') {
        if (!customers.has(String(params.customer))) return missing(res);
        return send(200, {
          id: id('bps'),
          object: 'billing_portal.session',
          url: `https://billing.stripe.test/p/${seq}`,
        });
      }
      if (req.method === 'POST' && p === '/v1/coupons') {
        const c = { object: 'coupon', ...params, amount_off: Number(params.amount_off) };
        coupons.set(String(params.id), c);
        return send(200, c);
      }
      if (req.method === 'POST' && p === '/v1/products') {
        const prod = { id: id('prod'), object: 'product', ...params };
        products.set(prod.id, prod);
        return send(200, prod);
      }
      if (req.method === 'POST' && p === '/v1/prices') {
        const price = {
          id: id('price'),
          object: 'price',
          product: params.product,
          unit_amount: Number(params.unit_amount),
          currency: params.currency,
          recurring: params.recurring,
          tax_behavior: params.tax_behavior,
          metadata: params.metadata,
          active: true,
        };
        prices.set(price.id, price);
        return send(200, price);
      }
      // S13-F18: updates a price; billing only ever sends `active=false` (retiring it).
      const updatePrice = req.method === 'POST' ? /^\/v1\/prices\/([^/]+)$/.exec(p) : null;
      if (updatePrice) {
        const price = prices.get(decodeURIComponent(updatePrice[1] as string));
        if (!price) return missing(res);
        if (params.active !== undefined) price.active = params.active === 'true';
        return send(200, price);
      }
      if (req.method === 'GET' && p === '/v1/subscriptions') {
        const data = [...subscriptions.values()].filter((x) => x.customer === fields.customer);
        return send(200, { object: 'list', data, has_more: false });
      }
      if (req.method === 'GET' && p === '/v1/checkout/sessions') {
        const data = [...sessions.values()].filter((x) => x.customer === fields.customer && x.status === fields.status);
        return send(200, { object: 'list', data, has_more: false });
      }
      const expire = req.method === 'POST' ? /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(p) : null;
      if (expire) {
        const s = sessions.get(decodeURIComponent(expire[1] as string));
        if (!s) return missing(res);
        s.status = 'expired';
        return send(200, s);
      }
      const read = (pattern: RegExp, store: Map<string, Obj>) => {
        const m = req.method === 'GET' ? pattern.exec(p) : null;
        return m ? (store.get(decodeURIComponent(m[1] as string)) ?? null) : undefined;
      };
      const sub = read(/^\/v1\/subscriptions\/([^/]+)$/, subscriptions);
      if (sub !== undefined) {
        const expand = Object.entries(fields).flatMap(([k, v]) => (/^expand\[\d+\]$/.test(k) ? [v] : []));
        return sub ? send(200, expandSubscription(sub, expand)) : missing(res);
      }
      // S13-F23: removes the subscription's discount; none left is an error, like Stripe.
      const dropDiscount = req.method === 'DELETE' ? /^\/v1\/subscriptions\/([^/]+)\/discount$/.exec(p) : null;
      if (dropDiscount) {
        const s = subscriptions.get(decodeURIComponent(dropDiscount[1] as string));
        if (!s || !((s.discounts ?? []) as Obj[]).length) return missing(res);
        s.discounts = ((s.discounts ?? []) as Obj[]).slice(1);
        return send(200, { object: 'discount', deleted: true });
      }
      for (const [pattern, store] of [
        [/^\/v1\/coupons\/([^/]+)$/, coupons],
        [/^\/v1\/invoices\/([^/]+)$/, invoices],
        [/^\/v1\/checkout\/sessions\/([^/]+)$/, sessions],
      ] as const) {
        const found = read(pattern, store);
        if (found !== undefined) return found ? send(200, found) : missing(res);
      }
      answer(res, 404, { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${p})` } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const undo = allowLoopbackOriginsForTests([origin]);

  return {
    origin,
    secretKey,
    webhookSecret,
    calls,
    customers,
    sessions,
    coupons,
    subscriptions,
    invoices,
    prices,
    completeCheckout(sessionId, opts) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`no session ${sessionId}`);
      const items = ((s.line_items ?? []) as { price: string; quantity: string }[]).map((li) => {
        const price = prices.get(li.price) ?? { id: li.price, currency: 'eur', recurring: { interval: 'year' } };
        return {
          id: id('si'),
          object: 'subscription_item',
          price,
          quantity: Number(li.quantity),
          current_period_end: opts.periodEnd,
        };
      });
      const sub: Obj = {
        id: id('sub'),
        object: 'subscription',
        customer: s.customer,
        status: 'active',
        cancel_at: null,
        cancel_at_period_end: false,
        items: { object: 'list', data: items },
        metadata: (s.subscription_data as Obj | undefined)?.metadata ?? {},
        default_payment_method: { id: id('pm'), object: 'payment_method', type: opts.paymentMethod },
        // The session's coupons become the subscription's discounts (API 2025-09+ shape: `source.coupon`).
        discounts: ((s.discounts ?? []) as { coupon?: string }[]).flatMap((d) =>
          d.coupon ? [{ id: id('di'), object: 'discount', source: { type: 'coupon', coupon: d.coupon } }] : [],
        ),
      };
      subscriptions.set(sub.id as string, sub);
      s.subscription = sub.id;
      s.status = 'complete';
      return sub;
    },
    updateSubscription(subId, patch) {
      const sub = subscriptions.get(subId);
      if (!sub) throw new Error(`no subscription ${subId}`);
      Object.assign(sub, patch);
      return sub;
    },
    upsertInvoice(invoice) {
      const inv: Obj = { object: 'invoice', ...invoice };
      invoices.set(inv.id as string, inv);
      return inv;
    },
    event(type, object, opts = {}) {
      const body = JSON.stringify({
        id: opts.id ?? id('evt'),
        object: 'event',
        type,
        created: Math.floor(Date.now() / 1000),
        data: { object },
      });
      return {
        body: Buffer.from(body),
        signature: signStripePayload(body, webhookSecret, opts.signedAtMs ?? Date.now()),
      };
    },
    failNext(status) {
      failures.push(status);
    },
    async close() {
      undo();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
