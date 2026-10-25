import type { ListingDetailDoc, WebsitePresenter } from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import { whiteLabelLeaks } from '../../../testing/white-label';
import { fixtureLeaks, missingFacts, sanitizerFixture } from '../../../testing/white-label-fixtures';
import { compileOwner, plainText, textKey } from '../../../white-label';
import type * as websites from '../../websites';
import { configurePresentations, SELECTION_TOKEN, selectionTokenHash } from '../config';
import { interactionOf, presentSelection, type SelectionDocRow } from '../public';
import { shareLinks, statusOf } from '../service';

/**
 * Selections (S12-04), the pure parts: what the page shows of a network listing (white-labelled with the S12-03
 * deterministic pass and cached model removals, the agent's title and note too), share links, status, form actions.
 */

const AGENCY = '01900000-0000-7000-8000-0000000000a1';
const OWNER = '01900000-0000-7000-8000-0000000000b2';
const TARGET = '01900000-0000-7000-8000-0000000000c3';
const OWN_TARGET = '01900000-0000-7000-8000-0000000000c4';
const GONE_TARGET = '01900000-0000-7000-8000-0000000000c5';

const PRESENTER: WebsitePresenter = {
  name: 'Presenting Homes',
  email: 'hello@presenting.example',
  phone: '+34 600 000 001',
  whatsapp: null,
  website: null,
  primaryColor: null,
  accentColor: null,
};

const taxon = (name: string) => ({ id: '01900000-0000-7000-8000-0000000000d1', name, slug: name.toLowerCase() });

function detail(id: string, ref: string, title: string, description: string, priceCents: number): ListingDetailDoc {
  return {
    kind: 'LISTING',
    id,
    ref,
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: priceCents, currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon('Villa'),
    place: { country: taxon('Spain'), region: null, city: taxon('San Juan'), area: null },
    bedrooms: 3,
    bathrooms: 2,
    builtM2: 180,
    plotM2: null,
    geo: null,
    cover: null,
    imageCount: 0,
    developmentId: null,
    title,
    slug: 'villa',
    textLocale: null,
    description,
    metaTitle: null,
    metaDescription: null,
    terraceM2: null,
    yearBuilt: 2010,
    priceToCents: null,
    communityFeeMonthCents: null,
    ibiYearCents: null,
    garbageTaxYearCents: null,
    energyRating: 'B',
    energyEmissionsRating: null,
    features: [],
    media: [],
  };
}

/** A network listing whose text plants the owner's contacts (fixture #3) and an indirect mention, with cached removals. */
function scene() {
  const f = sanitizerFixture(3);
  const matcher = compileOwner(f.identity);
  const doc = detail(TARGET, f.ref, `Villa by ${f.owner.name}`, f.description, 45_000_000);
  const indirect = f.indirect.map((i) => i.sentence);
  const view: websites.SiteView = {
    site: { agencyId: AGENCY, referencePrefix: null },
    presenter: PRESENTER,
    mediaBaseUrl: 'https://media.example',
    owners: new Map([[OWNER, f.identity]]),
    matchers: new Map([[OWNER, matcher]]),
    // The model pass's cached removals of the description (S12-03), by target, then source text key.
    aiRemovals: new Map([[TARGET, new Map([[textKey(plainText(f.description)), indirect]])]]),
  };
  const rows: SelectionDocRow[] = [
    {
      targetId: TARGET,
      ownerAgencyId: OWNER,
      publicCode: 'AB12CD34',
      developmentCode: null,
      developmentOwnRef: null,
      doc,
    },
    {
      targetId: OWN_TARGET,
      ownerAgencyId: AGENCY,
      publicCode: 'ZZ99ZZ99',
      developmentCode: null,
      developmentOwnRef: null,
      doc: detail(OWN_TARGET, 'OWN-1', 'Our own villa', 'Call us on +34 600 000 001.', 30_000_000),
    },
  ];
  const selection = {
    id: '01900000-0000-7000-8000-0000000000e1',
    agencyId: AGENCY,
    title: '<b>Villas</b> for Ana',
    message: 'Hi Ana, here are my picks.',
    locale: 'en',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    items: [
      {
        targetId: TARGET,
        position: 0,
        titleOverride: `Sea-view villa (${f.owner.email})`,
        note: `Ask ${f.owner.name} nothing: call me. ${f.owner.phone}`,
      },
      { targetId: OWN_TARGET, position: 1, titleOverride: null, note: 'Our own, <i>keys</i> at the office' },
      { targetId: GONE_TARGET, position: 2, titleOverride: null, note: null },
    ],
  };
  return { f, view, rows, selection };
}

describe('selections (S12-04)', () => {
  it('[S12-04] the page white-labels a network listing: no owner name, contact, reference or indirect mention; facts kept', () => {
    const { f, view, rows, selection } = scene();
    const model = presentSelection({ selection, locale: 'en', view, rows });
    const network = model.items[0];
    expect(network?.detail).not.toBeNull();
    // The site's (agency's) reference and presenter, never the owner's.
    expect(network?.detail?.ref).toBe('W-AB12CD34');
    expect(network?.detail?.agency.name).toBe('Presenting Homes');
    expect(whiteLabelLeaks(model, { ...f.owner, agencyId: OWNER })).toEqual([]);
    const description = network?.detail?.description ?? '';
    expect(fixtureLeaks(f, description, { indirect: true })).toEqual([]);
    expect(missingFacts(f, description)).toEqual([]);
    // The agent's title and note for the item are white-labelled too (escaped when rendered: plain text here).
    expect(network?.detail?.title).toBe('Sea-view villa ()');
    expect(network?.note).not.toMatch(new RegExp(f.owner.name, 'i'));
    expect((network?.note ?? '').replace(/\D/g, '')).not.toContain(f.owner.phoneDigits);
  });

  it('[S12-04] own listings keep their text; texts are plain (no HTML); a listing no longer public is unavailable', () => {
    const { view, rows, selection } = scene();
    const model = presentSelection({ selection, locale: 'en', view, rows });
    expect(model.title).toBe('Villas for Ana');
    const own = model.items[1];
    expect(own?.detail?.ref).toBe('OWN-1');
    expect(own?.detail?.description).toBe('Call us on +34 600 000 001.');
    expect(own?.note).toBe('Our own, keys at the office');
    expect(model.items[2]).toEqual({ targetId: GONE_TARGET, position: 2, note: null, detail: null });
    expect(model.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('[S12-04] prices and status come from the documents as read (a changed read model shows on the next view)', () => {
    const { view, rows, selection } = scene();
    const before = presentSelection({ selection, locale: 'en', view, rows });
    expect(before.items[0]?.detail?.price.amountCents).toBe(45_000_000);
    const repriced = rows.map((r) =>
      r.targetId === TARGET
        ? {
            ...r,
            doc: {
              ...(r.doc as ListingDetailDoc),
              price: { ...(r.doc as ListingDetailDoc).price, amountCents: 39_900_000 },
              status: 'UNDER_OFFER',
            },
          }
        : r,
    );
    const after = presentSelection({ selection, locale: 'en', view, rows: repriced });
    expect(after.items[0]?.detail?.price.amountCents).toBe(39_900_000);
    expect(after.items[0]?.detail?.status).toBe('UNDER_OFFER');
  });

  it('[S12-04] share links: the page URL, a WhatsApp deep link and a mailto with the title, message and URL', () => {
    const token = 'a'.repeat(43);
    expect(SELECTION_TOKEN.test(token)).toBe(true);
    const links = shareLinks({
      token,
      title: 'Villas for Ana',
      message: 'Hi Ana & co',
      base: 'https://sites.example',
      phone: '+34 600 11 22 33',
      email: 'ana@client.example',
    });
    expect(links.url).toBe(`https://sites.example/s/${token}`);
    expect(links.whatsappUrl).toBe(
      `https://wa.me/34600112233?text=${encodeURIComponent(`Villas for Ana\n\nHi Ana & co\n\nhttps://sites.example/s/${token}`)}`,
    );
    expect(links.emailUrl).toMatch(/^mailto:ana%40client\.example\?subject=Villas%20for%20Ana&body=/);
    // No contact: the pickers; no configured host: the path only.
    expect(shareLinks({ token, title: 'T', message: null, base: 'https://sites.example' }).whatsappUrl).toMatch(
      /^https:\/\/wa\.me\/\?text=/,
    );
    expect(shareLinks({ token, title: 'T', message: null, base: null })).toEqual({
      token,
      path: `/s/${token}`,
      url: null,
      whatsappUrl: null,
      emailUrl: null,
    });
    // A crafted e-mail cannot add mailto headers.
    expect(
      shareLinks({ token, title: 'T', message: null, base: 'https://s.example', email: 'a@b.example?bcc=x@y' })
        .emailUrl,
    ).toMatch(/^mailto:\?subject=/);
  });

  it('[S12-04] expiry: a selection past its date or revoked is no longer live', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(statusOf({ revokedAt: null, expiresAt: new Date('2026-07-01T00:00:00Z') }, now)).toBe('LIVE');
    expect(statusOf({ revokedAt: null, expiresAt: new Date('2026-05-31T23:59:59Z') }, now)).toBe('EXPIRED');
    expect(statusOf({ revokedAt: new Date('2026-05-01T00:00:00Z'), expiresAt: null }, now)).toBe('REVOKED');
    expect(statusOf({ revokedAt: null, expiresAt: null }, now)).toBe('LIVE');
  });

  it('[S12-04] form actions become interactions; tokens are stored as keyed hashes only', () => {
    expect(interactionOf({ action: 'like', item: TARGET })).toEqual({ kind: 'LIKE', targetId: TARGET });
    expect(interactionOf({ action: 'unlike', item: TARGET })).toEqual({ kind: 'UNLIKE', targetId: TARGET });
    expect(interactionOf({ action: 'enquire', message: 'Can I visit?' })).toEqual({
      kind: 'ENQUIRE',
      message: 'Can I visit?',
    });
    configurePresentations({ tokenKey: 'test-hmac-key-0123456789abcdef0123456789' });
    const token = 'b'.repeat(43);
    expect(selectionTokenHash(token)).not.toContain(token);
    expect(selectionTokenHash(token)).toBe(selectionTokenHash(token));
  });
});
