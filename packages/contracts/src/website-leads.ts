import { z } from 'zod';
import { Email } from './identity';
import { WebsiteLang, WebsiteListingParams } from './websites';

/**
 * Website lead intake (S7-05, PLAN §9.1 `POST /v2/leads`, `POST /v2/viewing-requests`): a visitor's enquiry or viewing
 * request as a site's form sends it. Every field is validated and size-capped here; the lead belongs to the site's
 * agency (the presenting agency, PLAN §3 #12), also for another agency's network listing.
 *
 * Visitor checks: a **publishable** key (browser widget) sends the Cloudflare Turnstile token of the form
 * (`turnstileToken`); a **secret** key (the site's server, e.g. the WordPress plugin) either forwards the visitor's
 * Turnstile token or states that it ran its own check (`serverVerified: true`). Every post needs an `Idempotency-Key`
 * header: a repeated submission with the same key answers the first one's result and creates no second lead.
 */

/** Control characters (C0, DEL, C1), except tab, line feed and carriage return: free text keeps its lines. */
const hasControl = (s: string) => /\p{Cc}/u.test(s.replace(/[\t\n\r]/g, ''));
/** One line of text: no control characters at all, no markup brackets. */
const LINE = /^[^\p{Cc}<>]*$/u;
/** Names never carry links or domains (form spam, phishing via the acknowledgement does), nor digit runs. */
const LINK = /(?:https?:\/\/|www\.|\.[a-z]{2,}|\d{2,})/i;

export const LEAD_LIMITS = {
  name: 120,
  phone: 32,
  message: 4_000,
  pageUrl: 2_048,
  turnstileToken: 2_048,
  viewingSlots: 3,
} as const;

const LeadName = z
  .string()
  .trim()
  .min(1)
  .max(LEAD_LIMITS.name)
  .regex(LINE)
  .refine((s) => !LINK.test(s), { message: 'no links, domains or numbers' });

const LeadPhone = z
  .string()
  .trim()
  .max(LEAD_LIMITS.phone)
  .regex(/^\+?[0-9 ().-]{6,24}$/);

const LeadMessage = z
  .string()
  .trim()
  .min(1)
  .max(LEAD_LIMITS.message)
  .refine((s) => !hasControl(s), { message: 'control characters' });

/** The page the form was on: https only (no `javascript:` or data URLs ever reach an e-mail or the CRM). */
const PageUrl = z
  .string()
  .trim()
  .max(LEAD_LIMITS.pageUrl)
  .refine((s) => {
    try {
      return new URL(s).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'https URL');

const leadFields = {
  name: LeadName,
  email: Email,
  phone: LeadPhone.optional(),
  /** The visitor's language: one of the site's languages (default the site's first). The acknowledgement uses it. */
  lang: WebsiteLang.optional(),
  pageUrl: PageUrl.optional(),
  /** The visitor accepted the site's privacy notice (required: the agency processes the enquiry). */
  privacyAccepted: z.literal(true),
  /** The visitor opted in to marketing e-mails. */
  marketingConsent: z.boolean().default(false),
  /** The form's Cloudflare Turnstile response (`cf-turnstile-response`). Required for publishable keys. */
  turnstileToken: z.string().min(1).max(LEAD_LIMITS.turnstileToken).optional(),
  /** Secret keys only: the site's server checked the visitor itself (its own CAPTCHA), so no Turnstile token. */
  serverVerified: z.literal(true).optional(),
};

/** `POST /v2/leads`: an enquiry — about a listing or unit (`ref`, as the site shows it), or general (no `ref`). */
export const WebsiteLeadBody = z.strictObject({
  ...leadFields,
  ref: WebsiteListingParams.shape.ref.optional(),
  message: LeadMessage.optional(),
});
export type WebsiteLeadBody = z.infer<typeof WebsiteLeadBody>;

export const ViewingTimeOfDay = z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'ANY']);

const DAY_MS = 86_400_000;
/** A slot day from today (a day of slack for time zones) to a year ahead, read at validation time. */
function slotDayInRange(date: string): boolean {
  const day = Date.parse(`${date}T00:00:00Z`);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return day >= today - DAY_MS && day <= today + 366 * DAY_MS;
}

/** A preferred viewing slot: a calendar day (today to a year ahead) and a part of it. */
export const ViewingSlot = z.strictObject({
  date: z.iso.date().refine(slotDayInRange, { message: 'from today to a year ahead' }),
  timeOfDay: ViewingTimeOfDay,
});
export type ViewingSlot = z.infer<typeof ViewingSlot>;

/** `POST /v2/viewing-requests`: a viewing of one listing or unit, with up to three preferred slots. */
export const WebsiteViewingRequestBody = z.strictObject({
  ...leadFields,
  ref: WebsiteListingParams.shape.ref,
  message: LeadMessage.optional(),
  slots: z
    .array(ViewingSlot)
    .min(1)
    .max(LEAD_LIMITS.viewingSlots)
    .refine((s) => new Set(s.map((x) => `${x.date}|${x.timeOfDay}`)).size === s.length, { message: 'duplicate slot' }),
});
export type WebsiteViewingRequestBody = z.infer<typeof WebsiteViewingRequestBody>;

/** `Idempotency-Key`: one per form submission (e.g. a UUID made when the form is shown), kept 24 h per site. */
export const IdempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const WebsiteLeadHeaders = z.object({ 'idempotency-key': IdempotencyKey });

/**
 * The answer: the lead's id (for support; carries nothing about the visitor). `201` when created, `200` with
 * `replayed: true` for a repeated submission with the same `Idempotency-Key` and body.
 */
export const WebsiteLeadAccepted = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['ENQUIRY', 'VIEWING_REQUEST']),
  status: z.literal('RECEIVED'),
  replayed: z.boolean(),
});
export type WebsiteLeadAccepted = z.infer<typeof WebsiteLeadAccepted>;
