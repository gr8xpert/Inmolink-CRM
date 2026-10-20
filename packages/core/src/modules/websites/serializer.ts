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
  WebsiteImage,
  WebsiteListingCard,
  WebsiteListingDetail,
  WebsiteMedia,
  WebsitePresenter,
  WebsiteUnitCard,
  WebsiteUnitDetail,
} from '@inmolink/contracts';

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

/** Who owns a document, as the sanitizer removes it (`agencies.ownerIdentities`: listed or not). */
export interface OwnerIdentity {
  names: readonly string[];
  emails: readonly string[];
  phones: readonly string[];
  /** Website host names (`www.` stripped). */
  hosts: readonly string[];
}

/** What the sanitizer knows about the text's owner: its identity and the owner's own reference of the document. */
export interface SanitizeContext extends OwnerIdentity {
  /** The owner's own reference (`Ref. AB12CD34`): a network document shows the site's code instead. */
  ownerRefs: readonly string[];
}

/** White-label text sanitizer (S12-03 replaces the default with its deterministic + model passes and cache). */
export type TextSanitizer = (text: string, context: SanitizeContext) => string;

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
  doc: D;
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  copy: '©',
  reg: '®',
  deg: '°',
  sup2: '²',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
};

/** HTML character references decoded (named ones above, decimal and hex); unknown ones stay as they are. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, ref: string) => {
    if (ref.startsWith('#')) {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[ref] ?? m;
  });
}

/**
 * Plain text: character references decoded first (so an encoded tag is removed too), then HTML tags and stray
 * angle brackets removed and control characters dropped (newlines kept). The result is text, not HTML: consumers
 * escape it when they render it.
 */
export function plainText(text: string): string {
  return (
    decodeEntities(text)
      .replace(/<[^>]*>/g, ' ')
      .replace(/[<>]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const URL_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
/** Bare domains with a lower-case top-level domain (sentence starts after a full stop are capitalised). */
const DOMAIN =
  /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[a-z]{2,}(?:\.[a-z]{2})?\b(?:\/[^\s<>"']*)?/g;
/** Phone numbers: 9–15 digits with separators, or a + / 00 international prefix. */
const PHONE = /(?:\+|\b00)?\d[\d\s()./-]{6,22}\d\b/g;
/** Grouped thousands (`1.250.000`, `1,250,000`): a price or area, not a phone number… */
const GROUPED_NUMBER = /^\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*$/;
/** …except a Spanish number written in groups of three (`952.123.456`, `600 123 456`, `+34 600.123.456`). */
const SPANISH_PHONE = /^(?:(?:\+|00)34[\s.]?)?[6789]\d{2}([.,\s])\d{3}\1\d{3}$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stripPhones(text: string): string {
  return text.replace(PHONE, (m) => {
    const t = m.trim();
    const digits = t.replace(/\D/g, '').length;
    const international = t.startsWith('+') || t.startsWith('00');
    if (GROUPED_NUMBER.test(t) && !SPANISH_PHONE.test(t)) return m;
    return digits >= 9 || (international && digits >= 7) ? '' : m;
  });
}

/** A phone number's digits in any spacing (the national number: its last 9 digits when it has more). */
function phonePattern(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const national = digits.length > 9 ? digits.slice(-9) : digits;
  return `(?:(?:\\+|00)\\d{1,3}[\\s().-]*)?${national.split('').join('[\\s()./-]*')}`;
}

const whole = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');

/**
 * The deterministic white-label pass (S12-03 builds on it): removes e-mail addresses, URLs and domains, phone
 * numbers, and the owner's names, contacts, website and own reference of the document. Facts (prices, areas,
 * years) stay.
 */
export const deterministicSanitizer: TextSanitizer = (text, owner) => {
  let out = text;
  for (const email of owner.emails) if (email) out = out.replace(whole(escapeRegex(email)), '');
  for (const host of owner.hosts)
    if (host) out = out.replace(whole(`(?:https?://)?(?:www\\.)?${escapeRegex(host)}\\S*`), '');
  for (const phone of owner.phones) {
    const p = phonePattern(phone);
    if (p) out = out.replace(whole(p), '');
  }
  out = out.replace(EMAIL, '').replace(URL_SCHEME, '').replace(DOMAIN, '');
  out = stripPhones(out);
  // Longest first: "Costa Homes S.L." before "Costa Homes".
  for (const name of [...owner.names].sort((a, b) => b.length - a.length)) {
    const n = name.trim();
    if (n.length < 3) continue;
    out = out.replace(whole(escapeRegex(n)), '');
  }
  for (const ref of owner.ownerRefs) {
    if (ref.trim().length < 3) continue;
    out = out.replace(whole(`(?:ref(?:erence|erencia)?\\.?\\s*:?\\s*)?${escapeRegex(ref.trim())}`), '');
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
};

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

const NO_OWNER: OwnerIdentity = { names: [], emails: [], phones: [], hosts: [] };

function rulesFor(view: SiteView, item: Owned<{ ref: string }>): TextRules {
  const network = item.ownerAgencyId !== view.site.agencyId;
  const sanitize = view.sanitize ?? deterministicSanitizer;
  const context: SanitizeContext = { ...(view.owners?.get(item.ownerAgencyId) ?? NO_OWNER), ownerRefs: [item.doc.ref] };
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
  return {
    kind: 'LISTING',
    id: d.id,
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
    developmentId: d.developmentId,
    title: title || shownRef,
    slug: rules.network ? slugOf(title, d.id) : d.slug,
    textLocale: overriddenTitle(texts) ? null : d.textLocale,
  };
}

function unitCard(view: SiteView, item: Owned<UnitCardDoc>): WebsiteUnitCard {
  const d = item.doc;
  const rules = rulesFor(view, item);
  const texts = textsFor(view, d.id, d.development.id, rules.network);
  const developmentName = rules.owner(d.development.name) ?? '';
  const title = rules.pick('title', texts, d.title) ?? '';
  return {
    kind: 'UNIT',
    id: d.id,
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
      id: d.development.id,
      name: developmentName,
      status: d.development.status,
      completionDate: d.development.completionDate,
    },
    title: title || developmentName,
    slug: rules.network ? slugOf(title || developmentName, d.development.id) : d.slug,
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

/** A detail page as the site serves it. */
export function serializeDetail(view: SiteView, item: Owned<ListingDetailDoc | UnitDetailDoc>): WebsiteDetail {
  return item.doc.kind === 'LISTING'
    ? listingDetail(view, item as Owned<ListingDetailDoc>)
    : unitDetail(view, item as Owned<UnitDetailDoc>);
}
