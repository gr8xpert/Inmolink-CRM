/**
 * The white-label text sanitizer (S7-02, PLAN §3 #6), module-neutral since S7-F5: the website serializer cleans the
 * text it serves with it, and the search index cleans the text it matches on with it — so free text typed on a site
 * that shows network listings never matches what only the owner's identity would match. Pure functions.
 */

/** Who owns a text, as the sanitizer removes it (`agencies.ownerIdentities`: listed or not). */
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

/** No known owner: the generic patterns (e-mails, URLs, domains, phone numbers) still apply. */
export const NO_OWNER: OwnerIdentity = { names: [], emails: [], phones: [], hosts: [] };

/**
 * Version of the deterministic pass (S7-F5): part of every search index document's `sourceHash`, so a change of the
 * rules (raise it) re-pushes every document through the repair walk.
 */
export const SANITIZER_VERSION = 1;

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

/** Spanish tax ids (CIF, NIF, NIE) with or without separators: removed like phone numbers (an id names its holder). */
const TAX_ID =
  /(?<![\p{L}\p{N}])(?:[ABCDEFGHJNPQRSUVW][-\s.]?\d{7}[-\s.]?[0-9A-J]|\d{8}[-\s.]?[A-Z]|[XYZ][-\s.]?\d{7}[-\s.]?[A-Z])(?![\p{L}\p{N}])/gu;

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

/** Lower case without accents (`Ñandú` → `nandu`): how names are compared. */
export const foldText = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Letters a folded letter stands for in a text (accented forms; case is ignored by the `i` flag). */
const ACCENTED: Readonly<Record<string, string>> = {
  a: 'aàáâãäåā',
  e: 'eèéêëē',
  i: 'iìíîïī',
  o: 'oòóôõöøō',
  u: 'uùúûüū',
  n: 'nñ',
  c: 'cç',
  y: 'yýÿ',
};

/** Between the words of a name: nothing, spaces (any, newlines and no-break spaces too), hyphens, dots, apostrophes. */
const NAME_GAP = "[\\s\\u00a0\\-_.'’]*";

/** Shortest name (letters and digits) the sanitizer removes: shorter ones are too likely to be ordinary words. */
export const MIN_NAME_CHARS = 3;

/**
 * A name as a pattern: its words in any case, with or without accents, written apart or together (`Costa Homes`,
 * `CostaHomes`, `Costa-Homes`, `costa homes'` …), with a possessive (`'s`) removed with it. Null: too short.
 */
function namePattern(name: string): string | null {
  const words = foldText(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.join('').length < MIN_NAME_CHARS) return null;
  const word = (w: string) =>
    Array.from(w, (ch) => {
      const variants = ACCENTED[ch];
      return `${variants ? `[${variants}]` : escapeRegex(ch)}\\p{M}*`;
    }).join('');
  // A last word of one or two letters is an abbreviation ("S.L."): its full stop goes with it.
  const abbreviated = (words.at(-1)?.length ?? 0) <= 2 ? '\\.?' : '';
  return `${words.map(word).join(NAME_GAP)}${abbreviated}(?:['’]s?)?`;
}

/** Shortest website main label (`costahomes` of `costahomes.es`) also removed as a name. */
const MIN_HOST_LABEL_CHARS = 5;

/** An owner's identity compiled once (S7-F5: one matcher per owner per index batch). */
export interface OwnerMatcher {
  identity: OwnerIdentity;
  /** The deterministic white-label pass on plain text, with the document's own references. */
  clean(text: string, ownerRefs?: readonly string[]): string;
}

/** Compiles an owner's identity into one matcher (all its names, contacts and host in a few regular expressions). */
export function compileOwner(identity: OwnerIdentity): OwnerMatcher {
  const contacts: string[] = [];
  for (const email of identity.emails) if (email) contacts.push(escapeRegex(email));
  for (const host of identity.hosts) if (host) contacts.push(`(?:https?://)?(?:www\\.)?${escapeRegex(host)}\\S*`);
  for (const phone of identity.phones) {
    const p = phonePattern(phone);
    if (p) contacts.push(p);
  }
  const names = new Set<string>();
  for (const name of identity.names) {
    const p = namePattern(name);
    if (p) names.add(p);
  }
  for (const host of identity.hosts) {
    const label = host.replace(/^www\./i, '').split('.')[0] ?? '';
    if (foldText(label).replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_HOST_LABEL_CHARS) {
      const p = namePattern(label);
      if (p) names.add(p);
    }
  }
  // Longest first: "Costa Homes S.L." before "Costa Homes".
  const nameList = [...names].sort((a, b) => b.length - a.length);
  const contactRe = contacts.length > 0 ? whole(contacts.join('|')) : null;
  const nameRe = nameList.length > 0 ? whole(nameList.join('|')) : null;
  return {
    identity,
    clean(text, ownerRefs = []) {
      let out = contactRe ? text.replace(contactRe, '') : text;
      out = out.replace(EMAIL, '').replace(URL_SCHEME, '').replace(DOMAIN, '');
      out = stripPhones(out).replace(TAX_ID, '');
      if (nameRe) out = out.replace(nameRe, '');
      const refs = ownerRefs.map((r) => r.trim()).filter((r) => r.length >= 3);
      if (refs.length > 0) {
        out = out.replace(whole(`(?:ref(?:erence|erencia)?\\.?\\s*:?\\s*)?(?:${refs.map(escapeRegex).join('|')})`), '');
      }
      return out
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([.,;:!?])/g, '$1')
        .trim();
    },
  };
}

/**
 * The deterministic white-label pass (S12-03 builds on it): removes e-mail addresses, URLs and domains, phone
 * numbers, tax ids, and the owner's names (any case, accents and spacing), contacts, website and own reference of
 * the document. Facts (prices, areas, years) stay. Compiles the owner's patterns per call: callers cleaning many
 * texts of one owner use `compileOwner` once.
 */
export const deterministicSanitizer: TextSanitizer = (text, owner) => compileOwner(owner).clean(text, owner.ownerRefs);

/** At most `max` characters, cut at a word boundary (never inside a word, an e-mail or a surrogate pair). */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1);
  const space = cut.search(/\s\S*$/);
  cut = space > 0 ? cut.slice(0, space) : cut.slice(0, max);
  // A lone high surrogate at the end (an emoji cut in two) goes too.
  return cut.replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}
