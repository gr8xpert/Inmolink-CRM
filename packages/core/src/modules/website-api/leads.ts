/**
 * Website lead intake (S7-05, PLAN §3 #12 #60, §9.1): `POST /v2/leads` and `POST /v2/viewing-requests` as feed-api
 * routes call them. The lead belongs to the key's site's agency — the presenting agency — also for another agency's
 * network listing; it is written with its `websites.lead.received` event by one statement in a `withIntake`
 * transaction (the only write path of feed-api, `app_intake`), and the visitor's acknowledgement and the agency's
 * notification follow in worker jobs (`jobs.ts`): no e-mail, search or HTTP inside the transaction.
 *
 * Steps and statements (feed-api budget ≤ 3; site scope and network gate are cached reads):
 * 1. the visitor check: Turnstile (publishable keys always; secret keys forward the token or state `serverVerified`).
 *    A failed check looks the idempotency key up once (a double submit whose token the first request used): found →
 *    the first lead's answer (1 statement), else 403;
 * 2. the reference through the site's inventory (as `/v2/listings/{ref}` resolves it): 1 statement — a reference the
 *    site does not show answers `LISTING_NOT_FOUND` like a withdrawn listing; one of its honeytokens also raises
 *    `WebsiteHoneytokenHit` (a code-style one is first confirmed as no real code: +1 statement on that 404 only) and
 *    creates no lead and no e-mail;
 * 3. the lead and its event: 1 statement (`insert … on conflict do nothing` feeding the outbox insert);
 * 4. only when the key was taken: 1 replay lookup — same body → the first lead again (`replayed`), another body →
 *    `IDEMPOTENCY_KEY_REUSED` (422).
 * New lead: 2 statements (1 without a reference); replay: 3; unknown reference: 1.
 *
 * Nothing about the visitor is logged (name, e-mail, phone, message, IP): log lines carry the site, key and request.
 */
import {
  WEBSITE_LEAD_TURNSTILE_ACTION,
  type WebsiteLeadAccepted,
  type WebsiteLeadBody,
  type WebsiteViewingRequestBody,
} from '@inmolink/contracts';
import { withIntake } from '@inmolink/db';
import { hmacSha256 } from '@inmolink/platform/crypto';
import { AppError, isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import * as search from '../search';
import * as websites from '../websites';
import { type ApiSite, langOf, listingNotFound } from './service';
import { leadSecret, turnstileVerifier } from './settings';

/** The Turnstile widget action website forms render with (`data-action`): a token solved for another form is refused. */
export const LEAD_TURNSTILE_ACTION = WEBSITE_LEAD_TURNSTILE_ACTION;

export type LeadKind = 'ENQUIRY' | 'VIEWING_REQUEST';

/** Who posted, as `requireApiKey` authenticated it. Never logged. */
export interface LeadRequestFacts {
  keyKind: 'SECRET' | 'PUBLISHABLE';
  /** The posting key's rate tier: the site's daily acknowledgement cap follows it. */
  keyTier: 'STANDARD' | 'HIGH';
  /** The `Origin` header (publishable keys: on the key's allowlist): Turnstile tokens must be solved on its host. */
  origin?: string;
  /** The client IP (Turnstile `remoteip`); for secret keys the site server's, so not sent. */
  ip?: string;
  idempotencyKey: string;
}

export type LeadInput =
  | { kind: 'ENQUIRY'; body: WebsiteLeadBody }
  | { kind: 'VIEWING_REQUEST'; body: WebsiteViewingRequestBody };

/** The body as the idempotency check compares it: the visitor check is not part of the submission. */
export function requestHashOf(kind: LeadKind, body: WebsiteLeadBody | WebsiteViewingRequestBody): string {
  const { turnstileToken: _token, serverVerified: _verified, ...submission } = body;
  const canonical = JSON.stringify({ kind, ...submission }, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
  return hmacSha256(leadSecret(), 'website-api.lead-body', canonical);
}

/** The client's key is never stored: an HMAC of it, per site. */
const idempotencyHashOf = (siteId: string, key: string) =>
  hmacSha256(leadSecret(), 'website-api.lead-idempotency', `${siteId}:${key}`);

/** Gmail ignores dots in the local part, and googlemail.com is the same mailbox. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The mailbox an address reaches, for the per-recipient caps only (S7-05 review: aliases must not multiply the caps):
 * lowercased and trimmed, `+tag` dropped from the local part, Gmail dots removed and googlemail.com → gmail.com. The
 * acknowledgement still goes to the address as given.
 */
export function canonicalRecipient(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/** The recipient of the acknowledgement, without the address: HMAC of the canonical mailbox (limits per recipient). */
export const recipientHashOf = (email: string) =>
  hmacSha256(leadSecret(), 'website-api.lead-recipient', canonicalRecipient(email));

export function accepted(receipt: websites.LeadReceipt, replayed: boolean): WebsiteLeadAccepted {
  return { id: receipt.id, kind: receipt.kind, status: 'RECEIVED', replayed };
}

/** A first submission, or the same one again; another body under the same key is refused. */
export function replayOf(
  receipt: websites.LeadReceipt | null,
  kind: LeadKind,
  requestHash: string,
): WebsiteLeadAccepted {
  if (!receipt || receipt.kind !== kind || receipt.requestHash !== requestHash) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED');
  }
  return accepted(receipt, true);
}

/** Host of an `Origin` header value, or undefined when it is not a URL. */
function hostOf(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The visitor check (step 1). Publishable keys (a browser form): a Turnstile token solved for `website-lead` on the
 * page's host. Secret keys (the site's server): the visitor's token when forwarded — solved on one of the site's
 * domains when it lists any — else the server's own statement (`serverVerified`, recorded as `SERVER_KEY`). Fails
 * closed: no verifier configured, or Turnstile unreachable.
 */
async function verifyVisitor(
  site: ApiSite,
  body: WebsiteLeadBody | WebsiteViewingRequestBody,
  facts: LeadRequestFacts,
): Promise<websites.LeadVerification> {
  const publishable = facts.keyKind === 'PUBLISHABLE';
  if (publishable && body.serverVerified) {
    throw new AppError('VALIDATION_FAILED', { field: 'serverVerified', reason: 'secret keys only' });
  }
  if (body.turnstileToken === undefined) {
    if (!publishable && body.serverVerified) return 'SERVER_KEY';
    throw new AppError('TURNSTILE_FAILED');
  }
  const verifier = turnstileVerifier();
  if (!verifier) throw new AppError('TURNSTILE_FAILED', { reason: 'not configured' });
  const host = hostOf(facts.origin);
  if (publishable && !host) throw new AppError('TURNSTILE_FAILED');
  const hostnames = publishable ? [host as string] : site.scope.domains.length > 0 ? site.scope.domains : undefined;
  const ok = await verifier.verify(body.turnstileToken, {
    action: LEAD_TURNSTILE_ACTION,
    ...(publishable && facts.ip ? { remoteIp: facts.ip } : {}),
    ...(hostnames ? { hostnames } : {}),
  });
  if (!ok) throw new AppError('TURNSTILE_FAILED');
  return 'TURNSTILE';
}

/**
 * Step 2: the listing or unit the visitor names, through the site's inventory (one statement), as the site shows it.
 * Not on the site (withdrawn, another site's, a guess, a honeytoken): `LISTING_NOT_FOUND`.
 */
async function targetOf(
  site: ApiSite,
  ref: string,
  lang: string,
): Promise<NonNullable<websites.InboundLead['target']>> {
  const inventory = site.inventory;
  return search.withSiteRead(inventory, async (tx) => {
    const row = inventory ? await search.publicDetailByRef(tx, inventory, ref, lang, site.scope.defaultLocale) : null;
    if (!row) throw await listingNotFound(tx, site, ref);
    const doc = row.doc as { kind: 'LISTING' | 'UNIT'; ref: string };
    const own = row.ownerAgencyId === site.scope.agencyId;
    return {
      kind: doc.kind,
      id: row.targetId,
      ownerAgencyId: own ? null : row.ownerAgencyId,
      shownRef: websites.siteRef(
        { agencyId: site.scope.agencyId, referencePrefix: site.scope.referencePrefix },
        { targetId: row.targetId, ownerAgencyId: row.ownerAgencyId, ref: doc.ref, publicCode: row.publicCode },
      ),
    };
  });
}

/**
 * `POST /v2/leads` / `POST /v2/viewing-requests`: records the visitor's enquiry or viewing request for the site's
 * agency. `created: false` answers a repeated submission (same key and body) with the first lead.
 */
export async function submitLead(
  site: ApiSite,
  input: LeadInput,
  facts: LeadRequestFacts,
): Promise<{ accepted: WebsiteLeadAccepted; created: boolean }> {
  const { kind, body } = input;
  const lang = langOf(site, body.lang);
  const siteId = site.scope.siteId;
  const agencyId = site.scope.agencyId;
  const requestHash = requestHashOf(kind, body);
  const idempotencyHash = idempotencyHashOf(siteId, facts.idempotencyKey);
  const replay = () => withIntake({ agencyId }, (tx) => websites.leadByIdempotency(tx, siteId, idempotencyHash));

  // 1. The visitor check. A double submit reuses the first request's (single-use) token: answer it as a replay.
  let verification: websites.LeadVerification;
  try {
    verification = await verifyVisitor(site, body, facts);
  } catch (err) {
    if (!isAppError(err) || err.code !== 'TURNSTILE_FAILED') throw err;
    const earlier = await replay();
    if (!earlier) throw err;
    return { accepted: replayOf(earlier, kind, requestHash), created: false };
  }

  // 2. The listing as the site shows it (never inside the write transaction).
  const target = body.ref === undefined ? null : await targetOf(site, body.ref, lang);

  // 3. The lead and its event, in one statement; 4. the replay lookup only when the key was taken.
  const { receipt, created } = await withIntake({ agencyId }, (tx) =>
    websites.recordInboundLead(tx, {
      id: newId(),
      agencyId,
      siteId,
      kind,
      idempotencyHash,
      requestHash,
      verification,
      target,
      locale: lang,
      name: body.name,
      email: body.email,
      emailHash: recipientHashOf(body.email),
      keyTier: facts.keyTier,
      phone: body.phone ?? null,
      message: body.message ?? null,
      viewingSlots: kind === 'VIEWING_REQUEST' ? (input.body as WebsiteViewingRequestBody).slots : null,
      marketingConsent: body.marketingConsent,
      pageUrl: body.pageUrl ?? null,
    }),
  );
  if (!created) return { accepted: replayOf(receipt, kind, requestHash), created: false };
  return { accepted: accepted(receipt as websites.LeadReceipt, false), created: true };
}
