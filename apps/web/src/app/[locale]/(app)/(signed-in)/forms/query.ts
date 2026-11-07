import {
  FORM_SIGNER_ROLES,
  FORM_TEMPLATES,
  type FormTemplate,
  SIGNATURE_EXPIRY_DAYS_MAX,
  SIGNATURE_SIGNERS_MAX,
  type SignatureSignerInput,
} from '@inmolink/contracts';
import { isUiLocale } from '@inmolink/i18n';

/**
 * The forms screens' parsers (R2-05c): query parameters and posted fields into what the API takes. Only shape checks —
 * malformed input never reaches the API, every rule stays the API's.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const KEY = /^[A-Za-z0-9-]{16,64}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const uuidOf = (v: string | string[] | undefined): string | undefined => {
  const s = one(v);
  return isUuid(s) ? s : undefined;
};
export const cursorOf = (v: string | string[] | undefined): string | undefined => {
  const s = one(v);
  return s && CURSOR.test(s) ? s : undefined;
};
export const templateOf = (v: string | string[] | undefined): FormTemplate | undefined =>
  FORM_TEMPLATES.find((t) => t === one(v));
export const isIdempotencyKey = (v: string) => KEY.test(v);

/** The forms the generate screen makes (the collaboration agreement is made from its deal room). */
export const GENERATED_TEMPLATES = FORM_TEMPLATES.filter((t) => t !== 'COLLABORATION_AGREEMENT');

/** Notices a forms screen shows after an action (`?done=`). */
export const FORM_NOTICES = ['created', 'sent'] as const;
export type FormNotice = (typeof FORM_NOTICES)[number];
export const formNoticeOf = (v: string | string[] | undefined): FormNotice | null =>
  FORM_NOTICES.find((n) => n === one(v)) ?? null;

/** Error codes the forms screens explain (`documents.dashboard.errors.*`); any other is the generic message. */
export const FORM_ERRORS = [
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'FORMS_NOT_ENABLED',
  'ESIGN_NOT_ENABLED',
  'FORM_DOCUMENT_NOT_FOUND',
  'FORM_DATA_INCOMPLETE',
  'FORM_NOT_READY',
  'FORM_ALREADY_SIGNED',
  'SIGNERS_INVALID',
  'SIGNATURE_REQUEST_NOT_FOUND',
  'DEAL_NOT_FOUND',
  'DEAL_STATE',
  'CONTACT_NOT_FOUND',
  'LISTING_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'AGREEMENT_IN_SIGNATURE',
] as const;
/** `SIGNERS_INVALID` reasons (`documents.dashboard.errors.signers.*`). */
export const SIGNER_REASONS = ['role', 'party', 'duplicate', 'deal', 'party_member'] as const;

export const errorOf = (v: string | string[] | undefined): string | null => {
  const s = one(v);
  if (!s) return null;
  return (FORM_ERRORS as readonly string[]).includes(s) ? s : 'generic';
};
export const reasonOf = (v: string | string[] | undefined): string | null => {
  const s = one(v);
  return s && (SIGNER_REASONS as readonly string[]).includes(s) ? s : null;
};

/** The i18n key of an error code and its reason, under `documents.dashboard.errors`. */
export function errorKey(code: string, reason: string | null): string {
  if (code === 'SIGNERS_INVALID' && reason) return `signers.${reason}`;
  return code;
}

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * The signer rows of a send-for-signature form (`signer.<n>.name|email|role|locale`): rows left empty are skipped; a
 * half-filled row, an unknown role or an unknown language is invalid (null). At most `SIGNATURE_SIGNERS_MAX`.
 */
export function signersOf(form: FormData, template: FormTemplate): SignatureSignerInput[] | null {
  const roles = FORM_SIGNER_ROLES[template];
  const out: SignatureSignerInput[] = [];
  for (let i = 0; i < SIGNATURE_SIGNERS_MAX; i++) {
    const name = text(form, `signer.${i}.name`);
    const email = text(form, `signer.${i}.email`);
    const role = text(form, `signer.${i}.role`);
    const locale = text(form, `signer.${i}.locale`);
    if (!name && !email) continue;
    if (!name || !email || name.length > 200 || email.length > 254 || !roles.includes(role)) return null;
    if (locale && !isUiLocale(locale)) return null;
    out.push({ name, email, role, ...(locale ? { locale } : {}) });
  }
  return out.length > 0 ? out : null;
}

/** The request options of a send-for-signature form: order, expiry (days; empty: the API's default), message. */
export function requestOptionsOf(
  form: FormData,
): { ordered: boolean; expiresInDays?: number; message?: string } | null {
  const raw = text(form, 'expiresInDays');
  const days = Number(raw);
  const message = text(form, 'message');
  if (raw && (!Number.isInteger(days) || days < 1 || days > SIGNATURE_EXPIRY_DAYS_MAX)) return null;
  if (message.length > 1000) return null;
  return {
    ordered: form.get('ordered') === 'on',
    ...(raw ? { expiresInDays: days } : {}),
    ...(message ? { message } : {}),
  };
}
