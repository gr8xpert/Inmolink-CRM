import type { Logger } from '../logger';

/**
 * Cloudflare Turnstile server-side check (S1-F5). The browser widget yields a single-use token (valid
 * 5 minutes, ≤ 2048 chars); `verify` asks Siteverify whether it was solved for this widget `action`
 * (and, when `hostnames` is set, on one of our hosts). Fails closed: a timeout, a non-200 or an
 * unexpected body counts as "not verified". The secret and the token are never logged.
 */
export interface TurnstileVerifier {
  /**
   * `hostnames` (S7-05) replaces the configured hosts for this call — e.g. a website form's page origin, so a token
   * solved on another site is refused.
   */
  verify(
    token: string,
    options: { action: string; remoteIp?: string; hostnames?: readonly string[] },
  ): Promise<boolean>;
}

export interface TurnstileOptions {
  secretKey: string;
  /** Hosts the widget may be solved on; a token from any other page with the same site key is refused. */
  hostnames?: readonly string[];
  logger?: Logger;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  endpoint?: string;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2_048;

interface SiteverifyBody {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  'error-codes'?: unknown;
}

export function createTurnstileVerifier(options: TurnstileOptions): TurnstileVerifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async verify(token, { action, remoteIp, hostnames }) {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
      let body: SiteverifyBody;
      try {
        // No retry: a token validates once, so a retried call could only fail.
        const res = await doFetch(options.endpoint ?? SITEVERIFY, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            secret: options.secretKey,
            response: token,
            ...(remoteIp ? { remoteip: remoteIp } : {}),
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
        if (!res.ok) {
          options.logger?.warn({ status: res.status }, 'turnstile siteverify failed');
          return false;
        }
        body = (await res.json()) as SiteverifyBody;
      } catch (err) {
        options.logger?.warn({ err }, 'turnstile siteverify failed');
        return false;
      }
      // A token solved on another form (another action) or another site is not accepted here.
      const hosts = hostnames ?? options.hostnames;
      const hostOk = hosts === undefined || (typeof body.hostname === 'string' && hosts.includes(body.hostname));
      if (body.success === true && body.action === action && hostOk) return true;
      const codes = Array.isArray(body['error-codes']) ? body['error-codes'].map(String) : [];
      options.logger?.info({ codes, action, hostOk }, 'turnstile token refused');
      return false;
    },
  };
}
