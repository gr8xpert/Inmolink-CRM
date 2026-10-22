#!/usr/bin/env node
/**
 * Records real Resales Online WebAPI V6 responses as test fixtures (S6-F4, H13). The API key is bound to whitelisted
 * server IPs, so this runs ON such a server, never locally. Plain Node >= 20, no dependencies: copy the file over.
 *
 *   read -s RESALES_P2; export RESALES_P2
 *   RESALES_P1=<client id> RESALES_ALIAS=1 node resales-record.mjs --out ./resales-recorded
 *
 * Writes `search-page1.json`, `search-page2.json`, `search-page1-lang2.json` (Spanish), `details-<ref>.json` for up to
 * three own listings and one own development, and `summary.json` (counts and the field names seen: the own-property
 * field, the Status shape, every key). Nothing identifying stays in the files: the credentials (raw, URL-encoded, any
 * case, any `p1=` / `p2=` pair) and every IP address are replaced in each file and in everything printed; records
 * that are not the agency's own keep their keys but lose their content; the agency's own records keep their prices,
 * types, sizes and places but get synthetic free text, coordinates, references, media links and contact fields.
 * The output goes to `tests/fixtures/resales/recorded/` (git-ignored) — see docs/build/STATUS.md › Blocked › S6-F4.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'webapi.resales-online.com';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
// Server-side one-off: not a turbo task, so its variables are not in turbo.json.
const env = process.env;
const P1 = env.RESALES_P1 ?? '';
const P2 = env.RESALES_P2 ?? '';
const ALIAS = env.RESALES_ALIAS ?? '1';
const BASE = new URL(arg('base', `https://${HOST}/V6`));
const OUT = arg('out', './resales-recorded');
if (!P1 || !P2) {
  console.error('set RESALES_P1 (client id) and RESALES_P2 (API key); RESALES_ALIAS is the filter alias 1-4');
  process.exit(2);
}
if (BASE.protocol !== 'https:' || BASE.hostname !== HOST || (BASE.port !== '' && BASE.port !== '443')) {
  console.error(`--base must be https://${HOST}/…`);
  process.exit(2);
}
if (!/^[1-4]$/.test(ALIAS)) {
  console.error('RESALES_ALIAS must be 1, 2, 3 or 4');
  process.exit(2);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// a full address, or one with `::` (never a time such as 10:30:00)
const IPV6 =
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?/gi;
/** Removes the credentials in every form and every IP address. Run on everything written or printed. */
function scrub(text) {
  let t = String(text).replace(/\b(p1|p2)(=|%3D)[^&\s"'<>;,()]*/gi, '$1=[redacted]');
  for (const s of [P2, P1]) {
    const forms = new Set([s, encodeURIComponent(s), new URLSearchParams({ x: s }).toString().slice(2)]);
    for (const f of forms) {
      // the client id is a short number: only where no digit touches it, so prices and sizes stay intact
      const re = /^\d+$/.test(f) ? new RegExp(`(?<![0-9])${f}(?![0-9])`, 'g') : new RegExp(escapeRe(f), 'gi');
      t = t.replace(re, s === P2 ? '[p2]' : '[p1]');
    }
  }
  return t.replace(IPV4, '203.0.113.10').replace(IPV6, '2001:db8::1');
}
const say = (v) => console.log(scrub(typeof v === 'string' ? v : JSON.stringify(v, null, 2)));

const OWN_KEYS = ['OwnProperty', 'Own', 'IsOwnProperty'];
const isOwn = (p) => OWN_KEYS.some((k) => /^(1|true|yes|y)$/i.test(String(p?.[k] ?? '').trim()));

/** Another agency's record: same keys and nesting, no content. */
function blank(v, key) {
  if (OWN_KEYS.includes(key)) return v;
  if (Array.isArray(v)) return v.map((x) => blank(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x, k)]));
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 'redacted';
  return v;
}

const FREE_TEXT = /^(Description|PictureCaption|Title|Notes?|Comments?|PrivateNotes?)$/i;
const LAT = /^(Latitude|GPS_Latitude|GpsY)$/;
const LNG = /^(Longitude|GPS_Longitude|GpsX)$/;
const MEDIA = /^(PictureURL|MainImage|VideoURL|VirtualTourURL|.*Url|.*URL)$/;
const CONTACT = /agent|contact|e-?mail|phone|mobile|^tel|owner|commission|vendor|seller|address|street/i;
/** The agency's own record: synthetic free text, coordinates, references, media and contact fields. */
function synth(v, key, n, ctr = { pic: 0 }) {
  if (Array.isArray(v)) return v.map((x) => synth(x, key, n, ctr));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, synth(x, k, n, ctr)]));
  if (key === undefined || OWN_KEYS.includes(key) || v === null || v === '') return v;
  if (FREE_TEXT.test(key)) return `<p>Synthetic text ${n}.</p>`;
  if (LAT.test(key)) return '36.5000';
  if (LNG.test(key)) return '-4.9000';
  if (/^(AgencyRef|AgentRef)$/.test(key)) return `AGREF-${n}`;
  if (MEDIA.test(key)) return `https://example.com/resales/${n}/${++ctr.pic}.jpg`;
  if (CONTACT.test(key)) return 'redacted';
  return v;
}

async function get(endpoint, params) {
  const u = new URL(`${BASE.href.replace(/\/$/, '')}/${endpoint}`);
  for (const [k, v] of Object.entries({ p_agency_filterid: ALIAS, p1: P1, p2: P2, ...params }))
    u.searchParams.set(k, String(v));
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  const text = scrub(await res.text());
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { unparsed: text.slice(0, 2_000) };
  }
  return { status: res.status, data, root: data?.root ?? data };
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
let ownSeq = 0;
const ownIds = new Map();
const ownNo = (ref) => {
  if (!ownIds.has(ref)) ownIds.set(ref, ++ownSeq);
  return ownIds.get(ref);
};
function anonymise(root) {
  let shared = 0;
  const props = list(root?.Property).map((p) =>
    isOwn(p) ? synth(p, undefined, ownNo(p.Reference)) : { ...blank(p), Reference: `SHARED-${++shared}` },
  );
  if (root && root.Property !== undefined) root.Property = Array.isArray(root.Property) ? props : props[0];
}

mkdirSync(OUT, { recursive: true });
const save = (name, value) => writeFileSync(join(OUT, `${name}.json`), `${scrub(JSON.stringify(value, null, 2))}\n`);
const summary = { alias: ALIAS, pages: {}, ownField: {}, statusShapes: new Set(), keys: new Set(), details: [] };

const own = [];
for (const [page, lang] of [
  [1, undefined],
  [2, undefined],
  [1, 2],
]) {
  const { status, data, root } = await get('SearchProperties', {
    P_PageNo: page,
    P_PageSize: 40,
    ...(lang ? { P_Lang: lang } : {}),
  });
  const raw = list(root?.Property);
  for (const p of raw) {
    for (const k of Object.keys(p ?? {})) summary.keys.add(k);
    for (const k of OWN_KEYS)
      if (p && k in p) summary.ownField[`${k}=${p[k]}`] = (summary.ownField[`${k}=${p[k]}`] ?? 0) + 1;
    summary.statusShapes.add(JSON.stringify(p?.Status ?? null));
    if (!lang && isOwn(p)) own.push(p);
  }
  summary.pages[lang ? `${page}-lang${lang}` : String(page)] = {
    httpStatus: status,
    transaction: root?.transaction?.status ?? null,
    errors: root?.transaction?.errordescription ?? null,
    queryInfo: root?.QueryInfo ?? null,
    records: raw.length,
    own: raw.filter(isOwn).length,
  };
  anonymise(root);
  save(lang ? `search-page${page}-lang${lang}` : `search-page${page}`, data);
}

const isDev = (p) => /development/i.test(String(p?.PropertyType?.NameType ?? '')) || (p?.KeyReady ?? '') !== '';
const picks = [...own.filter((p) => !isDev(p)).slice(0, 3), ...own.filter(isDev).slice(0, 1)];
for (const p of picks) {
  const { status, data, root } = await get('PropertyDetails', {
    P_RefId: p.Reference,
    P_Lang: 'EN',
    P_Dimension: 1,
    p_pricelist: 'TRUE',
    P_shownewdevname: 'TRUE',
    P_DecimalBaths: 1,
    P_ShowGPSCoords: 'TRUE',
  });
  summary.details.push({ ref: p.Reference, httpStatus: status, keys: Object.keys(list(root?.Property)[0] ?? {}) });
  anonymise(root);
  save(`details-${String(p.Reference).replace(/[^A-Za-z0-9_-]/g, '_')}`, data);
}

save('summary', { ...summary, statusShapes: [...summary.statusShapes], keys: [...summary.keys].sort() });
say({ out: OUT, pages: summary.pages, ownField: summary.ownField, details: picks.length });
