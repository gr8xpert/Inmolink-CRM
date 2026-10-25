import { createHash } from 'node:crypto';

/**
 * The white-label text sanitizer (S7-02, PLAN §3 #6), module-neutral since S7-F5: the website serializer cleans the
 * text it serves with it, and the search index cleans the text it matches on with it — so free text typed on a site
 * that shows network listings never matches what only the owner's identity would match. Pure functions.
 *
 * S12-03 adds the model pass's result: `ai-features` asks a FAST model (in a worker, per listing version) which parts
 * of the deterministically cleaned text still point at the owner indirectly (an agent's first name, "our office
 * opposite the church", a number spelled out) and caches those exact parts (`white-label-store.ts`). Serving paths
 * remove them after the deterministic pass (`applyRemovals`), keyed by the source text (`textKey`); without a cached
 * answer they serve the deterministic pass alone. They never call a model.
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
export const SANITIZER_VERSION = 2; // S12-03: social handles and spelled-out e-mail addresses

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

/**
 * E-mail addresses. Every part is bounded (S12-03 review: ReDoS) — a local part of ≤ 64 characters that starts where
 * no such character precedes it, ≤ 4 labels of ≤ 63 — so a 20,000-character run of address characters is linear.
 */
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,3}\.\p{L}{2,24}/gu;
const URL_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
/**
 * Bare domains with a lower-case top-level domain (sentence starts after a full stop are capitalised). Bounded (S12-03
 * review: ReDoS): it starts only where no domain character precedes it, ≤ 4 labels of ≤ 63 characters.
 */
const DOMAIN =
  /(?<![A-Za-z0-9.-])[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){0,3}\.[a-z]{2,24}(?:\.[a-z]{2})?\b(?:\/[^\s<>"']*)?/g;
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

/** Social handles (`@sunhomes.nerja`): 3–30 characters after the `@` (e-mail addresses are removed before). */
const SOCIAL_HANDLE = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9_][A-Za-z0-9_.]{1,28}[A-Za-z0-9_](?![\p{L}\p{N}_])/gu;

/**
 * Spelled-out e-mail parts. Every part is bounded (S12-03 review: ReDoS): ≤ 3 spaces around a mark, a local part of
 * ≤ 64 characters that starts where no such character precedes it, ≤ 4 labels of ≤ 63.
 */
/** `[at]`, `(arroba)`, ` @ ` — an e-mail's at sign written to dodge filters. */
const AT_MARK = String.raw`(?:\s{0,3}[\[({]\s{0,3}(?:at|arroba)\s{0,3}[\])}]\s{0,3}|\s{0,3}@\s{0,3})`;
/** ` at ` / ` arroba ` as a word: only with a spelled-out dot too (`info at sunhomes dot com`). */
const AT_WORD = String.raw`\s{1,3}(?:at|arroba)\s{1,3}`;
const DOT_WORD = String.raw`(?:\s{0,3}[\[({]\s{0,3}(?:dot|punto)\s{0,3}[\])}]\s{0,3}|\s{1,3}(?:dot|punto)\s{1,3})`;
/** A plain dot: unspaced, or spaced on both sides (`sol . es`) — never a full stop ending a sentence (`.example. New`). */
const DOT_ANY = String.raw`(?:${DOT_WORD}|\s\.\s|\.)`;
const LOCAL_PART = String.raw`(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}`;
const LABEL = String.raw`[\p{L}\p{N}-]{1,63}`;
/** E-mail addresses written out (`info [at] sunhomes [dot] com`, `ventas arroba sol punto es`, `info @ sol . es`). */
const SPELLED_EMAIL = new RegExp(
  String.raw`${LOCAL_PART}(?:${AT_MARK}${LABEL}(?:${DOT_ANY}${LABEL}){0,3}?${DOT_ANY}|${AT_WORD}${LABEL}(?:${DOT_WORD}${LABEL}){0,3}?${DOT_WORD})\p{L}{2,12}(?![\p{L}\p{N}])`,
  'giu',
);

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
      out = out.replace(SPELLED_EMAIL, '').replace(EMAIL, '').replace(URL_SCHEME, '').replace(DOMAIN, '');
      out = stripPhones(out).replace(TAX_ID, '').replace(SOCIAL_HANDLE, '');
      if (nameRe) out = out.replace(nameRe, '');
      const refs = ownerRefs.map((r) => r.trim()).filter((r) => r.length >= 3);
      if (refs.length > 0) {
        out = out.replace(whole(`(?:ref(?:erence|erencia)?\\.?\\s*:?\\s*)?(?:${refs.map(escapeRegex).join('|')})`), '');
      }
      return tidy(out);
    },
  };
}

/** Spacing left by removals: runs of spaces collapsed, no space before punctuation. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}

// ── S12-03: the model pass's removals ───────────────────────────────────────────────────────────────────────────

/**
 * S13-F7: where a listing's detail document keeps the free texts the white-label model pass reads (title, description,
 * meta texts, payment terms, development and phase names). One list for both readers: the pass (`docTexts` in
 * ai-features) and the read-model upsert's text-change check (search), so they can never drift apart.
 */
export const DETAIL_TEXT_PATHS: readonly (readonly string[])[] = [
  ['title'],
  ['description'],
  ['metaTitle'],
  ['metaDescription'],
  ['paymentTerms'],
  ['development', 'name'],
  ['phase', 'name'],
];

/** The value at a `DETAIL_TEXT_PATHS` path of a detail document (undefined when absent). */
export function detailAt(detail: unknown, path: readonly string[]): unknown {
  let v: unknown = detail;
  for (const key of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  return v;
}

/**
 * The key of a source text's cached model removals: a hash of its plain text (the `plainText` of the source — pass
 * that, not the source), so an edited text (a new listing version) never takes the removals of the old one: it is
 * served deterministic-only until the worker ran.
 */
export function textKey(plain: string): string {
  return createHash('sha256').update(plain).digest('base64url').slice(0, 22);
}

/** One target's cached model removals by `textKey`: the exact parts of each (deterministically cleaned) text. */
export type TextRemovals = ReadonlyMap<string, readonly string[]>;
/** Cached model removals by target id, then `textKey`: an answer never applies to another target's (owner's) text. */
export type AiRemovals = ReadonlyMap<string, TextRemovals>;

/**
 * The owner's own references a document's text loses (S7-F6): the document's, and its development's. One rule for the
 * worker that asks the model and every serving path, so both clean the same text the same way.
 */
export function ownerRefsOf(doc: { ref: string; developmentOwnRef?: string | null }): string[] {
  return doc.developmentOwnRef ? [doc.ref, doc.developmentOwnRef] : [doc.ref];
}

/** Letters and digits around a part: a part never starts or ends inside a word (`María` of `Santa María`… see below). */
const WORD_EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_EDGE_AFTER = '(?![\\p{L}\\p{N}])';

/** A part as a pattern: its characters exactly, any whitespace run matching any other, whole words only. */
const spanPattern = (span: string) =>
  `${WORD_EDGE_BEFORE}${span
    .trim()
    .split(/\s+/)
    .map((w) => escapeRegex(w))
    .join('\\s+')}${WORD_EDGE_AFTER}`;

/** Removes these exact parts (whitespace-tolerant, case-sensitive, whole words), longest first, then tidies spacing. */
export function applyRemovals(text: string, spans: readonly string[]): string {
  const parts = [...new Set(spans.map((s) => s.trim()).filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (parts.length === 0) return text;
  return tidy(text.replace(new RegExp(parts.map(spanPattern).join('|'), 'gu'), ''));
}

/** Longest part the model may remove, and the most parts per text. */
export const MAX_REMOVAL_CHARS = 300;
export const MAX_REMOVALS = 20;
/** Share of a text the model may remove: more and its answer is dropped (deterministic pass only). */
export const MAX_REMOVED_SHARE = 0.5;

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|single|double|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez';
const ROOM_WORDS =
  'bed|bath|dormitor|habitaci|baño|bano|aseo|suite|toilet|floor|storey|planta|garage|garaje|parking|plaza|metros|square|hect';
/**
 * Facts written in words (`three bedrooms`, `tres dormitorios`, `two-storey`): a part holding one is dropped, and an
 * answer that would change how many the text holds is dropped whole.
 */
const WORDED_FACT = new RegExp(
  `(?<![\\p{L}])(?:${NUMBER_WORDS})[\\s-]{1,3}(?:[\\p{L}-]{1,20}\\s{1,3})?(?:${ROOM_WORDS})`,
  'iu',
);
const WORDED_FACTS = new RegExp(WORDED_FACT.source, 'giu');
const countWordedFacts = (text: string) => (text.match(WORDED_FACTS) ?? []).length;

/** What a part must never touch besides facts: the property's place names and its development's (S12-03 review). */
export interface RemovalGuard {
  /** Town, area, region and development names of the document: a part inside or across one is dropped. */
  protectedNames?: readonly string[];
}

/** Where a protected name occurs in a text (case and accents ignored, whole words). */
function protectedRanges(text: string, names: readonly string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const name of names) {
    const p = namePattern(name);
    if (!p) continue;
    for (const m of text.matchAll(whole(p))) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * The model's answer for one text, checked against that same text (the one the parts are applied to): a part that
 * does not occur in it as whole words (whitespace-tolerant), is too long, too short (one word under 4 characters) or
 * empty, holds a digit (prices, areas, years, street numbers: facts) or a fact written in words, or touches a
 * protected place name (inside it or across it) is dropped. Null when the answer would remove too much (more than
 * `MAX_REMOVALS` parts or `MAX_REMOVED_SHARE` of the text) or change the facts the text holds in words — the text is
 * then served deterministic-only.
 */
export function acceptRemovals(text: string, spans: readonly string[], guard: RemovalGuard = {}): string[] | null {
  const names = (guard.protectedNames ?? []).filter((n) => foldText(n).replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
  const ranges = protectedRanges(text, names);
  const foldedNames = names.map(foldText);
  const kept: string[] = [];
  for (const raw of spans) {
    const span = raw.trim();
    if (span.length > MAX_REMOVAL_CHARS || !/\p{L}/u.test(span) || /\p{N}/u.test(span)) continue;
    if (span.split(/\s+/).length < 2 && span.length < 4) continue;
    if (WORDED_FACT.test(span)) continue;
    const folded = foldText(span);
    if (foldedNames.some((n) => n.includes(folded))) continue;
    const matches = [...text.matchAll(new RegExp(spanPattern(span), 'gu'))];
    if (matches.length === 0) continue;
    const touches = matches.some((m) => ranges.some(([a, b]) => m.index < b && a < m.index + m[0].length));
    if (touches) continue;
    if (!kept.includes(span)) kept.push(span);
  }
  if (kept.length > MAX_REMOVALS) return null;
  if (kept.length === 0) return kept;
  const after = applyRemovals(text, kept);
  if (countWordedFacts(after) !== countWordedFacts(text)) return null;
  return text.length - after.length > text.length * MAX_REMOVED_SHARE ? null : kept;
}

/**
 * The deterministic white-label pass (S12-03 builds on it): removes e-mail addresses, URLs and domains, phone
 * numbers, tax ids, and the owner's names (any case, accents and spacing), contacts, website and own reference of
 * the document. Facts (prices, areas, years) stay. Compiles the owner's patterns per call: callers cleaning many
 * texts of one owner use `compileOwner` once.
 */
export const deterministicSanitizer: TextSanitizer = (text, owner) => compileOwner(owner).clean(text, owner.ownerRefs);

/**
 * S12-03: the full white-label pass of one source text as a serving path applies it — plain text, the deterministic
 * pass, then the cached model removals of that text when there are any (`removals` by `textKey`).
 */
export function whiteLabelText(
  text: string,
  matcher: OwnerMatcher,
  ownerRefs: readonly string[],
  removals?: TextRemovals,
): string {
  const plain = plainText(text);
  const clean = matcher.clean(plain, ownerRefs);
  const spans = removals && removals.size > 0 ? removals.get(textKey(plain)) : undefined;
  return spans ? applyRemovals(clean, spans) : clean;
}

/** At most `max` characters, cut at a word boundary (never inside a word, an e-mail or a surrogate pair). */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1);
  const space = cut.search(/\s\S*$/);
  cut = space > 0 ? cut.slice(0, space) : cut.slice(0, max);
  // A lone high surrogate at the end (an emoji cut in two) goes too.
  return cut.replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}
