import { loadConfig, websitesEnv } from '@inmolink/platform/config';
import type { RateLimitRule } from '@inmolink/platform/rate-limit';

/**
 * Process settings for dashboard sites, set once at boot (api). Configuration only — never tenant or user state
 * (CLAUDE.md rule 4). Read from the environment (`websitesEnv`) when not given.
 */
export interface WebsitesConfig {
  /** `WEBSITE_MIN_COMMISSION_EDITS_PER_DAY` (S12-F25, default 5). */
  minCommissionEditsPerDay?: number;
}

let current: WebsitesConfig | undefined;
let fromEnv: number | undefined;

export function configureWebsites(config: WebsitesConfig): void {
  current = config;
}

/** `WEBSITE_MIN_COMMISSION_EDITS_PER_DAY`, read once. */
function envEditsPerDay(): number {
  fromEnv ??= loadConfig(websitesEnv).WEBSITE_MIN_COMMISSION_EDITS_PER_DAY;
  return fromEnv;
}

/**
 * Minimum-commission edits (S12-F25, S7-F10 security review): a CUSTOM site's minimum commission narrows the network
 * listings it shows, so each edit is a yes/no question about other agencies' commissions. An agency may set or change
 * it `WEBSITE_MIN_COMMISSION_EDITS_PER_DAY` times per sliding day (creates included), across all its sites; past that
 * `RATE_LIMITED` with the seconds to wait. Fails closed: without Redis no edit can be counted, so none is accepted.
 * Known limits: an edit is counted before the write and not refunded if the write then fails; the budget is per
 * agency, so a person running several verified agencies gets several budgets (the audit rows still show every edit).
 */
export function minCommissionEditBudget(): RateLimitRule {
  const limit = current?.minCommissionEditsPerDay ?? envEditsPerDay();
  return {
    name: 'websites.min-commission-edits',
    scope: 'tenant',
    limit,
    windowSeconds: 86_400,
    failClosed: true,
  };
}
