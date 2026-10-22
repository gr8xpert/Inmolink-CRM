import {
  CreateListingBody,
  type CreateSiteInput,
  UpdateListingBody,
  type WebsiteLeadAccepted,
  WebsiteLeadBody,
  WebsiteViewingRequestBody,
} from '@inmolink/contracts';
import { closeDb, withPublicRead, withSystem, withTenant } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { restoreClock } from '@inmolink/platform/clock';
import { closeEmail, configureEmail, createMemoryMailer, type MemoryMailer } from '@inmolink/platform/email';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { createLogger } from '@inmolink/platform/logger';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import type { TurnstileVerifier } from '@inmolink/platform/turnstile';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websites from '../../websites';
import { honeytokenRef } from '../honeytokens';
import * as websiteApi from '../index';
import { ackCapReached } from '../jobs';

/**
 * Website lead intake (S7-05): leads belong to the presenting agency (the site's), duplicates with one idempotency key
 * make one lead, honeytokens make none, visitors are checked (Turnstile / the site server), and the acknowledgement is
 * branded as the site, in the visitor's language, with three similar listings of the site's inventory.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-${RUN}`;
const CURSOR_KEY = 'test-cursor-key-0123456789abcdef0123';
const log = createLogger({ service: 'leads-test', level: 'silent' });
const jobCtx = (id: string) => ({
  log,
  jobId: id,
  attempt: 1,
  progress: async () => {},
  signal: new AbortController().signal,
});

/** a: the site's agency · b: owner of network listings shared with everyone. */
let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
const L: Record<string, string> = {};
let siteId = '';
let mail: MemoryMailer;
const alerts: websiteApi.WebsiteAlert[] = [];
/** Turnstile answers by token: `good` passes for the expected action and host, anything else fails. */
const usedTokens = new Set<string>();
const goodToken = () => `good-${newId()}`;
/** `YYYY-MM-DD`, `n` days from today (viewing slots must lie between today and a year ahead). */
const dayAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const turnstileCalls: { token: string; action: string; hostnames?: readonly string[]; remoteIp?: string }[] = [];
const turnstile: TurnstileVerifier = {
  async verify(token, options) {
    turnstileCalls.push({ token, ...options });
    // Single-use, like Siteverify: a token passes once.
    const fresh = !usedTokens.has(token);
    usedTokens.add(token);
    return fresh && token.startsWith('good') && options.action === websiteApi.LEAD_TURNSTILE_ACTION;
  },
};

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem('website-api.leads.test', fn);

async function listing(m: Founder, priceCents: number, extra: Partial<CreateListingBody> = {}): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({
        propertyTypeId: ids.villa,
        locationId: ids.city,
        priceCents,
        energyRating: 'B',
        ...extra,
      }),
    ),
  );
  await as(m, async (ctx) =>
    properties.updateListing(
      ctx,
      id,
      UpdateListingBody.parse({
        status: 'ACTIVE',
        visibility: 'PUBLIC',
        shareScope: 'ALL',
        version: (await properties.getListing(ctx, id)).version,
      }),
    ),
  );
  return id;
}

const SITE: CreateSiteInput = {
  name: 'Costa Homes web',
  domains: ['www.costa-homes.example'],
  mode: 'WP_PLUGIN',
  inventoryPolicy: 'OWN_PLUS_NETWORK',
  inventoryFilters: null,
  referencePrefix: 'CH',
  locales: ['en', 'es'],
  contact: { name: 'Costa Homes Marbella', email: 'hello@costa-homes.example', phone: '+34 600 000 001' },
};

const site = () => websiteApi.siteForKey({ agencyId: a.agencyId, siteId }, newId());
const refOf = async (id: string) =>
  (await system((tx) => tx.execute<{ ref: string }>(sql`select ref from properties where id = ${id}`))).rows[0]
    ?.ref as string;
const codeOf = async (id: string) => (await withPublicRead((tx) => search.publicCodes(tx, [id]))).get(id) as string;

const enquiry = (patch: Partial<WebsiteLeadBody> = {}) =>
  WebsiteLeadBody.parse({
    name: 'Ana Buyer',
    email: `ana-${newId().slice(-6)}@example.com`,
    privacyAccepted: true,
    serverVerified: true,
    message: 'Is it still available?',
    ...patch,
  });
const secret = (key = newId()): websiteApi.LeadRequestFacts => ({
  keyKind: 'SECRET',
  keyTier: 'STANDARD',
  idempotencyKey: `idem-${key}`,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

interface LeadDbRow {
  id: string;
  agency_id: string;
  owner_agency_id: string | null;
  shown_ref: string | null;
  target_id: string | null;
  verification: string;
  kind: string;
}
const leadRow = async (id: string) =>
  (await system((tx) => tx.execute(sql`select * from website_leads where id = ${id}`))).rows[0] as unknown as
    | LeadDbRow
    | undefined;
const leadEvents = async (leadId: string) =>
  (
    await system((tx) =>
      tx.execute<{ agency_id: string; type: string }>(
        sql`select agency_id, type from outbox_events where payload->>'leadId' = ${leadId}`,
      ),
    )
  ).rows;

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:leads:${RUN}` });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: CURSOR_KEY,
    onAlert: (alert) => alerts.push(alert),
    turnstile,
  });
  search.configureNetworkSearch({ giveToGetMinShared: 1, giveToGetGraceDays: 0 });
  // The engine is unreachable: website search (and so similar listings) answers from the Postgres fallback.
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  search.resetSearchBreaker();
  [a, b] = [await createFounder(), await createFounder()];
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await system(async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('ld'),
      translations: name('Leadland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('ld-r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ld-c'),
      translations: name('Marina'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, {
      key: code('ld-g'),
      sort: 0,
      translations: name('Homes'),
    });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('ld-villa'),
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  L.aVilla = await listing(a, 30_000_000);
  L.aTwin = await listing(a, 31_000_000);
  L.bAll = await listing(b, 32_000_000);
  L.bNear = await listing(b, 33_000_000);
  L.bFar = await listing(b, 90_000_000);
  await system((tx) => search.rebuildReadModels(tx, 'LISTING', Object.values(L)));
  siteId = (await as(a, (ctx) => websites.createSite(ctx, SITE))).id;
}, 180_000);

beforeEach(async () => {
  mail = createMemoryMailer();
  await configureEmail(mail);
  alerts.length = 0;
  turnstileCalls.length = 0;
});

afterEach(() => restoreClock());

afterAll(async () => {
  await closeEmail();
  await closeCache();
  await closeDb();
});

describe('website lead intake (S7-05)', () => {
  it('[S7-05] a lead from site A for a network listing belongs to agency A (presenting agency); the owner never reads it', async () => {
    const ref = `CH-${await codeOf(L.bAll as string)}`;
    const { accepted, created } = await websiteApi.submitLead(
      await site(),
      { kind: 'ENQUIRY', body: enquiry({ ref }) },
      secret(),
    );
    expect(created).toBe(true);
    expect(accepted).toMatchObject({ kind: 'ENQUIRY', status: 'RECEIVED', replayed: false });
    const row = await leadRow(accepted.id);
    expect(row).toMatchObject({
      agency_id: a.agencyId,
      owner_agency_id: b.agencyId,
      shown_ref: ref,
      target_id: L.bAll,
      verification: 'SERVER_KEY',
    });
    // The event is the presenting agency's, in the same transaction.
    expect(await leadEvents(accepted.id)).toEqual([{ agency_id: a.agencyId, type: 'websites.lead.received' }]);
    // RLS: the presenting agency reads it, the listing's owner does not (no client PII, PLAN §3 #12).
    const visible = (agencyId: string) =>
      withTenant({ agencyId }, async (tx) =>
        Number((await tx.execute(sql`select count(*) as n from website_leads where id = ${accepted.id}`)).rows[0]?.n),
      );
    expect(await visible(a.agencyId)).toBe(1);
    expect(await visible(b.agencyId)).toBe(0);
    // An own listing by its own reference: no owner recorded.
    const own = await websiteApi.submitLead(
      await site(),
      { kind: 'ENQUIRY', body: enquiry({ ref: await refOf(L.aVilla as string) }) },
      secret(),
    );
    expect(await leadRow(own.accepted.id)).toMatchObject({ agency_id: a.agencyId, owner_agency_id: null });
  });

  it('[S7-05] duplicate submissions with the same idempotency key create one lead (also at once); another body is refused', async () => {
    const facts = secret();
    const body = enquiry({ ref: await refOf(L.aVilla as string) });
    const first = await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts);
    const again = await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts);
    expect(again).toEqual({ accepted: { ...first.accepted, replayed: true }, created: false });
    // The visitor check token may differ on a retry: it is not part of the submission.
    const retried = await websiteApi.submitLead(
      await site(),
      { kind: 'ENQUIRY', body: { ...body, serverVerified: undefined, turnstileToken: 'used-already' } },
      facts,
    );
    expect(retried.accepted.id).toBe(first.accepted.id);
    expect(
      await refusal(
        websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body: { ...body, message: 'Other text' } }, facts),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');

    // Concurrent duplicates (a double click, a retry racing the first): still one lead and one event.
    const racing = secret();
    const raceBody = enquiry();
    const results = await Promise.all(
      [1, 2, 3].map(async () => websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body: raceBody }, racing)),
    );
    expect(new Set(results.map((r) => r.accepted.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const leadId = results[0]?.accepted.id as string;
    expect(await leadEvents(leadId)).toHaveLength(1);
    const count = await system(async (tx) =>
      Number(
        (
          await tx.execute(
            sql`select count(*) as n from website_leads where site_id = ${siteId} and email = ${raceBody.email}`,
          )
        ).rows[0]?.n,
      ),
    );
    expect(count).toBe(1);
  });

  it('[S7-05] idempotency keys are honoured for 24 h, then pruned', async () => {
    const facts = secret();
    const body = enquiry();
    const first = await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts);
    // Within the window the key still names the lead; past it the prune clears it and the key is free again.
    expect(await websites.pruneLeadIdempotency(new Date())).toBeGreaterThanOrEqual(0);
    expect((await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts)).created).toBe(false);
    const later24h = new Date(Date.now() + (websites.LEAD_IDEMPOTENCY_HOURS * 3_600_000 + 60_000));
    expect(await websites.pruneLeadIdempotency(later24h)).toBeGreaterThan(0);
    const later = await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts);
    expect(later.created).toBe(true);
    expect(later.accepted.id).not.toBe(first.accepted.id);
  });

  it('[S7-05] a honeytoken reference creates no lead and no e-mail, answers as a withdrawn listing and raises WebsiteHoneytokenHit', async () => {
    const realRef = `CH-${await codeOf(L.bAll as string)}`;
    const token = honeytokenRef(CURSOR_KEY, { siteId, referencePrefix: 'CH' }, realRef);
    expect(token).not.toBe(realRef);
    const body = enquiry({ ref: token });
    const facts = secret();
    expect(await refusal(websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts))).toBe(
      'LISTING_NOT_FOUND',
    );
    expect(alerts).toEqual([expect.objectContaining({ kind: 'honeytoken', ref: token, siteId })]);
    const viewing = WebsiteViewingRequestBody.parse({ ...body, slots: [{ date: dayAhead(1), timeOfDay: 'MORNING' }] });
    expect(
      await refusal(websiteApi.submitLead(await site(), { kind: 'VIEWING_REQUEST', body: viewing }, secret())),
    ).toBe('LISTING_NOT_FOUND');
    const rows = await system((tx) =>
      tx.execute(sql`select 1 from website_leads where site_id = ${siteId} and email = ${body.email}`),
    );
    expect(rows.rows).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    // A reference the site simply does not have: the same answer, no alert.
    alerts.length = 0;
    expect(
      await refusal(
        websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body: enquiry({ ref: 'NOPE-123' }) }, secret()),
      ),
    ).toBe('LISTING_NOT_FOUND');
    expect(alerts).toEqual([]);
  });

  it('[S7-05] visitors are checked: publishable keys need a Turnstile token solved on the page host; secret keys forward one or vouch', async () => {
    const browser = (key = newId()): websiteApi.LeadRequestFacts => ({
      keyKind: 'PUBLISHABLE',
      keyTier: 'STANDARD',
      origin: 'https://www.costa-homes.example',
      ip: '203.0.113.7',
      idempotencyKey: `idem-${key}`,
    });
    const { serverVerified: _v, ...plain } = enquiry();
    const token = goodToken();
    const ok = await websiteApi.submitLead(
      await site(),
      { kind: 'ENQUIRY', body: { ...plain, turnstileToken: token } },
      browser(),
    );
    expect(ok.created).toBe(true);
    expect(turnstileCalls.at(-1)).toEqual({
      token,
      action: 'website-lead',
      remoteIp: '203.0.113.7',
      hostnames: ['www.costa-homes.example'],
    });
    expect((await leadRow(ok.accepted.id))?.verification).toBe('TURNSTILE');
    const refused = async (body: WebsiteLeadBody, facts: websiteApi.LeadRequestFacts = browser()) =>
      refusal(websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts));
    expect(await refused({ ...plain, turnstileToken: 'bad' })).toBe('TURNSTILE_FAILED');
    expect(await refused(plain)).toBe('TURNSTILE_FAILED');
    // A browser cannot vouch for itself.
    expect(await refused({ ...plain, serverVerified: true })).toBe('VALIDATION_FAILED');
    // A used token (a second form with the first one's token) is refused too.
    expect(await refused({ ...plain, turnstileToken: token })).toBe('TURNSTILE_FAILED');
    // Secret keys: no token and no statement is refused; a forwarded token must be solved on one of the site's domains.
    expect(await refused(plain, secret())).toBe('TURNSTILE_FAILED');
    expect(await refused({ ...plain, turnstileToken: 'bad' }, secret())).toBe('TURNSTILE_FAILED');
    expect(turnstileCalls.at(-1)?.hostnames).toEqual(['www.costa-homes.example']);
    // No verifier configured (no Turnstile account yet): browser forms are refused, fail closed.
    websiteApi.configureWebsiteApi({ mediaBaseUrl: 'https://media.example', cursorKey: CURSOR_KEY, turnstile: null });
    try {
      expect(await refused({ ...plain, turnstileToken: goodToken() })).toBe('TURNSTILE_FAILED');
    } finally {
      websiteApi.configureWebsiteApi({
        mediaBaseUrl: 'https://media.example',
        cursorKey: CURSOR_KEY,
        onAlert: (alert) => alerts.push(alert),
        turnstile,
      });
    }
  });

  it('[S7-05] a double submit through a browser form (its token already used) answers the first lead', async () => {
    const facts: websiteApi.LeadRequestFacts = {
      keyKind: 'PUBLISHABLE',
      keyTier: 'STANDARD',
      origin: 'https://www.costa-homes.example',
      idempotencyKey: `idem-${newId()}`,
    };
    const { serverVerified: _v, ...plain } = enquiry();
    const body = { ...plain, turnstileToken: goodToken() };
    // Both clicks at once: one passes Turnstile and writes the lead; the other's token is spent and its replay lookup
    // answers that lead — or, when it looked before the first committed, 403 (the widget retries with a new token).
    const both = await Promise.allSettled(
      [1, 2].map(async () => websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts)),
    );
    const ok = both.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(ok.filter((r) => r.created)).toHaveLength(1);
    for (const r of both) {
      if (r.status === 'rejected') expect(isAppError(r.reason) && r.reason.code).toBe('TURNSTILE_FAILED');
    }
    // The second click after the first answered: always the same lead, never a second one.
    const again = await websiteApi.submitLead(await site(), { kind: 'ENQUIRY', body }, facts);
    expect(again).toEqual({
      accepted: { ...(ok[0]?.accepted as WebsiteLeadAccepted), replayed: true },
      created: false,
    });
    const rows = await system((tx) =>
      tx.execute(sql`select 1 from website_leads where site_id = ${siteId} and email = ${body.email}`),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("[S7-05] the auto-acknowledgement uses the site's branding and the visitor's language, with 3 similar listings of the site's inventory", async () => {
    const ref = await refOf(L.aVilla as string);
    const { accepted } = await websiteApi.submitLead(
      await site(),
      { kind: 'ENQUIRY', body: enquiry({ ref, lang: 'es', name: `Ana "O'Brien" & Co` }) },
      secret(),
    );
    const payload = { eventId: newId(), leadId: accepted.id, agencyId: a.agencyId };
    await websiteApi.websiteApiJobs.sendLeadAcknowledgement.spec.run(payload, jobCtx('ack'));
    expect(mail.sent).toHaveLength(1);
    const ack = mail.sent[0] as (typeof mail.sent)[number];
    // The site's branding (presenting agency's name and contacts), in Spanish: the sender's name is the site's, replies
    // go to the site's contact.
    expect(ack.subject).toBe('Hemos recibido su consulta – Costa Homes Marbella');
    expect(ack.fromName).toBe('Costa Homes Marbella');
    expect(ack.replyTo).toBe('hello@costa-homes.example');
    expect(ack.text).toContain(`Gracias por su interés en la propiedad ${ref}`);
    expect(ack.text).toContain('+34 600 000 001');
    expect(ack.tag).toBe('website.lead-ack');
    // Only the first name is echoed (free text a form sender typed never reaches the recipient).
    expect(ack.text).toContain('Estimado/a Ana:');
    expect(ack.text).not.toContain('Brien');
    expect(ack.html).not.toContain('Brien');
    // Three similar listings from the site's inventory, white-labelled: network ones by `CH-<code>`, never the
    // owner's reference; never the enquired listing; the far-off price last in line (not needed).
    const shown = [...ack.text.matchAll(/\(Ref\. (\S+)\)/g)].map((m) => m[1]);
    expect(shown).toHaveLength(3);
    expect(shown).not.toContain(ref);
    const expected = new Set([
      await refOf(L.aTwin as string),
      `CH-${await codeOf(L.bAll as string)}`,
      `CH-${await codeOf(L.bNear as string)}`,
    ]);
    expect(new Set(shown)).toEqual(expected);
    for (const id of [L.bAll, L.bNear, L.bFar]) expect(ack.text).not.toContain(await refOf(id as string));
    // Sent once: a redelivered job does not send again.
    await websiteApi.websiteApiJobs.sendLeadAcknowledgement.spec.run(payload, jobCtx('ack-2'));
    expect(mail.sent).toHaveLength(1);
    const sentAt = await system((tx) =>
      tx.execute<{ ack_sent_at: Date | null }>(sql`select ack_sent_at from website_leads where id = ${accepted.id}`),
    );
    expect(sentAt.rows[0]?.ack_sent_at).not.toBeNull();
  });

  it('[S7-05] the presenting agency is notified with the visitor details; a viewing request lists its slots', async () => {
    const ref = `CH-${await codeOf(L.bNear as string)}`;
    const body = WebsiteViewingRequestBody.parse({
      ...enquiry({ ref, phone: '+44 7700 900123' }),
      slots: [
        { date: dayAhead(5), timeOfDay: 'MORNING' },
        { date: dayAhead(6), timeOfDay: 'EVENING' },
      ],
    });
    const { accepted } = await websiteApi.submitLead(await site(), { kind: 'VIEWING_REQUEST', body }, secret());
    expect(accepted.kind).toBe('VIEWING_REQUEST');
    // One job per recipient (the site's contact here): a retry never e-mails someone twice.
    const job = { leadId: accepted.id, agencyId: a.agencyId, recipient: 'contact' as const };
    await websiteApi.websiteApiJobs.notifyLeadRecipient.spec.run(job, jobCtx('notify'));
    expect(websiteApi.websiteApiJobs.notifyLeadRecipient.spec.jobId?.(job)).toBe(`${accepted.id}:contact`);
    expect(mail.sent.map((m) => m.to)).toEqual(['hello@costa-homes.example']);
    const note = mail.sent[0] as (typeof mail.sent)[number];
    expect(note.subject).toBe(`New viewing request – ${ref}`);
    expect(note.text).toContain(body.email);
    expect(note.text).toContain('+44 7700 900123');
    expect(note.text).toContain(`${dayAhead(5)} (morning), ${dayAhead(6)} (evening)`);
    // Only the presenting agency is written to — the listing's owner (agency b) is not.
    expect(note.text).not.toContain(await refOf(L.bNear as string));
  });

  it('[S7-05] acknowledgements are capped per recipient (a form can name anyone): the lead is kept, the ack skipped', async () => {
    const email = `victim-${newId().slice(-6)}@example.com`;
    const leads: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { accepted } = await websiteApi.submitLead(
        await site(),
        { kind: 'ENQUIRY', body: enquiry({ email }) },
        secret(),
      );
      leads.push(accepted.id);
      await websiteApi.websiteApiJobs.sendLeadAcknowledgement.spec.run(
        { eventId: newId(), leadId: accepted.id, agencyId: a.agencyId },
        jobCtx(`cap-${i}`),
      );
    }
    // Three per site per day: the fourth lead is stored, its acknowledgement skipped with the reason.
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(3);
    const last = await system((tx) =>
      tx.execute<{ ack_sent_at: Date | null; ack_skipped_reason: string | null }>(
        sql`select ack_sent_at, ack_skipped_reason from website_leads where id = ${leads[3] as string}`,
      ),
    );
    expect(last.rows[0]).toEqual({ ack_sent_at: null, ack_skipped_reason: 'RECIPIENT_SITE_DAILY' });
    // The other caps, by the same rule: ten per recipient platform-wide, the site's daily cap by key tier.
    expect(ackCapReached({ recipientSite: 0, recipient: 10, site: 0 }, 'STANDARD')).toBe('RECIPIENT_DAILY');
    expect(ackCapReached({ recipientSite: 0, recipient: 0, site: 1_000 }, 'STANDARD')).toBe('SITE_DAILY');
    expect(ackCapReached({ recipientSite: 0, recipient: 0, site: 1_000 }, 'HIGH')).toBeNull();
  });

  it('[S7-05] concurrent acknowledgement jobs for one recipient (aliases included) send at most the cap', async () => {
    const user = `victim${newId().slice(-6)}`;
    // Five spellings of one Gmail mailbox: the cap counts the mailbox, each ack goes to the address as given.
    const spellings = [
      `${user}@gmail.com`,
      `${user}+a@gmail.com`,
      `${user.slice(0, 3)}.${user.slice(3)}@googlemail.com`,
      ` ${user.toUpperCase()}+b@Gmail.com `.trim(),
      `${user}+c@googlemail.com`,
    ];
    const ids: string[] = [];
    for (const email of spellings) {
      const { accepted } = await websiteApi.submitLead(
        await site(),
        { kind: 'ENQUIRY', body: enquiry({ email }) },
        secret(),
      );
      ids.push(accepted.id);
    }
    await Promise.all(
      ids.map((leadId, i) =>
        websiteApi.websiteApiJobs.sendLeadAcknowledgement.spec.run(
          { eventId: newId(), leadId, agencyId: a.agencyId },
          jobCtx(`race-${i}`),
        ),
      ),
    );
    // Three per recipient per site per day, however the jobs interleave.
    const lower = spellings.map((s) => s.toLowerCase());
    const sent = mail.sent.filter((m) => lower.includes(String(m.to).toLowerCase()));
    expect(sent).toHaveLength(3);
    const rows = await system((tx) =>
      tx.execute<{ sent: string; skipped: string }>(
        sql`select count(ack_sent_at) as sent, count(ack_skipped_reason) as skipped
              from website_leads where id in (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
      ),
    );
    expect(rows.rows[0]).toEqual({ sent: '3', skipped: '2' });
  });
});
