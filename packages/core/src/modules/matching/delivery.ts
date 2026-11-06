import { type Tx, withSystem, withTenant } from '@inmolink/db';
import { CONTENT_LOCALES, DEFAULT_UI_LOCALE, FALLBACK_CONTENT_LOCALE, isUiLocale } from '@inmolink/i18n';
import { translator } from '@inmolink/i18n/server';
import { clock } from '@inmolink/platform/clock';
import { mailer } from '@inmolink/platform/email';
import { newId } from '@inmolink/platform/ids';
import * as crm from '../crm';
import * as identity from '../identity';
import * as presentations from '../presentations';
import * as search from '../search';
import { alertWhatsappUrl, firstNameOf, renderProfileAlert, renderWhatsappHandoff } from './delivery-email';
import * as repo from './repo';

/**
 * AUTO_SEND delivery (R2-02e, PLAN §7 M9, §3 #23): a profile's `QUEUED` matches go to the client as one branded
 * selection — INSTANT a few minutes after the first match (`DELIVERY_LIMITS.instantDebounceMs`: a storm of matches is
 * one e-mail), DAILY / WEEKLY as a digest at the agency's local morning hour. Worker-only (`withSystem`, the offer
 * check under the agency's RLS).
 *
 * Each delivery: the matches re-checked (an own listing no longer offerable is `EXPIRED`, as the review queue does;
 * one not offerable or not public now waits); **never twice** — a listing already `SENT` to the contact through any of
 * its profiles, or in any selection the agency made for the contact (a review draft included), is marked `SENT`
 * without a selection and not sent again; **consent** — marketing consent given and not do-not-contact (a property
 * alert is marketing: `contacts.consent_marketing`), else nothing is sent and the matches stay `QUEUED`; **caps** per
 * agency and per contact a rolling day (`DELIVERY_LIMITS`). Then, in one transaction under the profile's and the
 * contact's locks: a selection for the contact from its agent (`presentations.createAlertSelection`), the matches
 * `SENT` with it, the delivery row (`PENDING`). After the commit (rule 6): the e-mail — the selection's page as the
 * client sees it (`presentations.selectionPage`: white-labelled, the agency's branding), in the client's language — or,
 * for a client without an e-mail but with a phone, the agent's e-mail with the `wa.me` deep link (the agent sends it);
 * then `SENT`. A failed send leaves the delivery `PENDING`: the next run (the job's retry) gives the selection a new
 * link and sends again (the token is never stored). REVIEW profiles' approved matches are sent by the member from the
 * selection (R2-02d), not here.
 */

/** Per-agency / per-contact caps and timings (config, the same for every agency; plans may differentiate later). */
export const DELIVERY_LIMITS = {
  /** INSTANT: the delivery runs this long after the first new match (later ones within it ride along). */
  instantDebounceMs: 5 * 60_000,
  /** Matches in one delivery at most (the best of the newest). */
  matchesPerDelivery: 20,
  /** Client alerts an agency sends a rolling 24 h at most (sender reputation). */
  perAgencyPerDay: 500,
  /** Client alerts one contact gets a rolling 24 h at most (all its profiles). */
  perContactPerDay: 3,
  /** DAILY and WEEKLY digests go at this local hour (the agency's time zone). */
  digestHour: 9,
  /** WEEKLY digests go on this ISO weekday (1 = Monday). */
  weeklyDay: 1,
  /** A delivery whose e-mail failed is retried within this long, then left. */
  pendingRetryMs: 2 * 86_400_000,
  /** Profiles a digest page queues. */
  digestPage: 500,
} as const;

export type DeliveryLimits = { [K in keyof typeof DELIVERY_LIMITS]: number };

export type DeliveryPeriod = 'INSTANT' | `D:${string}` | `W:${string}`;

export type DeliveryOutcome =
  | 'SENT'
  | 'NONE'
  | 'NOT_AUTO_SEND'
  | 'OTHER_FREQUENCY'
  | 'ALREADY_DELIVERED'
  | 'CONTACT_GONE'
  | 'NO_CONSENT'
  | 'NO_CHANNEL'
  | 'CAPPED'
  | 'NO_SENDER'
  | 'NOT_CONFIGURED';

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  /** Matches sent in the new selection. */
  sent: number;
  /** Matches marked SENT without a selection: the client has the listing already. */
  duplicates: number;
  expired: number;
  /** A failed earlier delivery sent again in this run. */
  resent: boolean;
  deliveryId?: string;
  channel?: 'EMAIL' | 'WHATSAPP';
  /** WHATSAPP: the deep link handed to the agent (tests; never log it — it holds the page's token). */
  whatsappUrl?: string;
}

/* ------------------------------------------------------------------ periods (pure) */

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), weekday };
}

/** The ISO week (`2026-W45`) of a calendar date (`YYYY-MM-DD`). */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The digests due now in an agency's time zone: DAILY from `digestHour` local (period `D:<local date>`), WEEKLY from
 * the same hour on `weeklyDay` (`W:<ISO week>`), until the local day ends. Empty before the hour.
 */
export function digestPeriodsDue(
  now: Date,
  timeZone: string,
  limits: Pick<DeliveryLimits, 'digestHour' | 'weeklyDay'> = DELIVERY_LIMITS,
): { frequency: 'DAILY' | 'WEEKLY'; period: DeliveryPeriod }[] {
  const l = localParts(now, timeZone);
  // from the digest hour to the end of the local day: a missed hourly sweep catches up (never twice: period keys)
  if (l.hour < limits.digestHour) return [];
  const due: { frequency: 'DAILY' | 'WEEKLY'; period: DeliveryPeriod }[] = [
    { frequency: 'DAILY', period: `D:${l.date}` },
  ];
  if (l.weekday === limits.weeklyDay) due.push({ frequency: 'WEEKLY', period: `W:${isoWeekOf(l.date)}` });
  return due;
}

const frequencyOf = (period: DeliveryPeriod) =>
  period === 'INSTANT' ? 'INSTANT' : period.startsWith('D:') ? 'DAILY' : 'WEEKLY';

/* ------------------------------------------------------------------ delivery */

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** The client's language for the selection: theirs when it is a content locale, else the fallback content locale. */
function clientLocale(language: string | null): string {
  return language && (CONTENT_LOCALES as readonly string[]).includes(language) ? language : FALLBACK_CONTENT_LOCALE;
}

type Reach = NonNullable<Awaited<ReturnType<typeof crm.lockContactReach>>>;

/** May the client be sent an alert: marketing consent given, not do-not-contact. */
export const mayAlert = (c: Pick<Reach, 'consentMarketing' | 'doNotContact'>): boolean =>
  c.consentMarketing && !c.doNotContact;

/** Where the alert goes: the client's e-mail, else WhatsApp through the agent when the client has a phone. */
export function channelOf(c: Pick<Reach, 'email' | 'phone'>): 'EMAIL' | 'WHATSAPP' | null {
  if (c.email && EMAIL.test(c.email)) return 'EMAIL';
  return c.phone && c.phone.replace(/\D/g, '').length >= 8 ? 'WHATSAPP' : null;
}

/** The member a selection is from: the contact's agent while an active member who works clients, else an admin. */
async function senderOf(tx: Tx, agencyId: string, ownerUserId: string | null): Promise<string | null> {
  if (ownerUserId && (await identity.activeClientMembersAmong(tx, agencyId, [ownerUserId])).has(ownerUserId)) {
    return ownerUserId;
  }
  const [admin] = (await identity.agencyAdminsOf(tx, [agencyId])).get(agencyId) ?? [];
  if (admin) return admin;
  const [member] = await identity.activeClientMemberIds(tx, agencyId, 1);
  return member ?? null;
}

interface Prepared {
  deliveryId: string;
  attempt: number;
  selectionId: string;
  token: string;
  channel: 'EMAIL' | 'WHATSAPP';
  matchCount: number;
  senderUserId: string;
  contact: Reach;
}

/** Sends a prepared delivery (outside any transaction), then marks it `SENT`. Never logs the message or the link. */
async function send(agencyId: string, d: Prepared): Promise<string | undefined> {
  const url = presentations.selectionUrl(d.token);
  if (!url) throw new Error('matching.delivery: PUBLIC_PAGES_URL is not configured');
  const key = `pdel:${d.deliveryId}:${d.attempt}`;
  let whatsappUrl: string | undefined;
  if (d.channel === 'EMAIL') {
    const page = await presentations.selectionPage(d.token);
    const items = page.items.flatMap((i) => (i.detail ? [i.detail] : []));
    // "reply to stop" must reach someone: the agency's address, else the agent's (security review)
    const agencyReply = !!page.presenter.email && EMAIL.test(page.presenter.email);
    const agentReply = agencyReply
      ? null
      : await withSystem('matching.deliverProfile reply-to', (tx) =>
          identity.memberRecipient(tx, agencyId, d.senderUserId),
        );
    if (!agencyReply && !agentReply) throw new Error('matching.delivery: no reply address for the opt-out');
    await mailer().send(
      renderProfileAlert({
        to: d.contact.email as string,
        firstName: firstNameOf(d.contact.firstName),
        locale: page.locale,
        url,
        presenter: page.presenter,
        items,
        idempotencyKey: key,
        ...(agentReply ? { replyTo: agentReply.email } : {}),
      }),
    );
  } else {
    const agent = await withSystem('matching.deliverProfile agent', (tx) =>
      identity.memberRecipient(tx, agencyId, d.senderUserId),
    );
    if (!agent) throw new Error('matching.delivery: the agent is no longer an active member');
    whatsappUrl = alertWhatsappUrl({
      phone: d.contact.phone,
      firstName: firstNameOf(d.contact.firstName),
      locale: clientLocale(d.contact.language),
      url,
    });
    await mailer().send(
      renderWhatsappHandoff({
        to: agent.email,
        locale: agent.locale,
        client: d.contact.firstName ?? '—',
        count: d.matchCount,
        whatsappUrl,
        idempotencyKey: key,
      }),
    );
  }
  await withSystem('matching.deliverProfile sent', (tx) => repo.markDeliverySent(tx, d.deliveryId));
  return whatsappUrl;
}

/**
 * A delivery whose e-mail failed (within `pendingRetryMs`): a new link for its selection and the next attempt —
 * consent re-checked first (a withdrawal since stops it). Null when there is none to send.
 */
async function preparePending(agencyId: string, profileId: string, limits: DeliveryLimits, now: Date) {
  return withSystem('matching.deliverProfile retry', async (tx): Promise<Prepared | null> => {
    const pending = await repo.pendingDeliveryOf(
      tx,
      agencyId,
      profileId,
      new Date(now.getTime() - limits.pendingRetryMs),
    );
    if (!pending) return null;
    const profile = await repo.deliveryProfileOf(tx, agencyId, profileId, { lock: true });
    // a profile switched off AUTO_SEND since the failed send sends nothing more (security review)
    if (!profile || profile.mode !== 'AUTO_SEND') return null;
    const contact = await crm.lockContactReach(tx, agencyId, profile.contactId);
    if (!contact || !mayAlert(contact) || channelOf(contact) !== pending.channel) return null;
    const token = await presentations.relinkAlertSelection(tx, agencyId, pending.selectionId);
    const attempt = await repo.bumpDeliveryAttempt(tx, pending.id);
    if (!token || attempt === 0) return null;
    return {
      deliveryId: pending.id,
      attempt,
      selectionId: pending.selectionId,
      token,
      channel: pending.channel as 'EMAIL' | 'WHATSAPP',
      matchCount: pending.matchCount,
      senderUserId: pending.senderUserId,
      contact,
    };
  });
}

/**
 * `matching.deliverProfile`: one profile's delivery for `period` (`INSTANT`, `D:<local date>`, `W:<ISO week>`).
 * Idempotent: a re-run finds the matches `SENT` (or the period delivered) and sends nothing; a failed send is retried
 * with a new link. `now` / `limits` for tests.
 */
export async function deliverProfile(
  input: { agencyId: string; profileId: string; period: DeliveryPeriod },
  options: { now?: Date; limits?: Partial<DeliveryLimits> } = {},
): Promise<DeliveryResult> {
  const limits: DeliveryLimits = { ...DELIVERY_LIMITS, ...options.limits };
  const now = options.now ?? clock.now();
  const { agencyId, profileId } = input;
  const result: DeliveryResult = { outcome: 'NONE', sent: 0, duplicates: 0, expired: 0, resent: false };
  if (!presentations.selectionLinksConfigured()) return { ...result, outcome: 'NOT_CONFIGURED' };

  const pending = await preparePending(agencyId, profileId, limits, now);
  if (pending) {
    await send(agencyId, pending);
    result.resent = true;
  }

  // The offer check under the agency's RLS (as the review queue: ACTIVE, own or shared with it now), and public (the
  // client's page shows public documents only).
  const read = await withTenant({ agencyId }, async (tx) => {
    const profile = await repo.deliveryProfileOf(tx, agencyId, profileId);
    if (!profile) return null;
    // a wider window: matches that cannot go now (not public, not shared now) must not crowd out those that can
    const queued = await repo.queuedMatchesOf(tx, { agencyId, profileId, limit: limits.matchesPerDelivery * 3 });
    const ids = queued.map((m) => m.listingId);
    const offerable = await search.offerableListingCards(tx, agencyId, ids, FALLBACK_CONTENT_LOCALE);
    const shown = await search.listingLabels(tx, ids, FALLBACK_CONTENT_LOCALE, { publicOnly: true });
    return {
      profile,
      sendable: queued
        .filter((m) => offerable.has(m.listingId) && shown.has(m.listingId))
        .slice(0, limits.matchesPerDelivery)
        .map((m) => m.id),
      gone: queued.filter((m) => !offerable.has(m.listingId) && m.listingAgencyId === agencyId).map((m) => m.id),
    };
  });
  if (!read) return { ...result, outcome: 'NONE' };
  if (read.profile.mode !== 'AUTO_SEND') return { ...result, outcome: 'NOT_AUTO_SEND' };
  if (read.profile.frequency !== frequencyOf(input.period)) return { ...result, outcome: 'OTHER_FREQUENCY' };

  const decided = await withSystem(`matching.deliverProfile: agency ${agencyId}`, async (tx) => {
    const profile = await repo.deliveryProfileOf(tx, agencyId, profileId, { lock: true });
    if (!profile || profile.mode !== 'AUTO_SEND') return { outcome: 'NOT_AUTO_SEND' as const };
    if (profile.frequency !== frequencyOf(input.period)) return { outcome: 'OTHER_FREQUENCY' as const };
    if (input.period !== 'INSTANT' && (await repo.periodDelivered(tx, agencyId, profileId, input.period))) {
      return { outcome: 'ALREADY_DELIVERED' as const };
    }
    const expired = await repo.expireQueuedMatches(tx, agencyId, read.gone);
    // lock order: profile, its matches, then the contact (the review queue's moves lock no QUEUED match)
    const rows = await repo.queuedMatchesOf(tx, {
      agencyId,
      profileId,
      limit: limits.matchesPerDelivery,
      ids: read.sendable,
      lock: true,
    });
    const contact = await crm.lockContactReach(tx, agencyId, profile.contactId);
    if (!contact) return { outcome: 'CONTACT_GONE' as const, expired };
    // without consent nothing is sent or marked sent: the matches wait (they go once consent is given)
    if (!mayAlert(contact)) return { outcome: 'NO_CONSENT' as const, expired };
    const channel = channelOf(contact);
    if (!channel) return { outcome: 'NO_CHANNEL' as const, expired };
    if (rows.length === 0) return { outcome: 'NONE' as const, expired };
    const listingIds = rows.map((r) => r.listingId);
    const sent = await repo.sentListingsOfContact(tx, agencyId, profile.contactId, listingIds);
    const selected = await presentations.contactSelectionTargets(tx, agencyId, profile.contactId, listingIds);
    const dup = rows.filter((r) => sent.has(r.listingId) || selected.has(r.listingId));
    const duplicates = await repo.markMatchesSent(
      tx,
      agencyId,
      dup.map((r) => r.id),
      null,
    );
    const fresh = rows.filter((r) => !sent.has(r.listingId) && !selected.has(r.listingId));
    if (fresh.length === 0) return { outcome: 'NONE' as const, expired, duplicates };
    const counts = await repo.lockedDeliveryCounts(tx, {
      agencyId,
      contactId: profile.contactId,
      since: new Date(now.getTime() - 86_400_000),
    });
    if (counts.agency >= limits.perAgencyPerDay || counts.contact >= limits.perContactPerDay) {
      return { outcome: 'CAPPED' as const, expired, duplicates };
    }
    const senderUserId = await senderOf(tx, agencyId, contact.ownerUserId);
    if (!senderUserId) return { outcome: 'NO_SENDER' as const, expired, duplicates };
    const locale = clientLocale(contact.language);
    const t = translator(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE, 'leads');
    const selection = await presentations.createAlertSelection(tx, {
      agencyId,
      createdBy: senderUserId,
      contactId: profile.contactId,
      title: t('profileAlert.selectionTitle'),
      locale,
      targetIds: fresh.map((r) => r.listingId),
    });
    await repo.markMatchesSent(
      tx,
      agencyId,
      fresh.map((r) => r.id),
      selection.id,
    );
    const deliveryId = newId();
    await repo.insertDelivery(tx, {
      id: deliveryId,
      agencyId,
      profileId,
      selectionId: selection.id,
      senderUserId,
      channel,
      periodKey: input.period === 'INSTANT' ? `I:${deliveryId}` : input.period,
      matchCount: fresh.length,
      attempts: 1,
    });
    const prepared: Prepared = {
      deliveryId,
      attempt: 1,
      selectionId: selection.id,
      token: selection.token,
      channel,
      matchCount: fresh.length,
      senderUserId,
      contact,
    };
    return { outcome: 'SENT' as const, expired, duplicates, prepared };
  });

  const out: DeliveryResult = {
    ...result,
    outcome: decided.outcome,
    expired: 'expired' in decided ? (decided.expired ?? 0) : 0,
    duplicates: 'duplicates' in decided ? (decided.duplicates ?? 0) : 0,
  };
  if (!('prepared' in decided) || !decided.prepared) return out;
  // after the commit (rule 6); a failure leaves the delivery PENDING for the retry
  const whatsappUrl = await send(agencyId, decided.prepared);
  return {
    ...out,
    sent: decided.prepared.matchCount,
    deliveryId: decided.prepared.deliveryId,
    channel: decided.prepared.channel,
    ...(whatsappUrl ? { whatsappUrl } : {}),
  };
}

/** A page of the agency's AUTO_SEND profiles of `frequency` with queued matches (the digest's walk). */
export function digestProfilesPage(
  agencyId: string,
  frequency: 'INSTANT' | 'DAILY' | 'WEEKLY',
  after: string | null,
  limit: number,
) {
  return withSystem('matching.deliverDigests', (tx) =>
    repo.digestProfilesPage(tx, { agencyId, frequency, after, limit }),
  );
}
