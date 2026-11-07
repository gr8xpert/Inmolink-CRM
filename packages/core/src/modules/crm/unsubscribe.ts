import type { WebsitePresenter } from '@inmolink/contracts';
import { withIntake, withPublicRead, withSystem } from '@inmolink/db';
import { hmacSha256, hmacSha256Candidates, safeEqual } from '@inmolink/platform/crypto';
import { emit } from '@inmolink/platform/outbox';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import * as agencies from '../agencies';
import * as compliance from '../compliance';
import * as websites from '../websites';
import { crmEvents } from './events';
import * as repo from './repo';

/**
 * One-click unsubscribe from marketing e-mails (R2-02g; LSSI art. 21, RFC 8058, the Gmail / Yahoo bulk-sender rules).
 *
 * **The link** `<PUBLIC_PAGES_URL>/u/<token>?l=<lang>`: the token is the agency's and the contact's ids (opaque UUIDs —
 * no name, e-mail or phone) and a 120-bit HMAC over them (`HMAC_KEY`, purpose `crm.unsubscribe-link:marketing`), so it
 * cannot be guessed or altered and names one contact of one agency. Stateless: every alert carries the same link for a
 * contact, it never expires (a client may click an old e-mail years later) and it outlives an `HMAC_KEY` rotation
 * while the previous key verifies; an erased contact's link does nothing. `l` only picks the page's language.
 *
 * **GET** shows a confirm page (link scanners prefetch links: a GET never unsubscribes). **POST** — the page's button,
 * or the mail client's `List-Unsubscribe=One-Click` from its own servers (no cookie, no Origin) — records the request
 * as `app_intake` pinned to the token's agency: the `crm.contact.unsubscribeRequested` event, nothing else. The worker
 * (`crm.applyUnsubscribe`) withdraws `contacts.consent_marketing` with a consent record of source `UNSUBSCRIBE_LINK` —
 * the audit trail — within seconds (RFC 8058 / Gmail allow 48 h). Idempotent: a consent already withdrawn records
 * nothing. A merged contact's link follows to the survivor.
 */

const PURPOSE = 'crm.unsubscribe-link:marketing';
const VERSION = 1;
const MAC_BYTES = 15;
const PAYLOAD_BYTES = 1 + 16 + 16;
/** A token as the link carries it: 48 bytes, base64url. */
export const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9_-]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LANG = /^[a-z]{2}$/;

let current: { tokenKey: Buffer; publicBaseUrl: string | null } | undefined;

/** Boot (the worker's email pool and the public pages): `HMAC_KEY` and the public pages' origin (`PUBLIC_PAGES_URL`). */
export function configureUnsubscribeLinks(options: { tokenKey: string; publicBaseUrl?: string | null }): void {
  if (!options.tokenKey) throw new Error('crm: unsubscribe tokenKey is required');
  const base = options.publicBaseUrl ? options.publicBaseUrl.replace(/\/+$/, '') : null;
  if (base && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base)) {
    throw new Error('crm: unsubscribe publicBaseUrl must be an origin');
  }
  current = { tokenKey: Buffer.from(options.tokenKey), publicBaseUrl: base };
}

function configured() {
  if (!current) throw new Error('crm: configureUnsubscribeLinks() was not called');
  return current;
}

/** Whether alerts can carry an unsubscribe link (the public origin is configured): none goes out without one. */
export const unsubscribeLinksConfigured = (): boolean => !!current?.publicBaseUrl;

const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidOf = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const macOf = (full: string) => Buffer.from(full, 'base64url').subarray(0, MAC_BYTES).toString('base64url');

/** The contact's marketing unsubscribe token (the same for every e-mail to the contact). */
export function unsubscribeToken(agencyId: string, contactId: string): string {
  if (!UUID.test(agencyId) || !UUID.test(contactId)) throw new TypeError('crm: unsubscribe ids must be UUIDs');
  const payload = Buffer.concat([Buffer.from([VERSION]), uuidBytes(agencyId), uuidBytes(contactId)]);
  const mac = Buffer.from(macOf(hmacSha256(configured().tokenKey, PURPOSE, payload)), 'base64url');
  return Buffer.concat([payload, mac]).toString('base64url');
}

/** The agency and contact a token names, or null when it is malformed, forged or altered (constant-time check). */
export function readUnsubscribeToken(token: string): { agencyId: string; contactId: string } | null {
  if (!UNSUBSCRIBE_TOKEN.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== PAYLOAD_BYTES + MAC_BYTES || raw[0] !== VERSION) return null;
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const presented = raw.subarray(PAYLOAD_BYTES).toString('base64url');
  let ok = false;
  // the current key, and the previous one inside a rotation window: links in old e-mails keep working
  for (const full of hmacSha256Candidates(configured().tokenKey, PURPOSE, payload)) {
    ok = safeEqual(macOf(full), presented) || ok;
  }
  if (!ok) return null;
  return { agencyId: uuidOf(payload.subarray(1, 17)), contactId: uuidOf(payload.subarray(17, 33)) };
}

/** The link put in a marketing e-mail (body and `List-Unsubscribe`), or null when the public origin is not set. */
export function unsubscribeUrl(input: { agencyId: string; contactId: string; locale: string }): string | null {
  if (!unsubscribeLinksConfigured()) return null;
  const lang = input.locale.slice(0, 2).toLowerCase();
  const query = LANG.test(lang) ? `?l=${lang}` : '';
  return `${configured().publicBaseUrl}${unsubscribePath(unsubscribeToken(input.agencyId, input.contactId))}${query}`;
}

/** Where the unsubscribe page is served on the public pages host. */
export const unsubscribePath = (token: string): string => `/u/${token}`;

export interface UnsubscribePageModel {
  agencyId: string;
  /** The agency as its clients see it (its public profile's name, contacts, colours); null when it is not listed. */
  presenter: WebsitePresenter | null;
}

/**
 * The confirm page's model (`GET /u/<token>`), read as `app_public`: the agency's public branding only — never a
 * contact's data, never another agency's. Null for an invalid token (the page answers a neutral 404).
 */
export async function unsubscribePage(token: string): Promise<UnsubscribePageModel | null> {
  const target = readUnsubscribeToken(token);
  if (!target) return null;
  const agency = await withPublicRead(
    async (tx) => (await agencies.publicAgencies(tx, [target.agencyId])).get(target.agencyId) ?? null,
  );
  return {
    agencyId: target.agencyId,
    presenter: agency ? websites.sitePresenter({ name: agency.name, contact: null }, agency) : null,
  };
}

/**
 * `POST /u/<token>`: records the client's request (the event; `crm.applyUnsubscribe` withdraws the consent) as
 * `app_intake` pinned to the token's agency. False for an invalid token. Every valid POST records one (the job is
 * idempotent; the page's rate limits bound repeats).
 */
export async function requestUnsubscribe(token: string): Promise<boolean> {
  const target = readUnsubscribeToken(token);
  if (!target) return false;
  await withIntake({ agencyId: target.agencyId }, (tx) =>
    emit(tx, crmEvents.contactUnsubscribeRequested(target), { agencyId: target.agencyId }),
  );
  return true;
}

/**
 * `crm.applyUnsubscribe`: withdraws the contact's marketing consent (the survivor's, if it was merged) with a consent
 * record of source `UNSUBSCRIBE_LINK` at the time the client asked, and `crm.contact.updated`. Idempotent: a consent
 * not given (withdrawn already, or never) records nothing; an erased or unknown contact is a no-op.
 */
export async function applyUnsubscribe(p: {
  agencyId: string;
  contactId: string;
  requestedAt: string;
}): Promise<{ withdrawn: boolean }> {
  const at = new Date(p.requestedAt);
  return withSystem('crm.applyUnsubscribe', async (tx) => {
    const target = await repo.lockUnsubscribeTarget(tx, p.agencyId, p.contactId);
    if (!target?.consentMarketing) return { withdrawn: false };
    const version = await repo.withdrawMarketingConsent(tx, p.agencyId, target.id, at);
    if (version === null) return { withdrawn: false };
    await compliance.recordConsents(tx, p.agencyId, [{ contactId: target.id, purpose: 'MARKETING', granted: false }], {
      source: 'UNSUBSCRIBE_LINK',
      at,
    });
    await emit(tx, crmEvents.contactUpdated({ agencyId: p.agencyId, contactId: target.id, version }), {
      agencyId: p.agencyId,
    });
    return { withdrawn: true };
  });
}

/**
 * Request limits of `/u/<token>`. A **valid** link's POST is limited per link only (`postsPerLinkPerHour`): one-click
 * POSTs come from a few mail-provider servers (and a missing client address shares one bucket), so a per-address limit
 * would turn real unsubscribes into 429s (security review). An **invalid** token's POST and every page view are limited
 * per client address (guessing, scraping). One Redis round trip; the limiter fails open when Redis is down. Keyed by
 * the token's keyed hash, never the token.
 */
export const UNSUBSCRIBE_LIMITS = { viewsPerMinute: 60, invalidPostsPerMinute: 30, postsPerLinkPerHour: 10 } as const;

export async function checkUnsubscribeLimits(
  limiter: RateLimiter,
  facts: { ip: string; post?: { token: string } },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  let check: RateLimitCheck;
  let slot = facts.ip;
  if (facts.post && readUnsubscribeToken(facts.post.token)) {
    slot = hmacSha256(configured().tokenKey, 'crm.unsubscribe-limit', facts.post.token).slice(0, 22);
    check = {
      rule: {
        name: 'unsubscribe.link',
        scope: 'key',
        limit: UNSUBSCRIBE_LIMITS.postsPerLinkPerHour,
        windowSeconds: 3_600,
      },
      identity: slot,
    };
  } else if (facts.post) {
    check = {
      rule: {
        name: 'unsubscribe.invalid',
        scope: 'ip',
        limit: UNSUBSCRIBE_LIMITS.invalidPostsPerMinute,
        windowSeconds: 60,
      },
      identity: facts.ip,
    };
  } else {
    check = {
      rule: { name: 'unsubscribe.page', scope: 'ip', limit: UNSUBSCRIBE_LIMITS.viewsPerMinute, windowSeconds: 60 },
      identity: facts.ip,
    };
  }
  const [result] = await limiter.consumeMany([check], { slot });
  return result && !result.allowed
    ? { allowed: false, retryAfterSeconds: Math.max(0, result.retryAfterSeconds) }
    : { allowed: true, retryAfterSeconds: 0 };
}
