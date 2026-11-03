import { clientIpFromForwarded } from '@inmolink/platform/http';
import { createLogger } from '@inmolink/platform/logger';
import { createTurnstileVerifier, type TurnstileVerifier } from '@inmolink/platform/turnstile';
import { webConfig } from './env';

/** The widget's `data-action`; Siteverify must report the same, so a token from another form is refused. */
export const TURNSTILE_SIGNUP_ACTION = 'signup';

let turnstile: TurnstileVerifier | null | undefined;

/** The configured verifier, or null when Turnstile is not set up. */
export async function dashboardTurnstile(): Promise<TurnstileVerifier | null> {
  if (turnstile !== undefined) return turnstile;
  const config = await webConfig();
  turnstile = config.TURNSTILE_SECRET_KEY
    ? createTurnstileVerifier({
        secretKey: config.TURNSTILE_SECRET_KEY,
        // Only tokens solved on the dashboard's own host count.
        hostnames: [new URL(config.WEB_URL).hostname],
        logger: createLogger({ service: 'web', level: config.LOG_LEVEL }),
      })
    : null;
  return turnstile;
}

/**
 * Every signup sends a real email, so with Turnstile set up each attempt needs a solved widget (S17-F10). Without
 * keys only the rate limits apply. An outage at Siteverify refuses the signup (the verifier fails closed).
 */
export async function passesSignupChallenge(
  token: string | undefined,
  forwardedFor: string | null,
  verifier?: TurnstileVerifier | null,
): Promise<boolean> {
  const active = verifier !== undefined ? verifier : await dashboardTurnstile();
  if (!active) return true;
  if (!token) return false;
  const { TRUST_PROXY } = await webConfig();
  return active.verify(token, {
    action: TURNSTILE_SIGNUP_ACTION,
    remoteIp: clientIpFromForwarded(forwardedFor, TRUST_PROXY),
  });
}
