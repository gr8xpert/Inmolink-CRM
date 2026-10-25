import type { SafeFetchOptions } from '@inmolink/platform/safe-fetch';
import { StripeClient, type StripeConfig } from './stripe';

/**
 * Process settings for billing (S13-01), set once at boot (api: Checkout, the Customer Portal, webhook signatures;
 * worker `maintenance` pool: catalog sync and webhook events). Configuration only — never tenant or user state
 * (CLAUDE.md rule 4). Without `stripe` (no Stripe account yet, H3) billing answers `BILLING_NOT_ENABLED`.
 */
export interface BillingConfig {
  stripe?: StripeConfig & {
    /** `STRIPE_WEBHOOK_SECRET` (api): the webhook endpoint's signing secret. */
    webhookSecret?: string;
    /** `BILLING_RETURN_URL` (api): the dashboard's billing page, where Checkout and the portal send the member back. */
    returnUrl?: string;
  };
  /** Tests: options handed to safe-fetch (the fake Stripe server). */
  fetchOptions?: Pick<SafeFetchOptions, 'resolver'>;
  /** S13-02: plan gates and seats are enforced (`BILLING_ENFORCE_PLANS`); off, every agency keeps every feature. */
  enforcePlans?: boolean;
  /** S13-02: the catalog plan a new, non-migrated agency trials, and for how many days (no plan or 0 days: no trial). */
  trial?: { planCode: string; days: number };
  /** S13-02: days a PAST_DUE subscription keeps its plan (`BILLING_DUNNING_GRACE_DAYS`; default 14). */
  dunningGraceDays?: number;
}

let current: BillingConfig = {};

export function configureBilling(config: BillingConfig): void {
  if (config.stripe) {
    for (const k of ['secretKey', 'apiUrl'] as const) {
      if (!config.stripe[k]) throw new Error(`billing: stripe.${k} is required`);
    }
  }
  current = config;
}

export const billingConfig = (): BillingConfig => current;

/** The Stripe client, or null while Stripe is not configured (H3). */
export function stripeClient(): StripeClient | null {
  const s = current.stripe;
  return s
    ? new StripeClient(
        {
          secretKey: s.secretKey,
          apiUrl: s.apiUrl.replace(/\/+$/, ''),
          ...(s.redirectHosts ? { redirectHosts: s.redirectHosts } : {}),
          ...(s.apiVersion ? { apiVersion: s.apiVersion } : {}),
        },
        current.fetchOptions,
      )
    : null;
}

/** Days a past-due subscription keeps its plan when no setting says otherwise (PLAN §11 working assumption). */
const DEFAULT_GRACE_DAYS = 14;

export const dunningGraceMs = (): number => (current.dunningGraceDays ?? DEFAULT_GRACE_DAYS) * 86_400_000;

/** Billing settings from `billingEnv` / `planEnv` values: Stripe only when its secret key is set. */
export function billingFromEnv(env: {
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_WEBHOOK_SECRET?: string | undefined;
  STRIPE_API_URL: string;
  STRIPE_API_VERSION?: string | undefined;
  BILLING_RETURN_URL?: string | undefined;
  BILLING_ENFORCE_PLANS?: 'true' | 'false' | undefined;
  BILLING_TRIAL_PLAN?: string | undefined;
  BILLING_TRIAL_DAYS?: number | undefined;
  BILLING_DUNNING_GRACE_DAYS?: number | undefined;
}): BillingConfig {
  const plans: BillingConfig = {
    enforcePlans: env.BILLING_ENFORCE_PLANS === 'true',
    ...(env.BILLING_TRIAL_PLAN && env.BILLING_TRIAL_DAYS
      ? { trial: { planCode: env.BILLING_TRIAL_PLAN, days: env.BILLING_TRIAL_DAYS } }
      : {}),
    ...(env.BILLING_DUNNING_GRACE_DAYS !== undefined ? { dunningGraceDays: env.BILLING_DUNNING_GRACE_DAYS } : {}),
  };
  if (!env.STRIPE_SECRET_KEY) return plans;
  return {
    ...plans,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      apiUrl: env.STRIPE_API_URL,
      ...(env.STRIPE_API_VERSION ? { apiVersion: env.STRIPE_API_VERSION } : {}),
      ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
      ...(env.BILLING_RETURN_URL ? { returnUrl: env.BILLING_RETURN_URL.replace(/\/+$/, '') } : {}),
    },
  };
}
