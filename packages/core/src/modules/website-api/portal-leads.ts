/**
 * Portal enquiries (S15-02, PLAN §3 #12, §7 M14): the enquiry form on an inmolink.es listing page. A marketplace lead:
 * it belongs to the **listing's owner** — no presenting agency — and reaches its CRM through the website lead intake
 * (S7-05) unchanged: one inbound row with its `websites.lead.received` event in a `withIntake` transaction pinned to the
 * owner (`site_id` null marks the portal), then the CRM promotion (`crm.promoteInboundLead`: source `MARKETPLACE`),
 * and the agency's notification. No automatic reply to the visitor in R1 (`websiteApi.sendLeadAcknowledgement` skips a
 * portal lead: the reply would carry a site's branding).
 *
 * Steps and statements (`PORTAL_LEAD_STATEMENTS`):
 * 1. the visitor check: Turnstile, solved for `website-lead` on the portal's host; fails closed. A failed check is
 *    answered at once — no statement — unless the idempotency key names a lead this intake accepted (remembered on
 *    redis-cache with its owner, `LEAD_KEY_TTL_SECONDS`): a double submit reusing its single-use token, answered with
 *    the first lead (1 statement);
 * 2. the listing its public code names among the portal's stock (listed agencies' PUBLIC listings): 1 statement;
 * 3. the owner's enquiry limit (redis, when the caller passes a limiter);
 * 4. the lead and its event: 1 statement (+1 replay lookup when the key was taken).
 * Per-address and per-listing limits (`checkPortalLeadLimits`) are the caller's, before this.
 *
 * The idempotency key is hashed with the listing's code: one key can never reveal another listing's (another
 * agency's) lead. Nothing about the visitor is logged (name, e-mail, phone, message, IP).
 */
import type { WebsiteLeadAccepted, WebsiteLeadBody } from '@inmolink/contracts';
import { PublicCode } from '@inmolink/contracts';
import { withIntake } from '@inmolink/db';
import { cache, cacheKey } from '@inmolink/platform/cache';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import type { RateLimitCheck, RateLimiter } from '@inmolink/platform/rate-limit';
import * as websites from '../websites';
import { accepted, LEAD_TURNSTILE_ACTION, recipientHashOf, replayOf, requestHashOf } from './leads';
import { portalListingTarget } from './portal';
import { configured, leadSecret, turnstileVerifier, websiteLimits } from './settings';

/** Statements per answer (the int test's `countQueries` budgets). */
export const PORTAL_LEAD_STATEMENTS = { accepted: 2, replayedToken: 1, refused: 0 } as const;

/** How long an accepted key is remembered for a double submit (the intake's replay window). */
const LEAD_KEY_TTL_SECONDS = websites.LEAD_IDEMPOTENCY_HOURS * 3_600;

/** Enquiries per listing and per listing agency, per day (on top of the per-address limits). */
export const PORTAL_LEAD_LIMITS = { perListingDay: 30, perOwnerDay: 300 } as const;

/**
 * The portal's idempotency key hash: per listing code (no cross-listing "key exists" answer), apart from every
 * site's (`website-api.lead-idempotency`).
 */
const portalIdempotencyHashOf = (code: string, key: string) =>
  hmacSha256(leadSecret(), 'website-api.portal-lead-idempotency', `${code}:${key}`);

const acceptedKey = (idempotencyHash: string) =>
  cacheKey({ v: 1, module: 'website-api', entity: 'portal-lead-key', scope: 'global', id: idempotencyHash });

/** The owner of the lead an idempotency key was accepted for, or null (never, expired, or redis-cache is out). */
async function acceptedOwner(idempotencyHash: string): Promise<string | null> {
  try {
    const [owner] = await cache.peekMany([acceptedKey(idempotencyHash)]);
    return typeof owner === 'string' ? owner : null;
  } catch {
    return null;
  }
}

async function rememberAccepted(idempotencyHash: string, ownerAgencyId: string): Promise<void> {
  try {
    await cache.set(acceptedKey(idempotencyHash), ownerAgencyId, { ttlSeconds: LEAD_KEY_TTL_SECONDS });
  } catch {
    // Best effort: without it a double submit's second post is refused (Turnstile) instead of replayed.
  }
}

/** The portal's host (Turnstile tokens must be solved on it), or undefined when no portal origin is configured. */
function portalHost(): string | undefined {
  const origin = configured().portalOrigin;
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

const DAY_SECONDS = 86_400;

/**
 * Enquiry posts per client address (the website forms' per-browser limits, S7-04) and, with `code`, per listing — a
 * person sends a few; a flood (from many addresses at one listing too) is cut off before any statement. Two Redis round
 * trips at most; the limiter fails open (like the website API's).
 */
export async function checkPortalLeadLimits(
  limiter: RateLimiter,
  facts: { ip: string; code?: string },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const l = websiteLimits();
  const checks: RateLimitCheck[] = [
    {
      rule: { name: 'portal.leads', scope: 'ip', limit: l.leadsPerBrowser, windowSeconds: l.leadWindowSeconds },
      identity: facts.ip,
    },
    {
      rule: {
        name: 'portal.leads.day',
        scope: 'ip',
        limit: l.leadsPerBrowserDay,
        windowSeconds: DAY_SECONDS,
        fixedWindow: true,
      },
      identity: facts.ip,
    },
  ];
  const results = await limiter.consumeMany(checks, { slot: facts.ip });
  // Per listing, whoever posts: its own call (a call's keys share one slot — the address's would make it per address).
  const code = facts.code?.toUpperCase();
  if (code && PublicCode.safeParse(code).success && results.every((r) => r.allowed)) {
    const listing: RateLimitCheck = {
      rule: {
        name: 'portal.leads.listing',
        scope: 'key',
        limit: PORTAL_LEAD_LIMITS.perListingDay,
        windowSeconds: DAY_SECONDS,
        fixedWindow: true,
      },
      identity: code,
    };
    results.push(...(await limiter.consumeMany([listing], { slot: code })));
  }
  const denied = results.filter((r) => !r.allowed);
  return { allowed: denied.length === 0, retryAfterSeconds: Math.max(0, ...denied.map((r) => r.retryAfterSeconds)) };
}

export interface PortalLeadInput {
  /** The listing page's locale (the CRM lead's language). */
  locale: string;
  /** The listing's public code (any case), from the page the form is on. */
  code: string;
  /** The form's fields through the website lead contract (`ref` unused: the code names the listing). */
  body: WebsiteLeadBody;
}

/**
 * Records a visitor's enquiry about a portal listing for the listing's owner. `created: false` answers a repeated
 * submission (same idempotency key and body) with the first lead; another body under the key is
 * `IDEMPOTENCY_KEY_REUSED`. A code that names no listing the portal shows: `LISTING_NOT_FOUND`. With `limiter`, the
 * listing agency's daily enquiry limit applies (`RATE_LIMITED`).
 */
export async function submitPortalLead(
  input: PortalLeadInput,
  facts: { ip?: string; idempotencyKey: string; limiter?: RateLimiter },
): Promise<{ accepted: WebsiteLeadAccepted; created: boolean; ownerAgencyId: string }> {
  const code = input.code.toUpperCase();
  if (!PublicCode.safeParse(code).success) throw new AppError('LISTING_NOT_FOUND');
  const { turnstileToken: _t, serverVerified: _s, ref: _r, ...rest } = input.body;
  const body = { ...rest, ref: code } as WebsiteLeadBody;
  const requestHash = requestHashOf('ENQUIRY', body);
  const idempotencyHash = portalIdempotencyHashOf(code, facts.idempotencyKey);

  // 1. The visitor check, before any statement. A failed check is final, except a double submit of an accepted key.
  try {
    await verifyPortalVisitor(input.body.turnstileToken, facts.ip);
  } catch (err) {
    if (!isAppError(err) || err.code !== 'TURNSTILE_FAILED') throw err;
    const owner = await acceptedOwner(idempotencyHash);
    if (!owner) throw err;
    const earlier = await withIntake({ agencyId: owner }, (tx) =>
      websites.leadByIdempotency(tx, null, idempotencyHash),
    );
    if (!earlier) throw err;
    return { accepted: replayOf(earlier, 'ENQUIRY', requestHash), created: false, ownerAgencyId: owner };
  }

  // 2. The listing among the portal's stock (never inside the write transaction): its owner holds the lead.
  const target = await portalListingTarget(code, input.locale, newId());
  if (!target) throw new AppError('LISTING_NOT_FOUND');
  const agencyId = target.ownerAgencyId;

  // 3. The listing agency's daily enquiries (many addresses at many of its listings).
  if (facts.limiter) {
    const [owner] = await facts.limiter.consumeMany(
      [
        {
          rule: {
            name: 'portal.leads.owner',
            scope: 'tenant',
            limit: PORTAL_LEAD_LIMITS.perOwnerDay,
            windowSeconds: DAY_SECONDS,
            fixedWindow: true,
          },
          identity: agencyId,
        },
      ],
      { slot: agencyId },
    );
    if (owner && !owner.allowed) throw new AppError('RATE_LIMITED');
  }

  // 4. The lead and its event in one statement; the replay lookup only when the key was taken.
  const { receipt, created } = await withIntake({ agencyId }, (tx) =>
    websites.recordInboundLead(tx, {
      id: newId(),
      agencyId,
      siteId: null,
      kind: 'ENQUIRY',
      idempotencyHash,
      requestHash,
      verification: 'TURNSTILE',
      // The owner's own listing: no introduced agency; the owner's own reference.
      target: { kind: 'LISTING', id: target.targetId, ownerAgencyId: null, shownRef: target.ref },
      locale: input.locale,
      name: body.name,
      email: body.email,
      emailHash: recipientHashOf(body.email),
      keyTier: 'STANDARD',
      phone: body.phone ?? null,
      message: body.message ?? null,
      viewingSlots: null,
      marketingConsent: body.marketingConsent,
      pageUrl: body.pageUrl ?? null,
    }),
  );
  if (!created) return { accepted: replayOf(receipt, 'ENQUIRY', requestHash), created: false, ownerAgencyId: agencyId };
  await rememberAccepted(idempotencyHash, agencyId);
  return { accepted: accepted(receipt as websites.LeadReceipt, false), created: true, ownerAgencyId: agencyId };
}

/** A Turnstile token solved for `website-lead` on the portal's host. Fails closed (no verifier, no portal origin). */
async function verifyPortalVisitor(token: string | undefined, ip: string | undefined): Promise<void> {
  if (token === undefined) throw new AppError('TURNSTILE_FAILED');
  const verifier = turnstileVerifier();
  const host = portalHost();
  if (!verifier || !host) throw new AppError('TURNSTILE_FAILED', { reason: 'not configured' });
  const ok = await verifier.verify(token, {
    action: LEAD_TURNSTILE_ACTION,
    ...(ip ? { remoteIp: ip } : {}),
    hostnames: [host],
  });
  if (!ok) throw new AppError('TURNSTILE_FAILED');
}
