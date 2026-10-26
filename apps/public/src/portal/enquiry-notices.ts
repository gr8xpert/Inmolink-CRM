/**
 * The enquiry form's answers (S15-02; own module since S15-03 so the proxy can check `?enquiry=` without loading the
 * form post's server code). A page's no-JavaScript answer comes back as `?enquiry=<notice>`.
 */

/** The answers a visitor may see (`portal.enquiry.notices.*`). */
export const ENQUIRY_NOTICES = [
  'sent',
  'VALIDATION_FAILED',
  'TURNSTILE_FAILED',
  'RATE_LIMITED',
  'LISTING_NOT_FOUND',
  'NOT_FOUND',
  'generic',
] as const;
export type EnquiryNotice = (typeof ENQUIRY_NOTICES)[number];

/** The query parameter the answer rides in. */
export const ENQUIRY_PARAM = 'enquiry';

/**
 * The `enquiry` parameter of a query string: `none` (absent), `notice` (exactly one known answer) or `junk` (any other
 * value, or repeated) — junk never becomes a page or a cache key of its own.
 */
export function enquiryParamOf(search: string): 'none' | 'notice' | 'junk' {
  const values = new URLSearchParams(search).getAll(ENQUIRY_PARAM);
  if (values.length === 0) return 'none';
  return values.length === 1 && (ENQUIRY_NOTICES as readonly string[]).includes(values[0] as string)
    ? 'notice'
    : 'junk';
}

/** The query string without the form's answer (`?`-prefixed or empty). */
export function withoutEnquiryParam(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(ENQUIRY_PARAM)) return search;
  params.delete(ENQUIRY_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
