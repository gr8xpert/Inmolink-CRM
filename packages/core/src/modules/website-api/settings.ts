import { hmacSha256 } from '@inmolink/platform/crypto';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { DEFAULT_WEBSITE_LIMITS, type WebsiteLimits } from './config';

/** A website API alert (S7-04): what the metric counts and the log line says (see `alerts.ts`). */
export type WebsiteAlert =
  | {
      kind: 'scraping';
      /** The paging rule that tripped (`feed.paging.*`). */
      rule: string;
      /** `flagged`: suspected scraper (honeytokens on its deep pages); `throttled`: in the penalty box; `observed`: alert only. */
      action: 'flagged' | 'throttled' | 'observed';
      scope: 'key' | 'browser';
      keyId: string;
      keyKind: 'SECRET' | 'PUBLISHABLE';
      agencyId: string;
      siteId: string | null;
      requestId: string;
    }
  | {
      kind: 'honeytoken';
      /** The honeytoken's reference as the site showed it. */
      ref: string;
      siteId: string;
      agencyId: string;
      keyId: string | null;
      requestId: string;
    }
  | {
      /** S7-06: an edge cache purge failed its last attempt (its tags wait for the next run). */
      kind: 'edgePurge';
      agencyId: string;
      tags: number;
      error: string;
    };

export interface WebsiteApiSettings {
  /** Media CDN base URL (`MEDIA_CDN_URL`): image variant keys are served under it. */
  mediaBaseUrl: string;
  /**
   * `HMAC_KEY`, purpose-separated: signs `/v2/changes` and search cursors (a client cannot forge a position, its age or
   * its depth) and derives each site's honeytoken codes.
   */
  cursorKey: string;
  /** Quotas and anti-scraping thresholds (S7-04); defaults `DEFAULT_WEBSITE_LIMITS`. */
  limits?: Partial<WebsiteLimits>;
  /** Also told every alert (tests); the metric and the log line are always written. */
  onAlert?: (alert: WebsiteAlert) => void;
  /**
   * Cloudflare Turnstile (S7-05): checks website form posts' tokens. Without it (no `TURNSTILE_SECRET_KEY`, H3) forms
   * through publishable keys are refused (`TURNSTILE_FAILED`) — fail closed; secret keys may still post with
   * `serverVerified`.
   */
  turnstile?: TurnstileVerifier | null;
}

let settings: WebsiteApiSettings | undefined;
let secret: Buffer | undefined;
let leadKey: Buffer | undefined;

/** Boot: the media CDN base and the cursor key from config. Every use case refuses to run before it. */
export function configureWebsiteApi(next: WebsiteApiSettings): void {
  if (!next.mediaBaseUrl || !next.cursorKey) throw new Error('website-api: mediaBaseUrl and cursorKey are required');
  settings = { ...next };
  // One Buffer: the HMAC helper caches each purpose's derived subkey per key object (a string re-derives every call).
  secret = Buffer.from(next.cursorKey);
  // S7-05: lead hashes (idempotency key, body, recipient) under their own derived secret, apart from cursors and
  // honeytokens. Rotating HMAC_KEY changes them: replays within the 24 h window then create a second lead.
  leadKey = Buffer.from(hmacSha256(secret, 'website-api.lead-secret', 'v1'), 'base64url');
}

/** `cursorKey` as the Buffer every MAC and honeytoken code is made with. */
export function cursorSecret(): Buffer {
  if (!secret) throw new Error('website-api: configureWebsiteApi() was not called');
  return secret;
}

export function configured(): WebsiteApiSettings {
  if (!settings) throw new Error('website-api: configureWebsiteApi() was not called');
  return settings;
}

/** The secret lead hashes (idempotency, body, recipient) are made with (S7-05). */
export function leadSecret(): Buffer {
  if (!leadKey) throw new Error('website-api: configureWebsiteApi() was not called');
  return leadKey;
}

/** The thresholds in force (defaults until configured). */
export function websiteLimits(): WebsiteLimits {
  return { ...DEFAULT_WEBSITE_LIMITS, ...settings?.limits };
}

export function alertListener(): ((alert: WebsiteAlert) => void) | undefined {
  return settings?.onAlert;
}

/** The Turnstile verifier website forms are checked with, or null when none is configured. */
export function turnstileVerifier(): TurnstileVerifier | null {
  return settings?.turnstile ?? null;
}
