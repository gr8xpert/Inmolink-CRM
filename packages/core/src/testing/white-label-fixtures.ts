import type { OwnerIdentity } from '../white-label';
import type { WhiteLabelOwner } from './white-label';

/**
 * S12-03 fixture set: listing descriptions (English and Spanish) with the owner agency's contact details planted —
 * the direct ones the deterministic pass removes (phone numbers in every format, e-mails plain and spelled out, URLs,
 * bare domains, the agency's names in any case and spacing, its tax id, social handle and own reference) and
 * indirect ones only the model pass finds (an agent's first name, the office's whereabouts, a number spelled out).
 * Every description carries facts (prices, areas, rooms, years, distances) that must come out unchanged.
 *
 * Generated deterministically from a seed (mulberry32), so a failure names its fixture and reproduces.
 */

export function fixtureRng(seed: number) {
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
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = int(0, i);
      [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
    }
    return xs;
  };
  return { next, int, pick, digits, uuid, shuffle };
}
type Rng = ReturnType<typeof fixtureRng>;

/** An indirect mention: the sentence as planted, and the part of it that must never be served. */
export interface IndirectMention {
  sentence: string;
  marker: string;
}

export interface SanitizerFixture {
  index: number;
  lang: 'en' | 'es';
  ref: string;
  /** The owner as the sanitizer knows it (`agencies.ownerIdentities`). */
  identity: OwnerIdentity;
  /** The owner as the leak check (`whiteLabelLeaks`) looks for it. */
  owner: WhiteLabelOwner;
  description: string;
  /** Strings that must appear verbatim in the cleaned text. */
  facts: string[];
  /** Direct contact details planted (each must be gone after the deterministic pass; case-insensitive). */
  direct: string[];
  /** Indirect mentions planted (each marker must be gone after the model pass). */
  indirect: IndirectMention[];
  /** Phone digit strings planted (gone in any spacing). */
  phoneDigits: string[];
  /** The property's place names (protected from removals: `RemovalGuard`). */
  places: string[];
}

/** Fictional agencies (no real business), on `.example` / `.test` domains with 555-style numbers. */
const AGENCIES = [
  'Examplia Coast Realty',
  'Fictiva Prime Homes',
  'Mockup Sol Inmobiliaria',
  'Demolandia Estates',
  'Placeholder Bay Properties',
  'Testa Axarquía Living',
  'Sampleton Coastal Homes',
];
const HANDLE_WORDS = ['homes', 'living', 'casas', 'villas', 'realty'];

function phoneFormats(local: string): string[] {
  return [
    `+34 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`,
    `${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7)}`,
    local,
    `0034 ${local}`,
    `(+34) ${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`,
    `${local.slice(0, 3)}.${local.slice(3, 6)}.${local.slice(6)}`,
    `+34 ${local.slice(0, 3)}.${local.slice(3, 6)}.${local.slice(6)}`,
  ];
}

const NUMBER_WORDS = {
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
} as const;

const AGENT_NAMES = ['María', 'Juan', 'Jonathan', 'Carmen', 'Lars', 'Inge', 'Paco', 'Sophie', 'Ahmed'];
const LANDMARKS = {
  en: ['opposite the old church', 'next to the town hall', 'behind the Balcón de Europa', 'by the fish market'],
  es: ['frente a la iglesia', 'junto al ayuntamiento', 'detrás del Balcón de Europa', 'al lado del mercado'],
} as const;
const TOWNS = ['Nerja', 'Frigiliana', 'Torrox', 'Competa', 'Marbella', 'Estepona'];
/**
 * Where the property is (a fact, protected from removals): names that hold agent first names and short words (S12-03
 * review — `María` of `Santa María`, `Juan` of `San Juan`, `Mar` of `Marbella`).
 */
const PLACES = ['San Juan', 'Santa María', 'Marbella', 'Mar de Cristal', 'Nerja', 'Torrox'];

function indirectMention(r: Rng, lang: 'en' | 'es', place: string): IndirectMention {
  const agent = r.pick(AGENT_NAMES);
  // The office is in another town than the property (a part never touches the property's place).
  const town = r.pick(TOWNS.filter((t) => t !== place));
  const spelled = Array.from({ length: 9 }, () => NUMBER_WORDS[lang][r.int(0, 9)]);
  const spelledText = `${spelled.slice(0, 3).join(' ')}, ${spelled.slice(3, 6).join(' ')}, ${spelled.slice(6).join(' ')}`;
  const landmark = r.pick(LANDMARKS[lang]);
  const handle = `${town.toLowerCase()}${r.pick(HANDLE_WORDS)}`;
  const en: IndirectMention[] = [
    { sentence: `For a viewing ask for ${agent} at our ${town} office.`, marker: `ask for ${agent}` },
    { sentence: `Our agent ${agent} will gladly show you around.`, marker: `agent ${agent}` },
    { sentence: `Call us on ${spelledText}.`, marker: spelled.slice(0, 3).join(' ') },
    { sentence: `Visit our office ${landmark} in ${town}.`, marker: `our office ${landmark}` },
    { sentence: `Find us on Instagram as ${handle}.`, marker: handle },
  ];
  const es: IndirectMention[] = [
    { sentence: `Para visitas pregunte por ${agent} en nuestra oficina de ${town}.`, marker: `pregunte por ${agent}` },
    { sentence: `Nuestro agente ${agent} se la enseñará con mucho gusto.`, marker: `agente ${agent}` },
    { sentence: `Llámenos al ${spelledText}.`, marker: spelled.slice(0, 3).join(' ') },
    { sentence: `Visite nuestra oficina ${landmark} en ${town}.`, marker: `nuestra oficina ${landmark}` },
    { sentence: `Síganos en Instagram como ${handle}.`, marker: handle },
  ];
  return r.pick(lang === 'en' ? en : es);
}

const groupThousands = (n: number, sep: string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

function facts(r: Rng, lang: 'en' | 'es', place: string): { sentences: string[]; facts: string[] } {
  const price = r.int(150, 2_500) * 1_000;
  const beds = r.int(1, 6);
  const baths = r.int(1, 4);
  const built = r.int(60, 650);
  const plot = r.int(300, 4_000);
  const year = r.int(1965, 2024);
  const beach = r.int(1, 9) * 100;
  const golf = `${r.int(1, 9)},${r.int(1, 9)}`;
  const fees = r.int(40, 400);
  const priceText = r.pick([
    `${groupThousands(price, '.')} €`,
    `€ ${groupThousands(price, ',')}`,
    `${groupThousands(price, '.')} euros`,
  ]);
  if (lang === 'en') {
    const f = [
      `${beds} bedrooms`,
      `${baths} bathrooms`,
      `${built} m²`,
      `${groupThousands(plot, '.')} m2`,
      `built in ${year}`,
      `${beach} m from the beach`,
      `${golf} km`,
      priceText,
      `${fees} € per month`,
      place,
      'two bedrooms',
    ];
    return {
      facts: f,
      sentences: [
        `This villa has ${f[0]} and ${f[1]}, with a built area of ${f[2]} on a plot of ${f[3]}.`,
        `It was ${f[4]} and is only ${f[5]}; the golf course is ${f[6]} away.`,
        `Asking price ${f[7]}.`,
        `Community fees are ${f[8]}.`,
        'Sea views, private pool and a sunny terrace.',
        `Located in ${f[9]}.`,
        `The guest annex has ${f[10]} of its own.`,
      ],
    };
  }
  const f = [
    `${beds} dormitorios`,
    `${baths} baños`,
    `${built} m²`,
    `${groupThousands(plot, '.')} m2`,
    `construida en ${year}`,
    `a ${beach} m de la playa`,
    `${golf} km`,
    priceText,
    `${fees} € al mes`,
    place,
    'dos dormitorios',
  ];
  return {
    facts: f,
    sentences: [
      `Esta villa tiene ${f[0]} y ${f[1]}, con ${f[2]} construidos en una parcela de ${f[3]}.`,
      `Fue ${f[4]} y está ${f[5]}; el campo de golf está a ${f[6]}.`,
      `Precio ${f[7]}.`,
      `Gastos de comunidad ${f[8]}.`,
      'Vistas al mar, piscina privada y terraza soleada.',
      `Situada en ${f[9]}.`,
      `El anexo de invitados tiene ${f[10]} propios.`,
    ],
  };
}

/** One fixture (seeded by its index). */
export function sanitizerFixture(index: number): SanitizerFixture {
  const r = fixtureRng(0x5a11 + index * 7919);
  const lang = index % 2 === 0 ? 'en' : 'es';
  const name = r.pick(AGENCIES);
  // Fictional 555-style numbers (9 digits, Spanish shape).
  const local = `${r.pick(['6', '9'])}555${r.digits(5)}`;
  const mobile = `7555${r.digits(5)}`;
  const place = r.pick(PLACES);
  const domain = `${name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '')}.${r.pick(['example', 'test'])}`;
  const email = `${r.pick(['info', 'sales', 'ventas'])}@${domain}`;
  const [user = 'info', host = domain] = email.split('@');
  const [label = '', tld = 'com'] = host.split('.');
  const ref = Array.from({ length: 8 }, () => r.pick([...'23456789ABCDEFGHJKLMNPQRSTUVWXYZ'])).join('');
  const handle = `@${label.slice(0, 12)}${r.pick(HANDLE_WORDS)}`;
  const cif = `B${r.digits(8)}`;
  const phone = r.pick(phoneFormats(local));
  const mobileText = r.pick(phoneFormats(mobile));

  const directPlants: { sentence: string; marker: string }[] = [
    { sentence: lang === 'en' ? `Call ${phone} today.` : `Llame al ${phone} hoy.`, marker: phone },
    { sentence: `WhatsApp ${mobileText}.`, marker: mobileText },
    { sentence: `Email ${email}.`, marker: email },
    { sentence: `Write to ${user} [at] ${label} [dot] ${tld}.`, marker: `${user} [at] ${label}` },
    { sentence: `Escriba a ${user} arroba ${label} punto ${tld}.`, marker: `${user} arroba ${label}` },
    { sentence: `More photos at https://www.${domain}/listing/${ref}.`, marker: domain },
    { sentence: `See www.${domain} for more.`, marker: domain },
    { sentence: `Visit ${domain}.`, marker: domain },
    { sentence: `Exclusive to ${name}.`, marker: name },
    { sentence: `${name.toUpperCase()} presents this home.`, marker: name },
    { sentence: `${name.replace(/ /g, '')} recommends it.`, marker: name.replace(/ /g, '') },
    { sentence: `Ref. ${ref}.`, marker: ref },
    { sentence: `Follow ${handle} for news.`, marker: handle },
    { sentence: `CIF ${cif}.`, marker: cif },
    { sentence: `<b>${name}</b> &amp; partners.`, marker: name },
  ];
  const direct = r.shuffle([...directPlants]).slice(0, r.int(3, 7));
  const indirect: IndirectMention[] = [];
  // Three in four descriptions carry an indirect mention, some two.
  const indirectCount = r.next() < 0.25 ? 0 : r.next() < 0.7 ? 1 : 2;
  while (indirect.length < indirectCount) {
    const m = indirectMention(r, lang, place);
    if (!indirect.some((i) => i.sentence === m.sentence)) indirect.push(m);
  }
  const f = facts(r, lang, place);
  const sentences = r.shuffle([...f.sentences, ...direct.map((d) => d.sentence), ...indirect.map((i) => i.sentence)]);
  const description = sentences.join(r.pick([' ', ' ', '\n']));
  return {
    index,
    lang,
    ref,
    identity: { names: [name], emails: [email], phones: [phone], hosts: [domain] },
    owner: { name, email, domain, phone, phoneDigits: local, ref },
    description,
    facts: f.facts,
    direct: [...new Set(direct.map((d) => d.marker))],
    indirect,
    phoneDigits: [local, mobile],
    places: [place],
  };
}

/** The S12-03 acceptance set: 200 descriptions. */
export function sanitizerFixtures(count = 200): SanitizerFixture[] {
  return Array.from({ length: count }, (_, i) => sanitizerFixture(i));
}

/**
 * What of a fixture's planted details is left in a cleaned text (empty: none): direct markers, phone digits in any
 * spacing, the owner (`whiteLabelLeaks`-style), and — with `indirect` — the indirect markers.
 */
export function fixtureLeaks(f: SanitizerFixture, cleaned: string, options: { indirect: boolean }): string[] {
  const lower = cleaned.toLowerCase();
  const leaks: string[] = [];
  for (const m of f.direct) if (lower.includes(m.toLowerCase())) leaks.push(`direct "${m}"`);
  for (const d of f.phoneDigits) if (cleaned.replace(/\D/g, '').includes(d)) leaks.push(`phone digits ${d}`);
  for (const s of [f.owner.name, f.owner.email, f.owner.domain, f.ref]) {
    if (lower.includes(s.toLowerCase())) leaks.push(`owner "${s}"`);
  }
  if (lower.includes(f.owner.domain.split('.')[0] ?? '\u0000')) leaks.push('owner host label');
  if (options.indirect) {
    for (const i of f.indirect) if (lower.includes(i.marker.toLowerCase())) leaks.push(`indirect "${i.marker}"`);
  }
  return leaks;
}

/** Facts of a fixture missing from a cleaned text (empty: all unchanged). */
export function missingFacts(f: SanitizerFixture, cleaned: string): string[] {
  return f.facts.filter((fact) => !cleaned.includes(fact));
}

/**
 * The texts of a white-label model input (`aiFeatures.modelInput`): each untrusted block's content, unescaped — what a
 * fake provider or an eval replay reads the request as.
 */
export function blocksOf(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/<(untrusted_[a-z0-9_]+)>\n([\s\S]*?)\n<\/\1>/g)) {
    out.push((m[2] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  return out;
}
