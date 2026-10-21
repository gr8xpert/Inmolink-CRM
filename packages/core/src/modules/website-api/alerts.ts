/**
 * Website API alerts (S7-04): every alert is a counter Prometheus alerts on (infra/monitoring/rules/website.yml) and a
 * warning log line naming the key, agency and site (never the client IP: the limiter keeps it only HMAC'd).
 */
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { metrics } from '@opentelemetry/api';
import { alertListener, type WebsiteAlert } from './settings';

const meter = metrics.getMeter('@inmolink/core');
const scraping = meter.createCounter('inmolink.website.scraping.detected', {
  description:
    'Website API callers that tripped an extraction threshold (deep paging, paging volume, filter-slicing, detail sync), by action',
});
const honeytokenHits = meter.createCounter('inmolink.website.honeytoken.hits', {
  description: 'Requests for a honeytoken listing (only a full-inventory scrape finds one)',
});
const edgePurgeFailed = meter.createCounter('inmolink.website.edge_purge.failed', {
  description: 'Edge cache purges that failed their last attempt (S7-06): cached answers then live out their TTL',
});
const honeytokensServed = meter.createCounter('inmolink.website.honeytoken.served', {
  description: 'Honeytoken cards placed on deep search pages of suspected scrapers',
});

// Exported from 0 (Prometheus' `increase` cannot see a series' first sample): every label set that can occur.
for (const attrs of [
  { action: 'flagged', scope: 'key', key_kind: 'SECRET' },
  { action: 'throttled', scope: 'key', key_kind: 'SECRET' },
  { action: 'flagged', scope: 'browser', key_kind: 'PUBLISHABLE' },
  { action: 'throttled', scope: 'browser', key_kind: 'PUBLISHABLE' },
  { action: 'observed', scope: 'key', key_kind: 'PUBLISHABLE' },
  // S7-F7: key-wide slicing / sync budgets (both kinds), the agency-wide publishable day.
  { action: 'observed', scope: 'key', key_kind: 'SECRET' },
  { action: 'observed', scope: 'agency', key_kind: 'PUBLISHABLE' },
]) {
  scraping.add(0, attrs);
}
honeytokenHits.add(0);
honeytokensServed.add(0);
edgePurgeFailed.add(0);

let log: Logger | undefined;

export function raiseWebsiteAlert(alert: WebsiteAlert): void {
  log ??= createLogger({ service: 'website-api' });
  if (alert.kind === 'scraping') {
    scraping.add(1, { action: alert.action, scope: alert.scope, key_kind: alert.keyKind });
    log.warn({ alert: 'WebsiteScrapingDetected', ...alert }, 'website API: scripted paging detected');
  } else if (alert.kind === 'edgePurge') {
    edgePurgeFailed.add(1);
    log.warn({ alert: 'WebsiteEdgePurgeFailing', ...alert }, 'website API: edge cache purge failed');
  } else {
    honeytokenHits.add(1);
    log.warn({ alert: 'WebsiteHoneytokenHit', ...alert }, 'website API: honeytoken listing requested');
  }
  alertListener()?.(alert);
}

export function countHoneytokenServed(): void {
  honeytokensServed.add(1);
}
