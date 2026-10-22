/**
 * Branding of the iFrame embed pages (S7-F8, PLAN §9.5): the presenting agency's name, contacts and colours as the
 * pages may use them. Every value comes from an agency (its profile, the site's contact overrides) and ends up in HTML
 * and CSS on another site's page, so each is reduced to a strict shape here — nothing passes through as written:
 *
 * - colours: `#rgb` / `#rrggbb` only (lower case), else none — never raw CSS, so no `;`, `}`, `url(` or `expression(`
 *   can reach a style declaration;
 * - URLs (website, logo): absolute `https:` with a host and no credentials, else none — no `javascript:`, `data:` or
 *   `http:`; the pages never fetch a logo server-side (the browser loads it, under the page's `img-src`);
 * - texts: plain text, one line, control and bidi-override characters removed, length-capped; React escapes them when
 *   rendering (no HTML is ever injected).
 *
 * Pure functions: no I/O.
 */
import type { WebsitePresenter } from '@inmolink/contracts';

export interface EmbedBranding {
  name: string;
  email: string | null;
  phone: string | null;
  /** Digits only (a `wa.me` link). */
  whatsapp: string | null;
  website: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** A brand colour as `#rgb` / `#rrggbb` (lower case), or null for anything else (names, functions, CSS). */
export function brandColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return HEX_COLOR.test(v) ? v : null;
}

/** An absolute `https:` URL with a host and no user info (normalized), or null. */
export function httpsUrl(value: string | null | undefined, max = 2_048): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '' || v.length > max) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

// C0/C1 controls, zero-width and bidi controls (a right-to-left override would disguise the text).
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Plain text on one line: invisible and control characters removed, whitespace collapsed, at most `max` chars. */
export function plainBrandText(value: string | null | undefined, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (v === '') return null;
  return Array.from(v).slice(0, max).join('').trim();
}

const EMAIL =
  /^[^\s@<>()"',;:\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PHONE = /^\+?[0-9 ().-]{6,24}$/;

/** The presenting agency as the embed pages show it: every value checked (module comment). */
export function embedBranding(presenter: WebsitePresenter, extra: { logoUrl?: string | null } = {}): EmbedBranding {
  const email = presenter.email?.trim() ?? '';
  const phone = presenter.phone?.trim() ?? '';
  const whatsapp = (presenter.whatsapp ?? '').replace(/[\s().-]/g, '');
  return {
    name: plainBrandText(presenter.name) ?? '',
    email: email.length <= 254 && EMAIL.test(email) ? email : null,
    phone: PHONE.test(phone) ? phone : null,
    whatsapp: /^\+?[0-9]{6,20}$/.test(whatsapp) ? whatsapp.replace('+', '') : null,
    website: httpsUrl(presenter.website),
    logoUrl: httpsUrl(extra.logoUrl ?? null),
    primaryColor: brandColor(presenter.primaryColor),
    accentColor: brandColor(presenter.accentColor),
  };
}

/** Relative luminance of a `#rgb` / `#rrggbb` colour (WCAG 2). */
function luminance(hex: string): number {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/g, (c) => c + c).slice(1) : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The text colour (white or near-black) with the better contrast on a background colour. */
export function onColor(background: string): '#ffffff' | '#111111' {
  const l = luminance(background);
  // Contrast against white (1.0) and near-black (#111 ≈ 0.0056).
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0556 ? '#ffffff' : '#111111';
}

/** Default colours when the agency has none (neutral, AA on white). */
export const EMBED_DEFAULT_COLORS = { primary: '#1f2937', accent: '#2563eb' } as const;

/**
 * The CSS custom properties the embed pages are themed with: checked colours only, so a style attribute built from
 * them carries nothing but `#hex` values.
 */
export function brandStyle(branding: Pick<EmbedBranding, 'primaryColor' | 'accentColor'>): Record<string, string> {
  const primary = branding.primaryColor ?? EMBED_DEFAULT_COLORS.primary;
  const accent = branding.accentColor ?? EMBED_DEFAULT_COLORS.accent;
  return {
    '--embed-primary': primary,
    '--embed-on-primary': onColor(primary),
    '--embed-accent': accent,
    '--embed-on-accent': onColor(accent),
  };
}

/**
 * `frame-ancestors` sources of a site: `https://<host>` for each of its stored domains that is a plain host name (the
 * site contract's `SiteDomain` shape, checked again here) — no wildcard, scheme, port or path, nothing else.
 */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

export function embedFrameAncestors(domains: readonly string[]): string[] {
  const out = new Set<string>();
  for (const d of domains) {
    if (typeof d === 'string' && d.length <= 253 && HOST.test(d)) out.add(`https://${d}`);
  }
  return [...out];
}
