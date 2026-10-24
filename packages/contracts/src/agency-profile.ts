import { z } from 'zod';
import { CurrencyCode, Money } from './common';
import { Email } from './identity';

/**
 * Agency profile and settings (S1-06, PLAN §6 Identity, §3 #6 #7 #8 #56).
 *
 * - **Profile** — the agency's public face for client-facing outputs: logo, brand colours, contact
 *   details and per-locale texts. Any member reads it; admins edit it.
 * - **Settings** — how the agency works: default commission, registration validity, viewing response
 *   time, enabled locales, white-label and Client Mode options. Any member reads them (commission is
 *   left out in Client Mode); admins change them, never while staff impersonate them.
 */

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────

/** Logo uploads until the media pipeline (S3-03): PNG, JPEG or WebP by magic bytes, ≤ 512 KB. */
export const AGENCY_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AGENCY_LOGO_MAX_BYTES = 512 * 1024;

/** `#rrggbb`, stored lower case. */
export const HexColor = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'a colour as #rrggbb');

/** A phone number as people write it: digits, spaces, + ( ) - only. */
export const ContactPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,24}$/, 'digits, spaces and + ( ) - only');

/** The agency's own website, http(s) only (it is linked from client-facing pages). */
export const WebsiteUrl = z
  .string()
  .trim()
  .max(200)
  .pipe(z.url({ protocol: /^https?$/i, hostname: z.regexes.domain }))
  // Lower-case scheme (`HTTPS://` → `https://`): the stored value matches the row CHECK and links work.
  .transform((url) => url.replace(/^https?:/i, (scheme) => scheme.toLowerCase()));

/** Text shown on client pages: no control characters (except new lines in `description`) and no < >. */
const LineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}<>]*$/u, 'no control characters or < >');
const ParagraphText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{Cc}<>]|[\n\t])*$/u, 'no control characters or < >');

/** Content locale code; the service checks it against the configured content locales. */
const LocaleCode = z.string().regex(/^[a-z]{2}$/);

/** An IANA time zone name (`Europe/Madrid`, `Atlantic/Canary`), checked against the runtime's `Intl` (S11-F11). */
const TimeZoneShape = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/);
/** The shape only (what the database stores and the DTO serves); `TimeZoneName` also asks `Intl`. */
export const TimeZoneName = TimeZoneShape.refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'unknown time zone');
export const DEFAULT_AGENCY_TIME_ZONE = 'Europe/Madrid';

export const AgencyTranslation = z
  .object({
    locale: LocaleCode,
    tagline: LineText(160).nullable(),
    description: ParagraphText(5000).nullable(),
  })
  .strict();
export type AgencyTranslation = z.infer<typeof AgencyTranslation>;

export const AgencyLogoDto = z.object({
  contentType: z.enum(AGENCY_LOGO_TYPES),
  sizeBytes: z.number().int(),
  updatedAt: z.iso.datetime(),
});

export const AgencyProfileDto = z.object({
  logo: AgencyLogoDto.nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  translations: z.array(AgencyTranslation),
  /** 0 until the first save. */
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type AgencyProfileDto = z.infer<typeof AgencyProfileDto>;

/**
 * `PUT /v1/agency/profile` — replaces the profile (optimistic `version`; 0 for the first save). The
 * translations listed replace all others: a locale left out is removed.
 */
export const UpdateAgencyProfileBody = z
  .object({
    version: z.number().int().nonnegative(),
    primaryColor: HexColor.nullable(),
    accentColor: HexColor.nullable(),
    contactEmail: Email.nullable(),
    contactPhone: ContactPhone.nullable(),
    websiteUrl: WebsiteUrl.nullable(),
    translations: z
      .array(AgencyTranslation)
      .max(20)
      .refine((v) => new Set(v.map((t) => t.locale)).size === v.length, 'one entry per locale'),
  })
  .strict();
export type UpdateAgencyProfileBody = z.infer<typeof UpdateAgencyProfileBody>;
export type UpdateAgencyProfileInput = z.input<typeof UpdateAgencyProfileBody>;

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

/** 100 % in basis points. */
export const MAX_COMMISSION_BP = 10_000;
/** The collaborating agent's share of a commission: 100 % in basis points. */
export const MAX_SPLIT_BP = 10_000;
/** €1,000,000,000.00: far above any real fee, below what a bigint of cents could misrepresent. */
export const MAX_FIXED_COMMISSION_CENTS = 100_000_000_000;

/** A commission (PLAN §3 #7): a percentage in basis points (`300` = 3 %) or a fixed amount. */
export const Commission = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('PCT'),
      basisPoints: z.number().int().min(1).max(MAX_COMMISSION_BP),
      includesVat: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('FIXED'),
      amount: Money.extend({ amountCents: z.number().int().min(1).max(MAX_FIXED_COMMISSION_CENTS) }).strict(),
      includesVat: z.boolean(),
    })
    .strict(),
]);
export type Commission = z.infer<typeof Commission>;

/** White-label options for client-facing outputs (PLAN §3 #6). */
export const WhiteLabelSettings = z
  .object({
    /** Prefix of listing references shown to clients (`CH` → `CH-1234`); 1–6 upper-case letters or digits. */
    referencePrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,6}$/, '1–6 letters or digits')
      .nullable(),
    showPoweredBy: z.boolean(),
    /** Sender name of client emails; the agency name when null. */
    emailSenderName: LineText(80).pipe(z.string().min(2)).nullable(),
  })
  .strict();
export type WhiteLabelSettings = z.infer<typeof WhiteLabelSettings>;

/** Client Mode PIN policy (PLAN §3 #56): the PIN that ends Client Mode. */
export const ClientModePolicy = z
  .object({
    pinMinLength: z.number().int().min(4).max(8),
    /** Wrong PINs before the session has to log in again. */
    pinMaxAttempts: z.number().int().min(3).max(10),
  })
  .strict();
export type ClientModePolicy = z.infer<typeof ClientModePolicy>;

export const AgencySettingsLimits = {
  registrationValidityDays: { min: 1, max: 1095 },
  viewingResponseDays: { min: 1, max: 30 },
} as const;

const settingsFields = {
  /** Total commission of new listings; a new agency starts from the `agency_settings` column defaults. */
  defaultCommission: Commission,
  /** The collaborating agent's share of that commission, 0–100 % in basis points (5000 = 50/50). */
  defaultSplitBp: z.number().int().min(0).max(MAX_SPLIT_BP),
  /** Client registration validity (PLAN §3 #8). */
  registrationValidityDays: z
    .number()
    .int()
    .min(AgencySettingsLimits.registrationValidityDays.min)
    .max(AgencySettingsLimits.registrationValidityDays.max),
  /** Days to answer another agency's viewing request. */
  viewingResponseDays: z
    .number()
    .int()
    .min(AgencySettingsLimits.viewingResponseDays.min)
    .max(AgencySettingsLimits.viewingResponseDays.max),
  /** Locales listings and the website are published in (content locales, PLAN §3 #14). */
  enabledLocales: z
    .array(LocaleCode)
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length, 'locales must be unique'),
  whiteLabel: WhiteLabelSettings,
  clientMode: ClientModePolicy,
};

/**
 * The agency's settings. Never served in Client Mode: they hold the commission and the PIN policy
 * (PLAN §3 #56).
 */
export const AgencySettingsDto = z.object({
  ...settingsFields,
  /** The agency's currency (S5-F3): new developments default to it. */
  currency: CurrencyCode,
  /** The agency's time zone (S11-F11): its "today" and "overdue", calendar days and reminder e-mail times. */
  timeZone: TimeZoneShape,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type AgencySettingsDto = z.infer<typeof AgencySettingsDto>;

/** `PUT /v1/agency/settings` — replaces the settings (optimistic `version`); no `currency` keeps the current one. */
export const UpdateAgencySettingsBody = z
  .object({
    version: z.number().int().positive(),
    ...settingsFields,
    currency: CurrencyCode.optional(),
    timeZone: TimeZoneName.optional(),
  })
  .strict();
export type UpdateAgencySettingsBody = z.infer<typeof UpdateAgencySettingsBody>;
export type UpdateAgencySettingsInput = z.input<typeof UpdateAgencySettingsBody>;
