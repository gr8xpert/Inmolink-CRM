import {
  type ListingCardDoc,
  type ListingDetailDoc,
  type ReadModelImage,
  type UnitCardDoc,
  type UnitDetailDoc,
  WebsiteCard,
  WebsiteDetail,
  type WebsitePresenter,
} from '@inmolink/contracts';
import { describe, expect, it } from 'vitest';
import {
  deterministicSanitizer,
  networkRefPrefix,
  type Owned,
  plainText,
  type SiteView,
  serializeCards,
  serializeDetail,
  siteScopedId,
  slugOf,
} from '../serializer';

/**
 * Website serializer (S7-02): a property-based check over generated fixtures — owner documents with the owner's
 * name, phone numbers and e-mail planted in every text field (and stray owner/commission fields on the objects) —
 * that what a site serves for a network listing names none of them, and parses as the strict website shapes.
 */

/** Seeded PRNG (mulberry32): reproducible fixtures; the failing seed is in the assertion message. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const digits = (n: number) => Array.from({ length: n }, () => String(int(0, 9))).join('');
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  return { next, int, pick, digits, uuid };
}
type Rng = ReturnType<typeof rng>;

const NAMES = [
  'Costa Dreams Realty',
  'Marbella Prime Homes',
  'Sol Y Mar Inmobiliaria',
  'Andalucía Estates',
  'Blue Bay Properties',
];
const WORDS = [
  'villa',
  'sea views',
  'pool',
  'garden',
  'terrace',
  'luxury',
  'quiet',
  'Costa del Sol',
  'near the beach',
  '3 bedrooms',
];

interface Owner {
  agencyId: string;
  name: string;
  phone: string;
  phoneDigits: string;
  email: string;
  domain: string;
  commission: string;
  /** The owner's own reference of the listing. */
  ref: string;
}

function ownerOf(r: Rng): Owner {
  const name = r.pick(NAMES);
  const local = r.pick(['6', '7', '9']) + r.digits(8);
  const formats = [
    `+34 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`,
    `${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7)}`,
    local,
    `0034 ${local}`,
    `(+34) ${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`,
    // Dotted groups of three: not a price (review S7-02).
    `${local.slice(0, 3)}.${local.slice(3, 6)}.${local.slice(6)}`,
    `+34 ${local.slice(0, 3)}.${local.slice(3, 6)}.${local.slice(6)}`,
  ];
  const domain = `${name.toLowerCase().replace(/[^a-z]+/g, '')}.${r.pick(['com', 'es', 'eu'])}`;
  return {
    agencyId: r.uuid(),
    name,
    phone: r.pick(formats),
    phoneDigits: local,
    ref: Array.from({ length: 8 }, () => r.pick([...'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'])).join(''),
    email: `${r.pick(['info', 'sales', 'ventas'])}@${domain}`,
    domain,
    commission: `${r.int(1, 8)}%`,
  };
}

/** Free text with the owner's details planted anywhere (in any case, with or without HTML). */
function ownerText(r: Rng, o: Owner): string {
  const parts: string[] = [];
  for (let i = r.int(3, 9); i > 0; i--) parts.push(r.pick(WORDS));
  const plants = [
    o.name,
    o.name.toUpperCase(),
    `Call ${o.phone}`,
    `Mail ${o.email}`,
    `https://www.${o.domain}/listing/123`,
    `www.${o.domain}`,
    `Visit ${o.domain}.`,
    `<a href="mailto:${o.email}">${o.name}</a>`,
    `<b>${o.phone}</b>`,
    `Price 1.250.000 € — ${o.name} (${o.phone})`,
    `Ref. ${o.ref}`,
    `reference: ${o.ref.toLowerCase()}`,
    `&lt;b&gt;${o.name}&lt;/b&gt;`,
    o.name.replace(/ /g, '&nbsp;'),
    `Mail ${o.email.replace('@', '&#64;')}`,
  ];
  for (let i = r.int(1, 4); i > 0; i--) parts.splice(r.int(0, parts.length), 0, r.pick(plants));
  return parts.join(r.pick([' ', ', ', '. ', '\n']));
}

const taxon = (r: Rng) => ({ id: r.uuid(), name: r.pick(['Villa', 'Apartment']), slug: 'villa' });

function image(r: Rng, o: Owner, cover: boolean): ReadModelImage {
  return {
    kind: 'IMAGE',
    cover,
    alt: r.next() < 0.5 ? ownerText(r, o) : null,
    room: null,
    width: 1600,
    height: 1200,
    variants: { thumb: `v1/${r.digits(6)}/thumb.webp`, large: `v1/${r.digits(6)}/large.webp` },
  };
}

/** Stray fields a buggy read model might carry: the serializer copies by name, so they never reach a site. */
const stray = (o: Owner) => ({
  commissionBp: 300,
  commission: o.commission,
  ownerAgencyId: o.agencyId,
  ownerAgencyName: o.name,
  agencyPhone: o.phone,
  agencyEmail: o.email,
});

function listingDetail(r: Rng, o: Owner): ListingDetailDoc {
  const id = r.uuid();
  return {
    kind: 'LISTING',
    id,
    ref: o.ref,
    status: 'ACTIVE',
    transactionType: 'SALE',
    price: { amountCents: r.int(10_000_000, 900_000_000), currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon(r),
    place: { country: taxon(r), region: null, city: null, area: null },
    bedrooms: r.int(1, 6),
    bathrooms: r.int(1, 4),
    builtM2: r.int(50, 600),
    plotM2: null,
    geo: { lat: 36.5, lng: -4.9, precision: 'APPROX' },
    cover: image(r, o, true),
    imageCount: 3,
    developmentId: null,
    title: ownerText(r, o),
    slug: slugOf(ownerText(r, o), id),
    textLocale: null,
    description: ownerText(r, o),
    metaTitle: ownerText(r, o),
    metaDescription: ownerText(r, o),
    terraceM2: null,
    yearBuilt: 2010,
    energyRating: 'B',
    energyEmissionsRating: null,
    features: [taxon(r)],
    media: [image(r, o, true), image(r, o, false), { kind: 'VIDEO', provider: 'youtube', id: `${o.name}-tour` }],
    ...stray(o),
  } as ListingDetailDoc;
}

function unitDetail(r: Rng, o: Owner): UnitDetailDoc {
  const developmentId = r.uuid();
  return {
    kind: 'UNIT',
    id: r.uuid(),
    ref: o.ref,
    status: 'AVAILABLE',
    price: { amountCents: r.int(10_000_000, 900_000_000), currency: 'EUR', period: null, onRequest: false },
    propertyType: taxon(r),
    place: { country: taxon(r), region: null, city: null, area: null },
    bedrooms: 2,
    bathrooms: 2,
    internalM2: 90,
    terraceM2: 20,
    plotM2: null,
    floor: 2,
    orientation: 'S',
    geo: null,
    development: { id: developmentId, name: ownerText(r, o), status: 'OFF_PLAN', completionDate: null },
    title: ownerText(r, o),
    slug: 'owner-slug',
    textLocale: null,
    description: ownerText(r, o),
    paymentTerms: ownerText(r, o),
    metaTitle: ownerText(r, o),
    metaDescription: null,
    phase: { name: ownerText(r, o), status: 'OFF_PLAN', completionDate: null },
    ...stray(o),
  } as UnitDetailDoc;
}

const cardOf = (d: ListingDetailDoc | UnitDetailDoc): ListingCardDoc | UnitCardDoc => {
  if (d.kind === 'LISTING') {
    const {
      description: _d,
      metaTitle: _m,
      metaDescription: _md,
      terraceM2: _t,
      yearBuilt: _y,
      energyRating: _e,
      energyEmissionsRating: _ee,
      features: _f,
      media: _me,
      ...card
    } = d;
    return card;
  }
  const { description: _d, paymentTerms: _p, metaTitle: _m, metaDescription: _md, phase: _ph, ...card } = d;
  return card;
};

const SITE_AGENCY = '01900000-0000-7000-8000-0000000000aa';
const PRESENTER: WebsitePresenter = {
  name: 'Presenting Agency',
  email: 'hello@presenting.example',
  phone: '+34 600 000 001',
  whatsapp: null,
  website: 'https://presenting.example',
  primaryColor: '#112233',
  accentColor: null,
};

/** Every string anywhere in a value (keys included). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

function assertWhiteLabelled(out: unknown, o: Owner, label: string): void {
  const all = strings(out);
  const text = all.join('\n');
  const lower = text.toLowerCase();
  expect(lower.includes(o.name.toLowerCase()), `${label}: owner name`).toBe(false);
  expect(lower.includes(o.email.toLowerCase()), `${label}: owner e-mail`).toBe(false);
  expect(lower.includes(o.domain.toLowerCase()), `${label}: owner domain`).toBe(false);
  expect(text.includes(o.phone), `${label}: owner phone`).toBe(false);
  expect(lower.includes(o.ref.toLowerCase()), `${label}: owner reference`).toBe(false);
  // The phone's digits in any spacing within one string.
  for (const s of all)
    expect(s.replace(/\D/g, '').includes(o.phoneDigits), `${label}: owner phone digits in "${s}"`).toBe(false);
  expect(
    all.some((s) => /commission|owner/i.test(s)),
    `${label}: commission or owner field`,
  ).toBe(false);
  expect(text.includes(o.commission) && /commission/i.test(text), `${label}: commission`).toBe(false);
}

const RUNS = 300;

describe('website serializer (S7-02)', () => {
  it('[S7-02] serialized network listings contain no owner agency name, phone, email or commission (property-based)', () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = rng(seed);
      const o = ownerOf(r);
      const view: SiteView = {
        site: { agencyId: SITE_AGENCY, referencePrefix: r.next() < 0.5 ? 'CH' : null },
        presenter: PRESENTER,
        mediaBaseUrl: 'https://cdn.example/media/',
        owners: new Map([[o.agencyId, { names: [o.name], emails: [o.email], phones: [o.phone], hosts: [o.domain] }]]),
        // Overrides typed by the presenting agency may quote the owner too: they pass the same sanitizer.
        overrides: r.next() < 0.5 ? { targets: new Map(), developments: new Map() } : undefined,
      };
      const detail = r.next() < 0.6 ? listingDetail(r, o) : unitDetail(r, o);
      if (view.overrides && r.next() < 0.5) {
        (view.overrides.targets as Map<string, { title: string | null; description: string | null }>).set(detail.id, {
          title: r.next() < 0.5 ? ownerText(r, o) : null,
          description: ownerText(r, o),
        });
      }
      const publicCode = r.next() < 0.8 ? 'AB12CD34' : null;
      const item: Owned<ListingDetailDoc | UnitDetailDoc> = { ownerAgencyId: o.agencyId, publicCode, doc: detail };
      const served = serializeDetail(view, item);
      const cards = serializeCards(view, [{ ownerAgencyId: o.agencyId, publicCode, doc: cardOf(detail) }]);
      const label = `seed ${seed}`;
      // Strict shapes: no field outside the website contract (owner, commission, …).
      expect(WebsiteDetail.safeParse(served).success, label).toBe(true);
      for (const c of cards) expect(WebsiteCard.safeParse(c).success, label).toBe(true);
      assertWhiteLabelled(served, o, `${label} detail`);
      assertWhiteLabelled(cards, o, `${label} card`);
      // The presenting agency's contacts, the site's reference prefix, no videos.
      expect(served.agency).toEqual(PRESENTER);
      // The site's prefix and the target's public code — never the owner's own reference.
      if (publicCode) expect(served.ref).toBe(`${networkRefPrefix(view.site)}-${publicCode}`);
      else expect(served.ref).toMatch(new RegExp(`^${networkRefPrefix(view.site)}-[0-9A-Z]{8}$`));
      expect(cards[0]?.ref).toBe(served.ref);
      if (served.kind === 'LISTING') expect(served.media.some((m) => m.kind === 'VIDEO')).toBe(false);
    }
  });

  it("[S7-02] the agency's own listings keep their reference, text and videos (plain text only)", () => {
    const r = rng(7);
    const o = ownerOf(r);
    const view: SiteView = {
      site: { agencyId: o.agencyId, referencePrefix: 'CH' },
      presenter: PRESENTER,
      mediaBaseUrl: 'https://cdn.example/media',
    };
    const detail = listingDetail(r, o);
    detail.title = 'Villa <script>alert(1)</script> with pool';
    detail.description = `Call ${o.phone}`;
    const served = serializeDetail(view, { ownerAgencyId: o.agencyId, publicCode: 'AB12CD34', doc: detail });
    expect(served.ref).toBe(detail.ref);
    expect(served.title).toBe('Villa alert(1) with pool');
    expect(served.description).toBe(`Call ${o.phone}`);
    if (served.kind !== 'LISTING') throw new Error('a listing');
    expect(served.media.filter((m) => m.kind === 'VIDEO')).toHaveLength(1);
    expect(served.cover?.urls.thumb).toMatch(/^https:\/\/cdn\.example\/media\/v1\/\d+\/thumb\.webp$/);
  });

  it('[S7-02] text precedence: override > site content > owner text, field by field; overrides are never HTML', () => {
    const r = rng(11);
    const o = ownerOf(r);
    const detail = listingDetail(r, o);
    detail.title = 'Owner title';
    detail.description = 'Owner description';
    const base: SiteView = {
      site: { agencyId: SITE_AGENCY, referencePrefix: null },
      presenter: PRESENTER,
      mediaBaseUrl: 'https://cdn.example',
    };
    const item = { ownerAgencyId: o.agencyId, publicCode: 'AB12CD34', doc: detail };
    const owner = serializeDetail(base, item);
    expect([owner.title, owner.description]).toEqual(['Owner title', 'Owner description']);
    expect(owner.ref).toBe('W-AB12CD34');
    const withContent: SiteView = {
      ...base,
      siteContent: new Map([[detail.id, { title: 'Site title', description: null }]]),
    };
    expect(serializeDetail(withContent, item)).toMatchObject({ title: 'Site title', description: 'Owner description' });
    const overridden: SiteView = {
      ...withContent,
      overrides: {
        targets: new Map([[detail.id, { title: null, description: '<img src=x onerror=alert(1)>Our <b>words</b>' }]]),
        developments: new Map(),
      },
    };
    const served = serializeDetail(overridden, item);
    expect(served).toMatchObject({ title: 'Site title', description: 'Our words', metaDescription: 'Our words' });
    expect(served.slug).toBe('site-title');
  });

  it('[S7-02] duplicate clusters serve only their canonical listing (hook; every listing until R2 dedupe)', () => {
    const r = rng(13);
    const o = ownerOf(r);
    const [a, b] = [listingDetail(r, o), listingDetail(r, o)].map(cardOf) as [ListingCardDoc, ListingCardDoc];
    const view: SiteView = {
      site: { agencyId: SITE_AGENCY, referencePrefix: 'CH' },
      presenter: PRESENTER,
      mediaBaseUrl: 'https://cdn.example',
    };
    const items = [a, b].map((doc) => ({ ownerAgencyId: o.agencyId, publicCode: null, doc }));
    // Network documents carry ids scoped to the site's agency (S7-03).
    const shown = (id: string) => siteScopedId(SITE_AGENCY, id);
    expect(serializeCards(view, items).map((c) => c.id)).toEqual([shown(a.id), shown(b.id)]);
    const clustered = { ...view, canonicalOf: (id: string) => (id === b.id ? a.id : null) };
    expect(serializeCards(clustered, items).map((c) => c.id)).toEqual([shown(a.id)]);
  });

  it('[S7-02] the deterministic sanitizer keeps facts: prices, areas, years', () => {
    const text = 'Price 1.250.000 €, 250 m2, built 2015, 3 bedrooms. Call +34 952 123 456 or ventas@agency.es';
    const none = { names: [], emails: [], phones: [], hosts: [], ownerRefs: [] };
    expect(deterministicSanitizer(text, none)).toBe('Price 1.250.000 €, 250 m2, built 2015, 3 bedrooms. Call or');
    expect(plainText('a <p>b</p>  c')).toBe('a b c');
    // Character references are decoded first, so an encoded tag goes too; the result is text, not HTML.
    expect(plainText('&lt;script&gt;alert(1)&lt;/script&gt; Villa &amp; pool &#8364;')).toBe('alert(1) Villa & pool €');
    // Dotted Spanish numbers are phones; grouped prices stay.
    expect(deterministicSanitizer('Tel 952.123.456, price 950.000', none)).toBe('Tel, price 950.000');
    // The owner's names (with and without the legal form), contacts, website and own reference.
    const owner = {
      names: ['Costa Homes S.L.', 'Costa Homes'],
      emails: ['info@costahomes.es'],
      phones: ['+34 600 111 222'],
      hosts: ['costahomes.es'],
      ownerRefs: ['AB12CD34'],
    };
    expect(
      deterministicSanitizer(
        'Costa Homes S.L. (Ref. AB12CD34) on Costa Homes: 600-111-222, costahomes.es/villa',
        owner,
      ),
    ).toBe('() on:,');
  });
});
