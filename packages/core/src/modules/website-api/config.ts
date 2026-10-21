/**
 * Website API quotas and anti-scraping thresholds (S7-04, PLAN §9.2 §12). The per-minute rate per key tier and the
 * agency's ceiling over all its keys stay identity's (`API_KEYS`, S1-05); these come on top. Tests narrow them with
 * `configureWebsiteApi({ limits })`. Values and why: STATUS › Decisions (S7-04, after review).
 */
export interface WebsiteLimits {
  /**
   * Requests per key per UTC day, by tier. Secret keys: 429 `QUOTA_EXCEEDED` with the reset time (next UTC midnight).
   * Publishable keys: alert only — enforced per browser (`browserPerDay`), so a few clients cannot use up a site.
   */
  dailyQuota: { STANDARD: number; HIGH: number };
  /** Requests per key per `burstWindowSeconds`, by tier: enforced for secret keys, alert only for publishable keys. */
  burst: { STANDARD: number; HIGH: number };
  burstWindowSeconds: number;
  /**
   * Publishable keys — per browser (the key × the client IP, IPv6 by /64): a page's visitors share the key and its
   * `Origin` can be forged by a server-side script. Sized for an office or carrier-NAT address with many visitors.
   */
  browserPerMinute: number;
  browserBurst: number;
  browserPerDay: number;
  /**
   * A `/v2/listings` cursor chain this deep (signed page depth; page 0 is the first) is a scrape: the caller is flagged
   * (honeytokens, alert). The only flag a secret key gets — never its volume (one server pages for all its visitors).
   */
  deepPage: number;
  /** Pages at or past `deepPage` per key (secret) or browser (publishable) per hour; over it → throttled. */
  deepPerHour: number;
  /** Publishable keys, per browser per `browserPagingWindowSeconds`: paged requests that flag the browser. */
  browserPagingFlag: number;
  /** … and that throttle it (paged requests 429 for `pagingPenaltySeconds`). */
  browserPagingLimit: number;
  browserPagingWindowSeconds: number;
  /** Publishable keys, key-wide paged requests per hour by tier: alert only. */
  pagingPerKeyHour: { STANDARD: number; HIGH: number };
  pagingPenaltySeconds: number;
  /** Honeytokens only on search pages at this depth or deeper (and only for flagged callers). */
  honeytokenMinPage: number;
  /** Honeytokens on (default). Off: no page carries one; detail hits on old ones still alert. */
  honeytokens: boolean;
}

export const DEFAULT_WEBSITE_LIMITS: WebsiteLimits = {
  dailyQuota: { STANDARD: 100_000, HIGH: 1_000_000 },
  burst: { STANDARD: 100, HIGH: 500 },
  burstWindowSeconds: 5,
  browserPerMinute: 300,
  browserBurst: 60,
  browserPerDay: 10_000,
  deepPage: 50,
  deepPerHour: 100,
  browserPagingFlag: 600,
  browserPagingLimit: 1_800,
  browserPagingWindowSeconds: 600,
  pagingPerKeyHour: { STANDARD: 3_000, HIGH: 15_000 },
  pagingPenaltySeconds: 3_600,
  honeytokenMinPage: 10,
  honeytokens: true,
};
