import {
  CreateContactBody,
  CreateListingBody,
  CreateSelectionBody,
  ListActivitiesQuery,
  UpdateListingBody,
} from '@inmolink/contracts';
import { closeDb, countQueries, withSystem } from '@inmolink/db';
import { setAgencyStatus, setupTestDb } from '@inmolink/db/testing';
import { closeCache, configureCache } from '@inmolink/platform/cache';
import { isAppError } from '@inmolink/platform/errors';
import { newId } from '@inmolink/platform/ids';
import { closeRateLimit, configureRateLimit, rateLimiter } from '@inmolink/platform/rate-limit';
import { configureSearch, createMeiliEngine } from '@inmolink/platform/search';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../../context';
import { withMemberCtx } from '../../../member';
import { createFounder, type Founder } from '../../../testing/factories';
import { whiteLabelLeaks } from '../../../testing/white-label';
import { plainText, textKey } from '../../../white-label';
import { writeAiRemovals } from '../../../white-label-store';
import * as crm from '../../crm';
import * as properties from '../../properties';
import * as search from '../../search';
import * as taxonomy from '../../taxonomy';
import * as websiteApi from '../../website-api';
import * as presentations from '../index';

/**
 * Selections end to end (S12-04): an agent (a) makes a selection of their own listing and another agency's (b) network
 * listing for a CRM contact; the client's page is white-labelled (b's name, contacts and reference never show; the
 * model pass's cached removals apply), live (b's price change shows on the next view, once the read model is rebuilt —
 * seconds after the change, far within 5 minutes), and what the client does reaches the selection and the contact's
 * timeline. Links expire, are revoked and rotated.
 */

const RUN = newId().slice(-8);
const code = (s: string) => `${s}-sel-${RUN}`;
const OWNER_NAME = `Ownerhaus Selecta ${RUN}`;
const OWNER_MAIL = `sales-${RUN.toLowerCase()}@ownerhaus-selecta.example`;
const INDIRECT = 'For a viewing ask for Marisol at our Nerja office.';
const DESCRIPTION = `Villa with 4 bedrooms and 320 m². ${INDIRECT} Call ${OWNER_NAME} on +34 955 512 345 or mail ${OWNER_MAIL}.`;

let a: Founder;
let b: Founder;
let ids: { city: string; villa: string };
const L = { own: '', network: '' };
let contactId = '';

const as = <T>(m: Founder, fn: (ctx: Ctx) => Promise<T>) =>
  withMemberCtx({ userId: m.userId, agencyId: m.agencyId, requestId: newId(), locale: 'en' }, fn);
const rebuild = (id: string) => withSystem('sel.test', (tx) => search.rebuildReadModels(tx, 'LISTING', [id]));

async function listing(m: Founder, priceCents: number, description: string): Promise<string> {
  const { id } = await as(m, (ctx) =>
    properties.createListing(
      ctx,
      CreateListingBody.parse({ propertyTypeId: ids.villa, locationId: ids.city, priceCents, energyRating: 'B' }),
    ),
  );
  for (const locale of ['en', 'es']) {
    await as(m, async (ctx) =>
      properties.saveListingTranslation(ctx, id, locale, {
        version: (await properties.getListing(ctx, id)).version,
        title: `Villa ${RUN}`,
        description,
      }),
    );
  }
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
  await rebuild(id);
  return id;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  return 'ok';
}

const create = (body: Record<string, unknown>) =>
  as(a, (ctx) => presentations.createSelection(ctx, CreateSelectionBody.parse(body)));

beforeAll(async () => {
  await setupTestDb('worker');
  await configureCache({ prefix: `t:sel:${RUN}`, commandTimeoutMs: 2_000 });
  await configureRateLimit({ url: process.env.REDIS_LIMITS_URL, commandTimeoutMs: 2_000 });
  presentations.configurePresentations({
    tokenKey: 'test-hmac-key-0123456789abcdef0123456789',
    publicBaseUrl: 'https://sites.example',
  });
  websiteApi.configureWebsiteApi({
    mediaBaseUrl: 'https://media.example',
    cursorKey: 'test-cursor-key-0123456789abcdef0123',
  });
  configureSearch(createMeiliEngine({ url: 'http://127.0.0.1:9', apiKey: 'x', timeoutMs: 200 }));
  a = await createFounder();
  b = await createFounder({ companyName: OWNER_NAME });
  for (const m of [a, b]) await setAgencyStatus(m.agencyId, 'VERIFIED');
  ids = await withSystem('sel.test', async (tx) => {
    const name = (n: string) => [{ locale: 'en', name: `${n} ${RUN}`, slug: code(n.toLowerCase()) }];
    const country = await taxonomy.createLocation(tx, {
      level: 'COUNTRY',
      parentId: null,
      code: code('c'),
      translations: name('Selland'),
    });
    const region = await taxonomy.createLocation(tx, {
      level: 'REGION',
      parentId: country,
      code: code('r'),
      translations: name('Coast'),
    });
    const city = await taxonomy.createLocation(tx, {
      level: 'CITY',
      parentId: region,
      code: code('ci'),
      translations: name('Port'),
    });
    const group = await taxonomy.createPropertyTypeGroup(tx, { key: code('g'), sort: 0, translations: name('Homes') });
    const villa = await taxonomy.createPropertyType(tx, {
      groupId: group,
      key: code('v'),
      sort: 0,
      translations: name('Villa'),
    });
    return { city, villa };
  });
  L.own = await listing(a, 30_000_000, 'Our own sunny villa with a pool.');
  L.network = await listing(b, 45_000_000, DESCRIPTION);
  contactId = (
    await as(a, (ctx) =>
      crm.createContact(
        ctx,
        CreateContactBody.parse({
          firstName: 'Ana',
          emails: [`ana-${RUN.toLowerCase()}@client.example`],
          phones: ['+34 600 11 22 33'],
        }),
      ),
    )
  ).contact.id;
}, 180_000);

afterAll(async () => {
  await closeRateLimit();
  await closeCache();
  await closeDb();
});

describe('selections (S12-04)', () => {
  it('[S12-04] create from chosen listings: ordered items, a link shown once, WhatsApp and e-mail share links', async () => {
    const made = await create({
      title: 'Villas for Ana',
      message: 'Hi Ana, my picks.',
      locale: 'en',
      contactId,
      items: [{ targetId: L.network, note: 'Great views' }, { targetId: L.own }, { targetId: newId() }],
    });
    // An item nobody can show is left out; the order is kept.
    expect(made.selection.items.map((i) => i.targetId)).toEqual([L.network, L.own]);
    expect(made.selection.status).toBe('LIVE');
    expect(made.share.url).toBe(`https://sites.example/s/${made.share.token}`);
    expect(made.share.whatsappUrl).toMatch(/^https:\/\/wa\.me\/34600112233\?text=/);
    expect(made.share.emailUrl).toMatch(/^mailto:ana-/);
    // The token is never stored.
    const stored = await withSystem('sel.test', (tx) =>
      tx.execute(sql`select token_hash, token_hint from selections where id = ${made.selection.id}`),
    );
    expect(JSON.stringify(stored.rows)).not.toContain(made.share.token);
    expect(made.selection.tokenHint).toBe(made.share.token.slice(-4));
    // None of them visible: refused.
    expect(await refusal(create({ title: 'x', locale: 'en', items: [{ targetId: newId() }] }))).toBe(
      'SELECTION_ITEMS_INVALID',
    );
  });

  it('[S12-04] create from a bookmark folder (its visible listings, oldest bookmark first)', async () => {
    const folder = await as(a, (ctx) => properties.createBookmarkFolder(ctx, { name: `For Ana ${RUN}` }));
    for (const listingId of [L.own, L.network]) {
      await as(a, (ctx) => properties.createBookmark(ctx, { folderId: folder.id, listingId }));
    }
    const made = await create({ title: 'From the folder', locale: 'en', fromFolderId: folder.id });
    expect(made.selection.items.map((i) => i.targetId)).toEqual([L.own, L.network]);
  });

  it('[S12-04] the page passes the white-label test (cached model removals applied), in ≤ 5 statements', async () => {
    const made = await create({
      title: 'Villas for Ana',
      locale: 'en',
      contactId,
      items: [{ targetId: L.network }, { targetId: L.own }],
    });
    // The worker's model pass found the indirect mention in b's description (S12-03), cached per target.
    await writeAiRemovals(
      { agencyId: b.agencyId, targetId: L.network },
      { version: 1, prompt: 1, texts: { [textKey(plainText(DESCRIPTION))]: [INDIRECT] } },
    );
    let model: presentations.SelectionPageModel | undefined;
    const statements = await countQueries(async () => {
      model = await presentations.selectionPage(made.share.token);
    });
    expect(statements).toBeLessThanOrEqual(5);
    const ownerRef = (await as(b, (ctx) => properties.getListing(ctx, L.network))).ref as string;
    expect(
      whiteLabelLeaks(model, {
        name: OWNER_NAME,
        email: OWNER_MAIL,
        domain: 'ownerhaus-selecta.example',
        ref: ownerRef,
        phone: '+34 955 512 345',
        phoneDigits: '955512345',
        agencyId: b.agencyId,
      }),
    ).toEqual([]);
    const network = model?.items[0]?.detail;
    expect(network?.description).not.toContain('Marisol');
    expect(network?.description).toContain('4 bedrooms');
    // a's own listing is a's: its own reference and text.
    expect(model?.items[1]?.detail?.description).toBe('Our own sunny villa with a pool.');
    // The client's language; another one on request.
    expect(model?.locale).toBe('en');
    expect((await presentations.selectionPage(made.share.token, 'es')).locale).toBe('es');
  });

  it('[S12-04] an owner price change shows on the selection on the next view (read model rebuild, no page cache)', async () => {
    const made = await create({ title: 'Live prices', locale: 'en', items: [{ targetId: L.network }] });
    const price = async () => (await presentations.selectionPage(made.share.token)).items[0]?.detail?.price.amountCents;
    expect(await price()).toBe(45_000_000);
    const startedAt = Date.now();
    await as(b, async (ctx) =>
      properties.updateListing(
        ctx,
        L.network,
        UpdateListingBody.parse({
          priceCents: 39_900_000,
          version: (await properties.getListing(ctx, L.network)).version,
        }),
      ),
    );
    // The worker rebuilds the read model from the change's event (debounced `READ_MODEL_DEBOUNCE_MS`).
    await rebuild(L.network);
    expect(await price()).toBe(39_900_000);
    expect(Date.now() - startedAt + search.READ_MODEL_DEBOUNCE_MS).toBeLessThan(5 * 60_000);
  });

  it('[S12-04] views, likes and enquiries reach the selection and the contact timeline', async () => {
    const made = await create({
      title: 'Tracked',
      locale: 'en',
      contactId,
      items: [{ targetId: L.own }, { targetId: L.network }],
    });
    const token = made.share.token;
    await presentations.recordSelectionInteraction(token, { kind: 'VIEW' });
    await presentations.recordSelectionInteraction(token, { kind: 'LIKE', targetId: L.own });
    await presentations.recordSelectionInteraction(token, { kind: 'LIKE', targetId: L.network });
    await presentations.recordSelectionInteraction(token, { kind: 'UNLIKE', targetId: L.network });
    await presentations.recordSelectionInteraction(token, {
      kind: 'ENQUIRE',
      targetId: L.own,
      message: 'Can I visit on Friday?',
    });
    // An item of another selection is refused.
    expect(await refusal(presentations.recordSelectionInteraction(token, { kind: 'LIKE', targetId: newId() }))).toBe(
      'VALIDATION_FAILED',
    );
    const got = await as(a, (ctx) => presentations.getSelection(ctx, made.selection.id));
    expect(got.stats.views).toBe(1);
    expect(got.items.map((i) => [i.targetId, i.likes, i.enquiries])).toEqual([
      [L.own, 1, 1],
      [L.network, 0, 0],
    ]);
    const page = await as(a, (ctx) => presentations.listSelectionInteractions(ctx, made.selection.id, { limit: 10 }));
    expect(page.items.map((i) => i.kind)).toEqual(['ENQUIRE', 'UNLIKE', 'LIKE', 'LIKE', 'VIEW']);
    // Each wrote its event in the same transaction; the worker puts them on the contact's timeline.
    const events = await withSystem('sel.test', (tx) =>
      tx.execute(sql`select id, agency_id, payload, created_at from outbox_events
        where type = 'presentations.selection.interacted' and payload->>'selectionId' = ${made.selection.id}
        order by created_at`),
    );
    expect(events.rows).toHaveLength(5);
    for (const e of events.rows as { id: string; agency_id: string; payload: never; created_at: string }[]) {
      const activity = await presentations.selectionTimelineActivity(e.payload, {
        eventId: e.id,
        agencyId: e.agency_id,
        createdAt: new Date(e.created_at),
      });
      if (activity) await crm.recordActivity(activity);
    }
    const timeline = await as(a, (ctx) =>
      crm.listActivities(ctx, ListActivitiesQuery.parse({ subject: 'CONTACT', subjectId: contactId, limit: 20 })),
    );
    const kinds = timeline.items.map((i) => i.type).filter((t) => t.startsWith('SELECTION_'));
    expect(kinds.sort()).toEqual(
      ['SELECTION_ENQUIRED', 'SELECTION_LIKED', 'SELECTION_LIKED', 'SELECTION_VIEWED'].sort(),
    );
    // a's own listing's timeline has its likes and enquiry; b's listing is not a's to track.
    const own = timeline.items.filter((i) => i.listingId === L.own);
    expect(own.length).toBe(2);
    expect(timeline.items.some((i) => i.listingId === L.network)).toBe(false);
  });

  it('[S12-04] an owner narrowing its sharing takes its listing off other agencies’ selections at the next view', async () => {
    const id = await listing(b, 52_000_000, 'Townhouse near the beach.');
    const made = await create({
      title: 'Sharing re-check',
      locale: 'en',
      items: [{ targetId: id }, { targetId: L.own }],
    });
    const shown = async () => (await presentations.selectionPage(made.share.token)).items.map((i) => i.detail !== null);
    expect(await shown()).toEqual([true, true]);
    const share = async (shareScope: 'ALL' | 'PREFERRED') => {
      await as(b, async (ctx) =>
        properties.updateListing(
          ctx,
          id,
          UpdateListingBody.parse({ shareScope, version: (await properties.getListing(ctx, id)).version }),
        ),
      );
      await rebuild(id);
    };
    // Still public on b's own sites, but shared only with b's preferred agencies (a is not one): gone from a's page.
    await share('PREFERRED');
    expect(await shown()).toEqual([false, true]);
    await share('ALL');
    expect(await shown()).toEqual([true, true]);
  });

  it('[S12-04] review: an unverified or suspended presenting agency shows no other agency’s listing on its selections', async () => {
    const made = await create({
      title: 'Listed re-check',
      locale: 'en',
      items: [{ targetId: L.network }, { targetId: L.own }],
    });
    const shown = async () => (await presentations.selectionPage(made.share.token)).items.map((i) => i.detail !== null);
    expect(await shown()).toEqual([true, true]);
    try {
      for (const status of ['SUSPENDED', 'PENDING'] as const) {
        await setAgencyStatus(a.agencyId, status);
        // a's own listing stays (its read model is not rebuilt here); b's is gone at once.
        expect(await shown()).toEqual([false, true]);
      }
      await setAgencyStatus(a.agencyId, 'VERIFIED');
      expect(await shown()).toEqual([true, true]);
      // The owner suspended: its listing leaves a's page at the next view, before any rebuild.
      await setAgencyStatus(b.agencyId, 'SUSPENDED');
      expect(await shown()).toEqual([false, true]);
    } finally {
      await setAgencyStatus(a.agencyId, 'VERIFIED');
      await setAgencyStatus(b.agencyId, 'VERIFIED');
    }
  });

  it('[S12-04] expiry, revocation and a new link: the old page is gone, the new one live', async () => {
    const made = await create({ title: 'Expiring', locale: 'en', expiresInDays: 7, items: [{ targetId: L.own }] });
    expect(made.selection.expiresAt).not.toBeNull();
    // Past its date: gone (the public read's own predicate), and no interaction is accepted.
    await withSystem('sel.test', (tx) =>
      tx.execute(sql`update selections set expires_at = now() - interval '1 minute' where id = ${made.selection.id}`),
    );
    expect(await refusal(presentations.selectionPage(made.share.token))).toBe('SELECTION_NOT_FOUND');
    expect(await refusal(presentations.recordSelectionInteraction(made.share.token, { kind: 'VIEW' }))).toBe(
      'SELECTION_NOT_FOUND',
    );
    const expired = await as(a, (ctx) => presentations.getSelection(ctx, made.selection.id));
    expect(expired.status).toBe('EXPIRED');
    // A new link brings it back; the old link stays gone.
    const rotated = await as(a, (ctx) => presentations.rotateSelectionLink(ctx, made.selection.id, expired.version));
    expect(rotated.selection.status).toBe('LIVE');
    expect(await refusal(presentations.selectionPage(rotated.share.token))).toBe('ok');
    expect(await refusal(presentations.selectionPage(made.share.token))).toBe('SELECTION_NOT_FOUND');
    // Stopped now (`expiresInDays: null`): revoked.
    const revoked = await as(a, (ctx) =>
      presentations.updateSelection(ctx, made.selection.id, {
        version: rotated.selection.version,
        expiresInDays: null,
      }),
    );
    expect(revoked.status).toBe('REVOKED');
    expect(await refusal(presentations.selectionPage(rotated.share.token))).toBe('SELECTION_NOT_FOUND');
    // A stale version is a conflict; another agency sees nothing.
    expect(
      await refusal(as(a, (ctx) => presentations.updateSelection(ctx, made.selection.id, { version: 1, title: 'x' }))),
    ).toBe('VERSION_CONFLICT');
    expect(await refusal(as(b, (ctx) => presentations.getSelection(ctx, made.selection.id)))).toBe(
      'SELECTION_NOT_FOUND',
    );
    // Malformed tokens never reach the database.
    expect(await refusal(presentations.selectionPage('short'))).toBe('SELECTION_NOT_FOUND');
  });

  it('[S12-04] a selection’s enquiry budget is shared by every client address (not per IP)', async () => {
    const token = `${RUN}${'e'.repeat(43)}`.slice(0, 43);
    const limiter = rateLimiter();
    const ips = [`198.51.100.1-${RUN}`, `198.51.100.2-${RUN}`];
    const enquire = (ip: string) =>
      presentations.checkSelectionLimits(limiter, { ip, write: { token, enquiry: true } });
    for (let n = 0; n < presentations.SELECTION_PAGE_LIMITS.enquiriesPerHour; n++) {
      expect((await enquire(ips[n % 2] as string)).allowed, `enquiry ${n + 1}`).toBe(true);
    }
    // Both addresses together used the page's budget: a third address is refused too, likes still pass.
    expect((await enquire(`198.51.100.3-${RUN}`)).allowed).toBe(false);
    expect(
      (await presentations.checkSelectionLimits(limiter, { ip: ips[0] as string, write: { token } })).allowed,
    ).toBe(true);
    // Another page has its own budget.
    const other = `${'f'.repeat(35)}${RUN}`;
    expect(
      (
        await presentations.checkSelectionLimits(limiter, {
          ip: ips[0] as string,
          write: { token: other, enquiry: true },
        })
      ).allowed,
    ).toBe(true);
  });

  it('[S12-04] the list: newest first, keyset, with views and item counts', async () => {
    const page = await as(a, (ctx) => presentations.listSelections(ctx, { limit: 2 }));
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const next = await as(a, (ctx) =>
      presentations.listSelections(ctx, { limit: 2, cursor: page.nextCursor as string }),
    );
    expect(next.items.map((i) => i.id)).not.toContain(page.items[0]?.id);
    const forAna = await as(a, (ctx) => presentations.listSelections(ctx, { limit: 50, contactId }));
    expect(forAna.items.every((i) => i.contactId === contactId)).toBe(true);
    expect(forAna.items.find((i) => i.title === 'Tracked')?.stats.views).toBe(1);
  });
});
