import { clock } from '@inmolink/platform/clock';
import { billingConfig } from './config';
import { verifyStripeSignature } from './stripe';

/**
 * Whether a webhook delivery carries a valid, fresh `Stripe-Signature` for the endpoint's secret (S13-F20). Pure and
 * cheap (one HMAC, no I/O): the route uses it to pick the rate-limit bucket before `receiveStripeWebhook` queues
 * anything, so signed deliveries are counted apart from unsigned junk and a flood of the latter cannot push Stripe's
 * deliveries into 429. False while Stripe is not configured (H3).
 */
export function isSignedStripeDelivery(input: { payload: Buffer; signature: string | undefined }): boolean {
  const secret = billingConfig().stripe?.webhookSecret;
  if (!secret) return false;
  return verifyStripeSignature(input.payload, input.signature, secret, clock.nowMs()) !== null;
}
