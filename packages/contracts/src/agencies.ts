import { z } from 'zod';

/**
 * Agency DTOs (S1-01): the tenant's company details, captured at sign-up (kind + name) and completed
 * in onboarding (tax id, address, region, languages). PLAN §3 #1 #3, §6 Identity.
 */

/** What a sign-up may create. PARTNER agencies (R4) are created by staff. */
export const SignupAgencyKind = z.enum(['AGENCY', 'DEVELOPER']);
export type SignupAgencyKind = z.infer<typeof SignupAgencyKind>;

export const AgencyKind = z.enum(['AGENCY', 'DEVELOPER', 'PARTNER']);
export type AgencyKind = z.infer<typeof AgencyKind>;

export const AgencyStatus = z.enum(['PENDING', 'VERIFIED', 'SUSPENDED']);
export type AgencyStatus = z.infer<typeof AgencyStatus>;

/**
 * Trading name. It appears in emails and on client-facing pages, so no markup and nothing that a mail
 * client would turn into a link ("evil.example"); "Costa Homes S.L." is fine.
 */
export const CompanyName = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[\p{L}\p{M}\p{N} &'.,()/-]+$/u, "letters, digits, spaces and & ' . , ( ) / - only")
  .refine((v) => !/[\p{L}\p{N}]\.[\p{L}]{2,}/u.test(v), 'must not look like a web address');

/** ISO 3166-2:ES codes of the 17 autonomous communities plus Ceuta and Melilla. */
export const SPANISH_REGIONS = [
  'ES-AN',
  'ES-AR',
  'ES-AS',
  'ES-CB',
  'ES-CE',
  'ES-CL',
  'ES-CM',
  'ES-CN',
  'ES-CT',
  'ES-EX',
  'ES-GA',
  'ES-IB',
  'ES-MC',
  'ES-MD',
  'ES-ML',
  'ES-NC',
  'ES-PV',
  'ES-RI',
  'ES-VC',
] as const;
export const SpanishRegion = z.enum(SPANISH_REGIONS);
export type SpanishRegion = z.infer<typeof SpanishRegion>;

/** Spanish postal code: five digits, province prefix 01–52. */
export const SpanishPostalCode = z
  .string()
  .trim()
  .regex(/^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/, 'a Spanish postal code has five digits (01000–52999)');

// ---------------------------------------------------------------------------------------------
// CIF / NIF / NIE (Spanish tax identification numbers)
// ---------------------------------------------------------------------------------------------

export type SpanishTaxIdKind = 'NIF' | 'NIE' | 'CIF';

export type SpanishTaxIdResult =
  | { ok: true; kind: SpanishTaxIdKind; value: string }
  | { ok: false; reason: 'format' | 'control' };

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const CIF_CONTROL_LETTERS = 'JABCDEFGHI';
/** CIF entity letters whose control character must be a letter / a digit; the rest accept either. */
const CIF_LETTER_CONTROL = new Set(['N', 'P', 'Q', 'R', 'S', 'W']);
const CIF_DIGIT_CONTROL = new Set(['A', 'B', 'E', 'H']);

/** Upper-cases and drops spaces, dots, hyphens and an `ES` VAT prefix: `es-b12.345.674` → `B12345674`. */
export function normalizeTaxId(raw: string): string {
  const compact = raw.toUpperCase().replace(/[\s.\-/]/g, '');
  return compact.startsWith('ES') && compact.length === 11 ? compact.slice(2) : compact;
}

function cifControlDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(digits[i]);
    if (i % 2 === 1) {
      sum += d;
    } else {
      const doubled = d * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    }
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Validates a Spanish tax id with its control character (AEAT rules): NIF (DNI: 8 digits + letter;
 * K/L/M + 7 digits + letter), NIE (X/Y/Z + 7 digits + letter) and CIF (entity letter + 7 digits +
 * control digit or letter). Returns the normalized value or why it failed.
 */
export function parseSpanishTaxId(raw: string): SpanishTaxIdResult {
  const v = normalizeTaxId(raw);

  let m = /^(\d{8})([A-Z])$/.exec(v);
  if (m) {
    return DNI_LETTERS[Number(m[1]) % 23] === m[2] ? { ok: true, kind: 'NIF', value: v } : fail('control');
  }
  m = /^([KLM])(\d{7})([A-Z])$/.exec(v);
  if (m) {
    return DNI_LETTERS[Number(m[2]) % 23] === m[3] ? { ok: true, kind: 'NIF', value: v } : fail('control');
  }
  m = /^([XYZ])(\d{7})([A-Z])$/.exec(v);
  if (m) {
    const n = Number(`${'XYZ'.indexOf(m[1] as string)}${m[2]}`);
    return DNI_LETTERS[n % 23] === m[3] ? { ok: true, kind: 'NIE', value: v } : fail('control');
  }
  m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(v);
  if (m) {
    const [, entity, digits, control] = m as unknown as [string, string, string, string];
    const c = cifControlDigit(digits);
    const asDigit = control === String(c);
    const asLetter = control === CIF_CONTROL_LETTERS[c];
    const valid = CIF_LETTER_CONTROL.has(entity)
      ? asLetter
      : CIF_DIGIT_CONTROL.has(entity)
        ? asDigit
        : asDigit || asLetter;
    return valid ? { ok: true, kind: 'CIF', value: v } : fail('control');
  }
  return fail('format');
}

function fail(reason: 'format' | 'control'): SpanishTaxIdResult {
  return { ok: false, reason };
}

export const TAX_ID_MESSAGES = {
  format: 'not a Spanish CIF, NIF or NIE (e.g. B12345674, 12345678Z, X1234567L)',
  control: 'the control digit or letter does not match — check the number for typos',
} as const;

/** CIF/NIF/NIE, normalized on success. Issues carry `params.reason` (`format` | `control`) for UIs. */
export const SpanishTaxId = z
  .string()
  .max(32)
  .transform((raw, ctx) => {
    const parsed = parseSpanishTaxId(raw);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: 'custom', message: TAX_ID_MESSAGES[parsed.reason], params: { reason: parsed.reason } });
    return z.NEVER;
  });

/** Address text: printed on PDFs, emails and staff screens, so no control characters or markup. */
const AddressText = z
  .string()
  .trim()
  .regex(/^[^\p{Cc}<>]*$/u, 'no control characters or < >');

/** Languages the agency works in: content locale codes; the service checks them against i18n config. */
export const AgencyLanguages = z
  .array(z.string().regex(/^[a-z]{2}$/))
  .min(1)
  .max(20)
  .refine((v) => new Set(v).size === v.length, 'languages must be unique');

export const AgencyDto = z.object({
  id: z.uuid(),
  kind: AgencyKind,
  status: AgencyStatus,
  name: z.string(),
  taxId: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  region: SpanishRegion.nullable(),
  languages: z.array(z.string()),
  /** Company details complete (onboarding done); staff verification can start (S1-03). */
  onboarded: z.boolean(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type AgencyDto = z.infer<typeof AgencyDto>;

/** `PUT /v1/agency/details` — the onboarding form; also edits the details later (optimistic `version`). */
export const UpdateAgencyDetailsBody = z
  .object({
    version: z.number().int().positive(),
    name: CompanyName,
    taxId: SpanishTaxId,
    addressLine: AddressText.pipe(z.string().min(3).max(200)),
    city: AddressText.pipe(z.string().min(2).max(100)),
    postalCode: SpanishPostalCode,
    region: SpanishRegion,
    languages: AgencyLanguages,
  })
  .strict();
export type UpdateAgencyDetailsBody = z.infer<typeof UpdateAgencyDetailsBody>;
export type UpdateAgencyDetailsInput = z.input<typeof UpdateAgencyDetailsBody>;
