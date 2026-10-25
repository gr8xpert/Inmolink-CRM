import { createHmac, timingSafeEqual } from 'node:crypto';
import { SafeFetchError, type SafeFetchOptions, safeFetch } from '@inmolink/platform/safe-fetch';

/**
 * The Stripe API client of billing (S13-01, PLAN §3 #28). Plain REST over `platform/safe-fetch` (time and size caps);
 * only the calls billing makes, their answers narrowed to what billing stores. Every POST carries an `Idempotency-Key`
 * derived from our ids, so a retried call never creates a second customer, price or session. The secret key travels
 * in the `Authorization` header only and is never logged. Test mode or live is only the key; tests run against a fake
 * Stripe server (`__tests__/fake-stripe.ts`).
 *
 * Errors are `StripeError`s: `retryable` for network failures, 429 and 5xx; Stripe's own message otherwise.
 */

export class StripeError extends Error {
  override readonly name = 'StripeError';
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** Stripe's `error.code` (`resource_missing`, …) when it sent one. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export interface StripeConfig {
  secretKey: string;
  /** `STRIPE_API_URL` (production `https://api.stripe.com`), no trailing slash. */
  apiUrl: string;
  /**
   * `STRIPE_API_VERSION` (`Stripe-Version` header): pins the response shapes billing maps; unset, the account's
   * default version applies (S13-01 review: set it in production).
   */
  apiVersion?: string;
  /** Hosts a Checkout or portal URL may point at (S13-01 security review: never an open redirect). Tests: the fake's. */
  redirectHosts?: readonly string[];
}

/** Stripe's hosted Checkout and Customer Portal. */
export const STRIPE_REDIRECT_HOSTS = ['checkout.stripe.com', 'billing.stripe.com'] as const;

export interface StripeSubscription {
  id: string;
  customerId: string;
  /** Stripe's status as sent (`active`, `past_due`, `incomplete_expired`, …). */
  status: string;
  /** When it ends: `cancel_at`, or the period end when `cancel_at_period_end` is set; null while it renews. */
  cancelAt: Date | null;
  items: {
    priceId: string;
    quantity: number;
    interval: string | null;
    currency: string;
    currentPeriodEnd: Date | null;
  }[];
  metadata: Record<string, string>;
  /** The default payment method's type (`card`, `sepa_debit`), when it is set. */
  paymentMethod: string | null;
  /**
   * S13-F23: the coupons of the discounts applied to the subscription (`discounts[]` expanded, and the older single
   * `discount`), deduplicated. `discountCount` is how many discount objects carry them.
   */
  couponIds: string[];
  discountCount: number;
}

export interface StripeInvoice {
  id: string;
  customerId: string;
  number: string | null;
  status: string;
  currency: string;
  total: number;
  tax: number;
  amountPaid: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  created: Date;
}

export interface StripeCheckoutSession {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
}

export interface CheckoutParams {
  customerId: string;
  agencyId: string;
  planCode: string;
  /** `[{ price, quantity }]`: the plan's price first, then the add-ons'. */
  lineItems: { price: string; quantity: number }[];
  /** SEPA Direct Debit is offered on EUR prices only (Stripe: euro-denominated). */
  paymentMethods: readonly string[];
  successUrl: string;
  cancelUrl: string;
  locale: string;
  idempotencyKey: string;
  /** S13-02: a founding price lock's coupon (amount off the plan's price for a number of months). */
  couponId?: string;
}

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Stripe's default webhook tolerance: a signature older than this is a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

type Params = Record<string, unknown>;

export class StripeClient {
  constructor(
    private readonly config: StripeConfig,
    private readonly fetchOptions: Pick<SafeFetchOptions, 'resolver'> = {},
  ) {}

  /**
   * A customer for the agency (one per agency: the idempotency key is the agency's, so the body must never vary —
   * Stripe refuses a reused key with other parameters; Checkout collects name, address and VAT ID).
   */
  async createCustomer(agencyId: string): Promise<{ id: string }> {
    const res = await this.#request('POST', '/v1/customers', {
      params: { metadata: { agency_id: agencyId } },
      idempotencyKey: `customer:${agencyId}`,
    });
    return { id: str(res.id) };
  }

  /**
   * Whether the customer already pays (a live subscription Stripe has, maybe not yet reported by webhook), after
   * expiring the customer's open Checkout sessions — so two tabs can never both be paid (S13-01 security review).
   */
  async settleOpenCheckouts(customerId: string): Promise<{ live: boolean }> {
    const subs = await this.#request('GET', '/v1/subscriptions', {
      params: { customer: customerId, status: 'all', limit: 20 },
    });
    const live = ((subs.data ?? []) as Record<string, unknown>[]).some((s) =>
      ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(String(s.status)),
    );
    const open = await this.#request('GET', '/v1/checkout/sessions', {
      params: { customer: customerId, status: 'open', limit: 20 },
    });
    for (const s of (open.data ?? []) as Record<string, unknown>[]) {
      if (typeof s.id === 'string')
        await this.#request('POST', `/v1/checkout/sessions/${encodeURIComponent(s.id)}/expire`);
    }
    return { live };
  }

  /**
   * A subscription Checkout session: card (and SEPA Direct Debit on EUR), Stripe Tax on the address Checkout collects,
   * the customer's VAT ID (reverse charge when valid). The agency and plan ride along as metadata of the session and the
   * subscription — only for reading; the webhook job trusts our customer row, never metadata, to find the agency.
   */
  async createCheckoutSession(p: CheckoutParams): Promise<{ id: string; url: string }> {
    const res = await this.#request('POST', '/v1/checkout/sessions', {
      params: {
        mode: 'subscription',
        customer: p.customerId,
        client_reference_id: p.agencyId,
        line_items: p.lineItems,
        payment_method_types: p.paymentMethods,
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' },
        locale: p.locale,
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        metadata: { agency_id: p.agencyId, plan_code: p.planCode },
        subscription_data: { metadata: { agency_id: p.agencyId, plan_code: p.planCode } },
        ...(p.couponId ? { discounts: [{ coupon: p.couponId }] } : {}),
      },
      idempotencyKey: p.idempotencyKey,
    });
    return { id: str(res.id), url: this.#redirectUrl(res.url) };
  }

  /** A Customer Portal session (change plan, payment method, VAT ID, cancel; invoices). */
  async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const res = await this.#request('POST', '/v1/billing_portal/sessions', {
      params: { customer: customerId, return_url: returnUrl },
    });
    return { url: this.#redirectUrl(res.url) };
  }

  /** A Stripe-hosted page the member is sent to: https on Stripe's hosts only. */
  #redirectUrl(v: unknown): string {
    const hosts = this.config.redirectHosts ?? STRIPE_REDIRECT_HOSTS;
    try {
      const u = new URL(str(v));
      if (u.protocol === 'https:' && hosts.includes(u.hostname)) return u.toString();
    } catch {
      // falls through
    }
    throw new StripeError('Stripe answered an unexpected redirect URL', 200, false);
  }

  async getSubscription(id: string): Promise<StripeSubscription | null> {
    const res = await this.#find(`/v1/subscriptions/${encodeURIComponent(id)}`, {
      expand: ['default_payment_method', 'discounts'],
    });
    return res ? toSubscription(res) : null;
  }

  /**
   * S13-F23: removes the discount applied to a subscription (`DELETE /v1/subscriptions/:id/discount`). Idempotent: a
   * subscription without one (already removed by an earlier run) answers false, never an error.
   */
  async removeSubscriptionDiscount(subscriptionId: string): Promise<boolean> {
    const res = await this.#send('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/discount`, {
      missingIsNull: true,
    });
    return res !== null;
  }

  async getInvoice(id: string): Promise<StripeInvoice | null> {
    const res = await this.#find(`/v1/invoices/${encodeURIComponent(id)}`);
    return res ? toInvoice(res) : null;
  }

  async getCheckoutSession(id: string): Promise<StripeCheckoutSession | null> {
    const res = await this.#find(`/v1/checkout/sessions/${encodeURIComponent(id)}`);
    if (!res) return null;
    return { id: str(res.id), customerId: idOf(res.customer), subscriptionId: idOf(res.subscription) };
  }

  /**
   * S13-02: a coupon with our id (a price lock's: `founding_<lock>_<amount>_<months>`), created once — Stripe refuses a
   * second create with the same id, so it is looked up first; the idempotency key covers a retried create.
   */
  async ensureCoupon(p: {
    id: string;
    amountOffCents: number;
    currency: string;
    months: number;
    /** The only product it discounts (the locked plan's): never add-ons or another plan. */
    productId: string;
  }): Promise<string> {
    const found = await this.#find(`/v1/coupons/${encodeURIComponent(p.id)}`);
    if (found) return str(found.id);
    const res = await this.#request('POST', '/v1/coupons', {
      params: {
        id: p.id,
        amount_off: p.amountOffCents,
        currency: p.currency.toLowerCase(),
        duration: 'repeating',
        duration_in_months: p.months,
        applies_to: { products: [p.productId] },
        name: 'Founding price',
      },
      idempotencyKey: `coupon:${p.id}`,
    });
    return str(res.id);
  }

  /** A product for a catalog item (idempotent on the item's id). */
  async createProduct(itemId: string, code: string): Promise<{ id: string }> {
    const res = await this.#request('POST', '/v1/products', {
      params: { name: code, metadata: { inmolink_item_id: itemId, code } },
      idempotencyKey: `product:${itemId}`,
    });
    return { id: str(res.id) };
  }

  /** A recurring price, VAT exclusive (Stripe Tax adds it), idempotent on our price's id. */
  async createPrice(p: {
    priceId: string;
    productId: string;
    amountCents: number;
    currency: string;
    interval: 'month' | 'year';
  }): Promise<{ id: string }> {
    const res = await this.#request('POST', '/v1/prices', {
      params: {
        product: p.productId,
        unit_amount: p.amountCents,
        currency: p.currency.toLowerCase(),
        recurring: { interval: p.interval },
        tax_behavior: 'exclusive',
        metadata: { inmolink_price_id: p.priceId },
      },
      idempotencyKey: `price:${p.priceId}`,
    });
    return { id: str(res.id) };
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    opts: { params?: Params; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#send(method, path, opts);
    if (!res) throw new StripeError('Stripe object not found', 404, false, 'resource_missing');
    return res;
  }

  /** `#request` for reads where a missing object is an answer (deleted, or another account's id): null. */
  async #find(path: string, params?: Params): Promise<Record<string, unknown> | null> {
    return this.#send('GET', path, { ...(params ? { params } : {}), missingIsNull: true });
  }

  async #send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { params?: Params; idempotencyKey?: string; missingIsNull?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const form = opts.params ? encodeForm(opts.params) : '';
    const url = method === 'GET' && form ? `${this.config.apiUrl}${path}?${form}` : `${this.config.apiUrl}${path}`;
    let status: number;
    let json: Record<string, unknown> | null;
    try {
      const res = await safeFetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.secretKey}`,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
          ...(this.config.apiVersion ? { 'stripe-version': this.config.apiVersion } : {}),
        },
        ...(method === 'POST' ? { body: form } : {}),
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        ...this.fetchOptions,
      });
      status = res.status;
      const text = await res.text();
      try {
        const parsed: unknown = text ? JSON.parse(text) : null;
        json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
    } catch (err) {
      if (err instanceof SafeFetchError && (err.code === 'BLOCKED_DESTINATION' || err.code === 'INVALID_URL')) {
        throw new StripeError('Stripe endpoint refused by safe-fetch', 0, false);
      }
      throw new StripeError('Stripe did not answer', 0, true);
    }
    if (status >= 200 && status < 300 && json) return json;
    const error = (json?.error ?? {}) as { message?: unknown; code?: unknown };
    const code = typeof error.code === 'string' ? error.code : null;
    // `missingIsNull` reads (the webhook job): a deleted or unknown object is an answer, not a failure.
    if (status === 404 && opts.missingIsNull) return null;
    throw new StripeError(
      typeof error.message === 'string' ? error.message.slice(0, 300) : `Stripe answered ${status}`,
      status,
      status === 429 || status >= 500,
      code,
    );
  }
}

/** Stripe's form encoding: nested objects and arrays as `a[b][0][c]=…`. */
export function encodeForm(params: Params): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(`${prefix}[${i}]`, v);
      });
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Params)) walk(prefix ? `${prefix}[${k}]` : k, v);
    } else {
      out.append(prefix, String(value));
    }
  };
  walk('', params);
  return out.toString();
}

/**
 * Checks a webhook's `Stripe-Signature` (`t=…,v1=…[,v1=…]`): HMAC-SHA256 of `t.payload` with the endpoint's signing
 * secret, compared in constant time, and `t` within the tolerance of `nowMs` (replays). Returns the parsed event's
 * envelope, or null when anything is wrong.
 */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number,
): Record<string, unknown> | null {
  if (!header || header.length > 2048) return null;
  let t: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) signatures.push(Buffer.from(v, 'hex'));
  }
  if (t === null || signatures.length === 0) return null;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS) return null;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(payload).digest();
  if (!signatures.some((s) => s.length === expected.length && timingSafeEqual(s, expected))) return null;
  try {
    const event: unknown = JSON.parse(payload.toString('utf8'));
    return event && typeof event === 'object' && !Array.isArray(event) ? (event as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A `Stripe-Signature` header for `payload` (tests and the fake server sign like Stripe does). */
export function signStripePayload(payload: string, secret: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

const str = (v: unknown): string => {
  if (typeof v !== 'string' || !v) throw new StripeError('Stripe answer is missing a field', 200, false);
  return v;
};
const idOf = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
    : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string'
      ? (v as { id: string }).id
      : null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const date = (v: unknown): Date | null => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null);
const text = (v: unknown, max = 500): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

function toSubscription(res: Record<string, unknown>): StripeSubscription {
  const items = ((res.items as { data?: unknown } | undefined)?.data ?? []) as Record<string, unknown>[];
  const periodEnd = (item: Record<string, unknown>) => date(item.current_period_end) ?? date(res.current_period_end);
  const mapped = items.flatMap((item) => {
    const price = (item.price ?? {}) as Record<string, unknown>;
    const priceId = idOf(price) ?? idOf(item.price);
    if (!priceId) return [];
    return [
      {
        priceId,
        quantity: Math.max(1, num(item.quantity) || 1),
        interval: text((price.recurring as Record<string, unknown> | undefined)?.interval, 10),
        currency: (text(price.currency, 3) ?? '').toUpperCase(),
        currentPeriodEnd: periodEnd(item),
      },
    ];
  });
  const ends = mapped.map((i) => i.currentPeriodEnd?.getTime() ?? 0).filter((t) => t > 0);
  const firstEnd = ends.length ? new Date(Math.min(...ends)) : null;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries((res.metadata ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') metadata[k] = v.slice(0, 200);
  }
  const pm = res.default_payment_method;
  return {
    id: str(res.id),
    customerId: idOf(res.customer) ?? '',
    status: text(res.status, 40) ?? 'incomplete',
    cancelAt: date(res.cancel_at) ?? (res.cancel_at_period_end === true ? firstEnd : null),
    items: mapped,
    metadata,
    paymentMethod: pm && typeof pm === 'object' ? text((pm as Record<string, unknown>).type, 40) : null,
    ...discountsOf(res),
  };
}

/**
 * The coupons of a subscription's discounts: `discounts[]` (expanded objects; an id alone carries no coupon) and the
 * older single `discount`. A discount names its coupon as `source.coupon` (API 2025-09+) or `coupon` (earlier), each an
 * id or an object.
 */
function discountsOf(res: Record<string, unknown>): { couponIds: string[]; discountCount: number } {
  const objects = new Map<string, Record<string, unknown>>();
  const list = Array.isArray(res.discounts) ? (res.discounts as unknown[]) : [];
  for (const d of [...list, res.discount]) {
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>;
      objects.set(typeof o.id === 'string' ? o.id : `#${objects.size}`, o);
    }
  }
  const unexpanded = list.filter((d) => typeof d === 'string' && !objects.has(d)).length;
  const couponIds = new Set<string>();
  for (const o of objects.values()) {
    const coupon = idOf((o.source as Record<string, unknown> | undefined)?.coupon) ?? idOf(o.coupon);
    if (coupon) couponIds.add(coupon.slice(0, 200));
  }
  return { couponIds: [...couponIds], discountCount: objects.size + unexpanded };
}

function toInvoice(res: Record<string, unknown>): StripeInvoice {
  // API 2025-03-31+: `total_taxes[]`; earlier versions: `tax`.
  const taxes = Array.isArray(res.total_taxes)
    ? (res.total_taxes as Record<string, unknown>[]).reduce((sum, t) => sum + num(t.amount), 0)
    : num(res.tax);
  return {
    id: str(res.id),
    customerId: idOf(res.customer) ?? '',
    number: text(res.number, 100),
    status: text(res.status, 40) ?? 'draft',
    currency: (text(res.currency, 3) ?? '').toUpperCase(),
    total: num(res.total),
    tax: taxes,
    amountPaid: num(res.amount_paid),
    hostedUrl: httpsUrl(res.hosted_invoice_url),
    pdfUrl: httpsUrl(res.invoice_pdf),
    created: date(res.created) ?? new Date(0),
  };
}

/** Only https URLs reach the dashboard (an invoice link is rendered as a link). */
function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}
