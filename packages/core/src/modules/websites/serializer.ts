/**
 * Website serializer (S7-02, PLAN §3 #6 #54, §9.1, ADR 0012 #3): read-model documents as one site serves them,
 * white-labelled to the site's agency. The only place the website API applies white-labelling (api rules):
 *
 * - **Network documents** (another agency owns them) carry `<site prefix>-<public code>` as their reference (an opaque
 *   code per target, `listing_public_codes` — never the owner's own reference; the form website search matches,
 *   `networkRefPrefix`), the presenting agency's contacts (`agency`), owner text passed through the white-label
 *   sanitizer (S12-03 hook; a deterministic pass until then, told the owner's identity), a slug made from the shown
 *   title, and no videos (a video may show its owner). Read models hold no owner, contact or commission field
 *   (strict shapes), so nothing else can name the owner.
 * - **Text precedence** (PLAN §9.6): the site agency's override (S3-10) > the site's own content (R2 unique site
 *   content: a hook, empty in R1) > the owner's text, field by field. Overrides are the site agency's own: the caller
 *   reads them for the site's agency only (`properties.siteOverrides`), so another site never sees them.
 * - **Plain text only:** every text has its character references decoded and loses HTML tags (overrides and site content are agency input shown on other
 *   agencies' and public pages, S5-F1); consumers render texts escaped.
 * - **Duplicate clusters:** one canonical listing per cluster (`canonicalOf`, R2 dedupe; no-op until then).
 *
 * Pure functions: the caller (feed-api, S7-03) reads the documents and public codes, the site's overrides and the
 * owners' identities.
 */
import { createHash } from 'node:crypto';
import type {
  ListingCardDoc,
  ListingDetailDoc,
  ReadModelImage,
  ReadModelMedia,
  UnitCardDoc,
  UnitDetailDoc,
  WebsiteCard,
  WebsiteDetail,
  WebsiteDevelopmentCard,
  WebsiteDevelopmentDetail,
  WebsiteImage,
  WebsiteListingCard,
  WebsiteListingDetail,
  WebsiteMedia,
  WebsitePresenter,
  WebsiteUnitCard,
  WebsiteUnitDetail,
} from '@inmolink/contracts';
import {
  deterministicSanitizer,
  NO_OWNER,
  type OwnerIdentity,
  type OwnerMatcher,
  plainText,
  type SanitizeContext,
  type TextSanitizer,
} from '../../white-label';

/**
 * Prefix of network references on a site without its own (`website_sites.reference_prefix`): network documents
 * always carry one, so a visitor never sees — nor finds by — the owner's own reference.
 */
export const DEFAULT_NETWORK_REF_PREFIX = 'W';

/** The prefix network documents carry on a site (serializer and website search alike). */
export const networkRefPrefix = (site: { referencePrefix: string | null }): string =>
  site.referencePrefix ?? DEFAULT_NETWORK_REF_PREFIX;

/** A text field pair an agency overrides, or the site's own content gives (null: keep the next in precedence). */
export interface SiteText {
  title: string | null;
  description: string | null;
}

/** The site agency's overrides (`properties.siteOverrides`): listings and units by id, developments by id. */
export interface SiteOverrideTexts {
  targets: ReadonlyMap<string, SiteText>;
  developments: ReadonlyMap<string, SiteText>;
}

export type { OwnerIdentity, SanitizeContext, TextSanitizer };
export { deterministicSanitizer, plainText };

/** How one site presents documents. */
export interface SiteView {
  site: { agencyId: string; referencePrefix: string | null };
  /** The presenting agency (`sitePresenter`). */
  presenter: WebsitePresenter;
  /** Media CDN base URL (config): image variant keys are served under it. */
  mediaBaseUrl: string;
  overrides?: SiteOverrideTexts;
  /** R2 unique site content (PLAN §9.6), by target id: none in R1. */
  siteContent?: ReadonlyMap<string, SiteText>;
  /** Owner agencies' identities (`agencies.ownerIdentities`), removed from network documents' text. */
  owners?: ReadonlyMap<string, OwnerIdentity>;
  /**
   * The same identities compiled once (`compileOwner`, S7-03: per owner per process, not per text): used by the
   * deterministic pass instead of `owners` when no other `sanitize` is given.
   */
  matchers?: ReadonlyMap<string, OwnerMatcher>;
  sanitize?: TextSanitizer;
  /** R2 duplicate clusters: a target's canonical target, or null when it is its own (no-op until R2 dedupe). */
  canonicalOf?: (targetId: string) => string | null;
}

/** A read-model document with its owner (the read model row's `agency_id`) and public code (`search.publicCodes`). */
export interface Owned<D> {
  ownerAgencyId: string;
  /**
   * The target's opaque public code (`listing_public_codes`): a network document's reference is `<prefix>-<code>`,
   * never the owner's own. Null before the target's first rebuild with S7-02: a code derived from the id is shown
   * (not searchable until the rebuild).
   */
  publicCode: string | null;
  /**
   * The public code of the document's development (S7-F6): its reference on another agency's site
   * (`<prefix>-<code>`); null or absent when it has none yet.
   */
  developmentCode?: string | null;
  /**
   * The developer's own reference of the document's development (S7-F6): its reference on the owner's sites, and
   * removed from network text by the sanitizer. Null or absent when unknown.
   */
  developmentOwnRef?: string | null;
  doc: D;
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A slug from a shown title (network documents: the owner's slug may carry the owner's text). */
export function slugOf(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** At most `max` characters, cut at a word boundary, never inside a surrogate pair. */
export function excerpt(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join('');
  const space = cut.search(/\s\S*$/);
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}

// ── Documents ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One document's text rules on this site. */
interface TextRules {
  network: boolean;
  /** Owner text, plain and (network) sanitized; null stays null. */
  owner(text: string | null): string | null;
  /** The first non-null of override, site content, owner text — always plain and (network) sanitized. */
  pick(field: 'title' | 'description', texts: (SiteText | undefined)[], owner: string | null): string | null;
}

function rulesFor(
  view: SiteView,
  item: Pick<Owned<{ ref: string }>, 'ownerAgencyId' | 'doc' | 'developmentOwnRef'>,
): TextRules {
  const network = item.ownerAgencyId !== view.site.agencyId;
  const matcher = view.sanitize ? undefined : view.matchers?.get(item.ownerAgencyId);
  const sanitize: TextSanitizer = matcher
    ? (text, c) => matcher.clean(text, c.ownerRefs)
    : (view.sanitize ?? deterministicSanitizer);
  // The owner's own references: the document's, and its development's (S7-F6) — never left in owner text.
  const context: SanitizeContext = {
    ...(matcher?.identity ?? view.owners?.get(item.ownerAgencyId) ?? NO_OWNER),
    ownerRefs: item.developmentOwnRef ? [item.doc.ref, item.developmentOwnRef] : [item.doc.ref],
  };
  const clean = (text: string) => (network ? sanitize(plainText(text), context) : plainText(text));
  return {
    network,
    owner: (text) => (text === null ? null : clean(text)),
    pick: (field, texts, owner) => {
      for (const t of texts) {
        const v = t?.[field];
        if (v !== null && v !== undefined && v.trim() !== '') return clean(v);
      }
      return owner === null ? null : clean(owner);
    },
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A code from the target id, shown until the target's public code exists (never the owner's reference). */
function interimCode(targetId: string): string {
  const bytes = createHash('sha256').update(`public-code:${targetId}`).digest();
  return Array.from(bytes.subarray(0, 8), (b) => CROCKFORD[b & 31]).join('');
}

/** The reference a site shows: its own documents' as they are, network ones `<prefix>-<public code>`. */
const refOn = (view: SiteView, item: Owned<{ id: string; ref: string }>, network: boolean) =>
  network ? `${networkRefPrefix(view.site)}-${item.publicCode ?? interimCode(item.doc.id)}` : item.doc.ref;

/**
 * The reference a site shows for a target (S7-03: changes, sitemap): the owner's own on the owner's sites, else
 * `<prefix>-<public code>` — the serializer's rule, for rows that are not documents.
 */
export function siteRef(
  site: SiteView['site'],
  item: { targetId: string; ownerAgencyId: string; ref: string; publicCode: string | null },
): string {
  return item.ownerAgencyId === site.agencyId
    ? item.ref
    : `${networkRefPrefix(site)}-${item.publicCode ?? interimCode(item.targetId)}`;
}

/**
 * The id a site shows for another agency's listing, unit or development (S7-03): a UUID derived from the site's agency
 * and the real id, so two sites presenting the same network listing cannot be matched by its id (references are
 * per-site codes already). Stable for one agency; not reversible. Own documents keep their ids.
 */
export function siteScopedId(siteAgencyId: string, id: string): string {
  const h = createHash('sha256').update(`site-id:${siteAgencyId}:${id}`).digest();
  // RFC 9562 version 8 (custom) with the RFC variant bits.
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A development as references name it: its public code and its developer's own reference. */
export interface DevelopmentNames {
  code: string | null | undefined;
  ownRef: string | null | undefined;
}

/**
 * A development's reference on a site (S7-F6), like a listing's: the developer's own reference on the owner's sites,
 * `<prefix>-<public code>` on everyone else's — so the owner's site and a network site never share a reference a buyer
 * could take from one to the other. Null: not known yet (before the deploy's rebuild).
 */
export function developmentRef(site: SiteView['site'], ownerAgencyId: string, names: DevelopmentNames): string | null {
  if (ownerAgencyId === site.agencyId) return names.ownRef ?? null;
  return names.code ? `${networkRefPrefix(site)}-${names.code}` : null;
}

/** `developmentRef` where the development is known to have its names (development rows always do). */
function knownDevelopmentRef(site: SiteView['site'], ownerAgencyId: string, names: DevelopmentNames): string {
  const ref = developmentRef(site, ownerAgencyId, names);
  if (ref === null) throw new Error('websites: a development row without its reference');
  return ref;
}

/** The id shown: own documents' as they are, network ones scoped to the site's agency. */
const idOn = (view: SiteView, id: string, network: boolean) => (network ? siteScopedId(view.site.agencyId, id) : id);

function imageOf(view: SiteView, image: ReadModelImage, rules: TextRules): WebsiteImage {
  const base = view.mediaBaseUrl.replace(/\/+$/, '');
  const urls: WebsiteImage['urls'] = {};
  for (const [size, key] of Object.entries(image.variants)) {
    if (key) urls[size as keyof WebsiteImage['urls']] = `${base}/${key}`;
  }
  return {
    kind: image.kind,
    cover: image.cover,
    alt: rules.owner(image.alt),
    room: image.room,
    width: image.width,
    height: image.height,
    urls,
  };
}

function mediaOf(view: SiteView, items: readonly ReadModelMedia[], rules: TextRules): WebsiteMedia[] {
  return items.flatMap((m): WebsiteMedia[] => {
    if (m.kind === 'VIDEO') return rules.network ? [] : [{ kind: 'VIDEO', provider: m.provider, id: m.id }];
    return [imageOf(view, m, rules)];
  });
}

/** The texts above the owner's for a target (and, for units, its development's override). */
function textsFor(view: SiteView, targetId: string, developmentId: string | null, network: boolean): SiteText[] {
  const out: SiteText[] = [];
  // Overrides are for documents the agency presents but does not own (S3-10).
  if (network) {
    const own = view.overrides?.targets.get(targetId);
    if (own) out.push(own);
    const dev = developmentId ? view.overrides?.developments.get(developmentId) : undefined;
    if (dev) out.push(dev);
  }
  const content = view.siteContent?.get(targetId);
  if (content) out.push(content);
  return out;
}

const overriddenTitle = (texts: SiteText[]) => texts.some((t) => t.title !== null && t.title.trim() !== '');
const overriddenDescription = (texts: SiteText[]) =>
  texts.some((t) => t.description !== null && t.description.trim() !== '');

const META_DESCRIPTION_CHARS = 160;

function listingCard(view: SiteView, item: Owned<ListingCardDoc>): WebsiteListingCard {
  const d = item.doc;
  const rules = rulesFor(view, item);
  const texts = textsFor(view, d.id, null, rules.network);
  const title = rules.pick('title', texts, d.title) ?? '';
  const shownRef = refOn(view, item, rules.network);
  const shownId = idOn(view, d.id, rules.network);
  return {
    kind: 'LISTING',
    id: shownId,
    ref: shownRef,
    status: d.status,
    transactionType: d.transactionType,
    price: d.price,
    propertyType: d.propertyType,
    place: d.place,
    bedrooms: d.bedrooms,
    bathrooms: d.bathrooms,
    builtM2: d.builtM2,
    plotM2: d.plotM2,
    geo: d.geo,
    cover: d.cover ? imageOf(view, d.cover, rules) : null,
    imageCount: d.imageCount,
    developmentId: d.developmentId === null ? null : idOn(view, d.developmentId, rules.network),
    developmentRef:
      d.developmentId === null
        ? null
        : developmentRef(view.site, item.ownerAgencyId, { code: item.developmentCode, ownRef: item.developmentOwnRef }),
    title: title || shownRef,
    slug: rules.network ? slugOf(title, shownId) : d.slug,
    textLocale: overriddenTitle(texts) ? null : d.textLocale,
  };
}

function unitCard(view: SiteView, item: Owned<UnitCardDoc>): WebsiteUnitCard {
  const d = item.doc;
  const rules = rulesFor(view, item);
  const texts = textsFor(view, d.id, d.development.id, rules.network);
  const developmentName = rules.owner(d.development.name) ?? '';
  const title = rules.pick('title', texts, d.title) ?? '';
  const developmentId = idOn(view, d.development.id, rules.network);
  return {
    kind: 'UNIT',
    id: idOn(view, d.id, rules.network),
    ref: refOn(view, item, rules.network),
    status: d.status,
    price: d.price,
    propertyType: d.propertyType,
    place: d.place,
    bedrooms: d.bedrooms,
    bathrooms: d.bathrooms,
    internalM2: d.internalM2,
    terraceM2: d.terraceM2,
    plotM2: d.plotM2,
    floor: d.floor,
    orientation: d.orientation,
    geo: d.geo,
    development: {
      id: developmentId,
      ref: developmentRef(view.site, item.ownerAgencyId, {
        code: item.developmentCode,
        ownRef: item.developmentOwnRef,
      }),
      name: developmentName,
      status: d.development.status,
      completionDate: d.development.completionDate,
    },
    title: title || developmentName,
    slug: rules.network ? slugOf(title || developmentName, developmentId) : d.slug,
    textLocale: overriddenTitle(texts) ? null : d.textLocale,
  };
}

/** Meta texts: an overridden title or description replaces the owner's meta text with its own. */
function metaOf(
  rules: TextRules,
  texts: SiteText[],
  card: { title: string },
  description: string | null,
  owner: { metaTitle: string | null; metaDescription: string | null },
) {
  return {
    metaTitle: overriddenTitle(texts) ? card.title : rules.owner(owner.metaTitle),
    metaDescription:
      overriddenDescription(texts) && description !== null
        ? excerpt(description, META_DESCRIPTION_CHARS)
        : rules.owner(owner.metaDescription),
  };
}

function listingDetail(view: SiteView, item: Owned<ListingDetailDoc>): WebsiteListingDetail {
  const d = item.doc;
  const rules = rulesFor(view, item);
  const texts = textsFor(view, d.id, null, rules.network);
  const card = listingCard(view, item);
  const description = rules.pick('description', texts, d.description);
  return {
    ...card,
    description,
    ...metaOf(rules, texts, card, description, d),
    terraceM2: d.terraceM2,
    yearBuilt: d.yearBuilt,
    energyRating: d.energyRating,
    energyEmissionsRating: d.energyEmissionsRating,
    features: d.features,
    media: mediaOf(view, d.media, rules),
    agency: view.presenter,
  };
}

function unitDetail(view: SiteView, item: Owned<UnitDetailDoc>): WebsiteUnitDetail {
  const d = item.doc;
  const rules = rulesFor(view, item);
  const texts = textsFor(view, d.id, d.development.id, rules.network);
  const card = unitCard(view, item);
  const description = rules.pick('description', texts, d.description);
  return {
    ...card,
    description,
    paymentTerms: rules.owner(d.paymentTerms),
    ...metaOf(rules, texts, card, description, d),
    phase: d.phase ? { ...d.phase, name: rules.owner(d.phase.name) ?? '' } : null,
    agency: view.presenter,
  };
}

/** Only canonical documents of duplicate clusters (R2 dedupe; every document until then). */
function canonicalOnly<T extends { doc: { id: string } }>(view: SiteView, items: readonly T[]): T[] {
  const canonicalOf = view.canonicalOf;
  if (!canonicalOf) return [...items];
  return items.filter((i) => {
    const canonical = canonicalOf(i.doc.id);
    return canonical === null || canonical === i.doc.id;
  });
}

/** Search result cards as the site serves them, in order. */
export function serializeCards(view: SiteView, items: readonly Owned<ListingCardDoc | UnitCardDoc>[]): WebsiteCard[] {
  return canonicalOnly(view, items).map((item) =>
    item.doc.kind === 'LISTING'
      ? listingCard(view, item as Owned<ListingCardDoc>)
      : unitCard(view, item as Owned<UnitCardDoc>),
  );
}

/** A sitemap entry's shown parts (S7-F10 review): the reference, kind and slug a card would show. */
export interface SitemapEntryParts {
  ref: string;
  kind: 'LISTING' | 'UNIT';
  slug: string;
}

/**
 * Sitemap entries as the site serves them, in order (`/v2/sitemap`, S7-F10 review): the same reference and slug as
 * `serializeCards`, computed from the same rules — without the rest of each card (cover image, development block, the
 * owner sanitizer over every text). A 500-entry page spent ~40 ms serializing full cards for three fields each.
 */
export function serializeSitemapEntries(
  view: SiteView,
  items: readonly Owned<ListingCardDoc | UnitCardDoc>[],
): SitemapEntryParts[] {
  return canonicalOnly(view, items).map((item) => {
    const rules = rulesFor(view, item);
    if (item.doc.kind === 'LISTING') {
      const d = item.doc as ListingCardDoc;
      const ref = refOn(view, item, rules.network);
      if (!rules.network) return { ref, kind: 'LISTING', slug: d.slug };
      const title = rules.pick('title', textsFor(view, d.id, null, true), d.title) ?? '';
      return { ref, kind: 'LISTING', slug: slugOf(title, idOn(view, d.id, true)) };
    }
    const d = item.doc as UnitCardDoc;
    const ref = refOn(view, item, rules.network);
    if (!rules.network) return { ref, kind: 'UNIT', slug: d.slug };
    const developmentName = rules.owner(d.development.name) ?? '';
    const title = rules.pick('title', textsFor(view, d.id, d.development.id, true), d.title) ?? '';
    return { ref, kind: 'UNIT', slug: slugOf(title || developmentName, idOn(view, d.development.id, true)) };
  });
}

/** A development's unit table as the site serves it (S7-F6), in order. */
export function serializeUnitCards(view: SiteView, items: readonly Owned<UnitCardDoc>[]): WebsiteUnitCard[] {
  return canonicalOnly(view, items).map((item) => unitCard(view, item));
}

/** A detail page as the site serves it. */
export function serializeDetail(view: SiteView, item: Owned<ListingDetailDoc | UnitDetailDoc>): WebsiteDetail {
  return item.doc.kind === 'LISTING'
    ? listingDetail(view, item as Owned<ListingDetailDoc>)
    : unitDetail(view, item as Owned<UnitDetailDoc>);
}

// ── Developments (S7-F6) ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A development as a site lists it: aggregates over its units in the site's inventory (`search.developmentPage`) and
 * one of those units' document, which carries the development's texts, status and place.
 */
export interface DevelopmentItem<D extends UnitCardDoc> {
  developmentId: string;
  /** The development's public code: its reference on another agency's site is `<prefix>-<code>`. */
  code: string;
  /** The developer's own reference: its reference on the owner's sites. */
  ownRef: string | null;
  ownerAgencyId: string;
  total: number;
  available: number;
  reserved: number;
  priceMin: number | null;
  priceMax: number | null;
  bedsMin: number | null;
  bedsMax: number | null;
  doc: D;
}

/** The texts above the owner's for a development: the site agency's development override (network only). */
function developmentTexts(view: SiteView, developmentId: string, network: boolean): SiteText[] {
  const out: SiteText[] = [];
  const own = network ? view.overrides?.developments.get(developmentId) : undefined;
  if (own) out.push(own);
  const content = view.siteContent?.get(developmentId);
  if (content) out.push(content);
  return out;
}

function developmentCard(view: SiteView, item: DevelopmentItem<UnitCardDoc>): WebsiteDevelopmentCard {
  const d = item.doc;
  const rules = rulesFor(view, { ownerAgencyId: item.ownerAgencyId, doc: d, developmentOwnRef: item.ownRef });
  const texts = developmentTexts(view, item.developmentId, rules.network);
  const name = rules.owner(d.development.name) ?? '';
  const title = rules.pick('title', texts, d.title) ?? '';
  const id = idOn(view, item.developmentId, rules.network);
  return {
    kind: 'DEVELOPMENT',
    id,
    ref: knownDevelopmentRef(view.site, item.ownerAgencyId, { code: item.code, ownRef: item.ownRef }),
    name,
    title: title || name,
    slug: rules.network ? slugOf(title || name, id) : d.slug,
    textLocale: overriddenTitle(texts) ? null : d.textLocale,
    status: d.development.status,
    completionDate: d.development.completionDate,
    place: d.place,
    geo: d.geo,
    price: { fromCents: item.priceMin, toCents: item.priceMax, currency: d.price.currency },
    bedrooms: { min: item.bedsMin, max: item.bedsMax },
    units: { total: item.total, available: item.available, reserved: item.reserved },
  };
}

/** Development cards as the site serves them, in order. */
export function serializeDevelopmentCards(
  view: SiteView,
  items: readonly DevelopmentItem<UnitCardDoc>[],
): WebsiteDevelopmentCard[] {
  return items.map((item) => developmentCard(view, item));
}

/** A development's detail page as the site serves it. */
export function serializeDevelopmentDetail(
  view: SiteView,
  item: DevelopmentItem<UnitDetailDoc>,
): WebsiteDevelopmentDetail {
  const d = item.doc;
  const rules = rulesFor(view, { ownerAgencyId: item.ownerAgencyId, doc: d, developmentOwnRef: item.ownRef });
  const texts = developmentTexts(view, item.developmentId, rules.network);
  const card = developmentCard(view, item);
  const description = rules.pick('description', texts, d.description);
  return {
    ...card,
    description,
    paymentTerms: rules.owner(d.paymentTerms),
    ...metaOf(rules, texts, card, description, d),
    agency: view.presenter,
  };
}
