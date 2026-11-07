/**
 * What a refused or finished collaboration action says (S17-F56). The codes and reasons are the ones `packages/core`'s mls
 * module throws (`service.ts`, `viewings.ts`, `crm.getContact`); the keys are i18n keys under `network.collaborations.errors`
 * and `.done`. The query parameter carries only these keys, so a crafted URL can show nothing but one of these sentences.
 */

export const REFUSALS = [
  'FORBIDDEN',
  'RATE_LIMITED',
  'NETWORK_GIVE_TO_GET_LOCKED',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'NO_CONTACT',
  'NO_EMAIL_OR_PHONE',
  'CONTACT_NOT_FOUND',
  'REGISTRATION_CONFLICT',
  'REGISTRATION_TARGET_NOT_FOUND',
  'REGISTRATION_NOT_FOUND',
  'TIME_REQUIRED',
  'PAST',
  'AFTER_REGISTRATION',
  'VIEWING_REQUEST_NOT_FOUND',
  'VIEWING_REQUEST_OPEN',
  'VIEWING_TERMS_INCOMPLETE',
  'STATE_CLOSED',
  'STATE_EXPIRED',
  'STATE_NOT_AWAITING',
  'STATE_TOO_LATE',
  'STATE_NOT_SCHEDULED',
  'STATE_TOO_EARLY',
  'STATE_CHANGED',
  // R2-04c: opening the deal of a viewing
  'DEAL_VIEWING_NOT_ELIGIBLE',
  'generic',
] as const;
export type Refusal = (typeof REFUSALS)[number];

export const DONE_NOTICES = [
  'registered',
  'alreadyRegistered',
  'viewingRequested',
  'accepted',
  'declined',
  'rescheduled',
  'cancelled',
  'outcome',
] as const;
export type DoneNotice = (typeof DONE_NOTICES)[number];

/** `VALIDATION_FAILED` reasons the services give (`details.reason`). */
const VALIDATION_REASONS: Record<string, Refusal> = {
  past: 'PAST',
  after_registration: 'AFTER_REGISTRATION',
  no_email_or_phone: 'NO_EMAIL_OR_PHONE',
};

/** `VIEWING_REQUEST_STATE` reasons (`viewings.ts`). */
const STATE_REASONS: Record<string, Refusal> = {
  closed: 'STATE_CLOSED',
  expired: 'STATE_EXPIRED',
  not_awaiting: 'STATE_NOT_AWAITING',
  too_late: 'STATE_TOO_LATE',
  not_scheduled: 'STATE_NOT_SCHEDULED',
  too_early: 'STATE_TOO_EARLY',
  changed: 'STATE_CHANGED',
};

/** The sentence for an API refusal, by `error.code` and, where the code has several causes, `details.reason`. */
export function refusalOf(error: { code: string; details?: Record<string, unknown> | undefined } | null): Refusal {
  if (!error) return 'generic';
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : '';
  if (error.code === 'VALIDATION_FAILED') return VALIDATION_REASONS[reason] ?? 'VALIDATION_FAILED';
  if (error.code === 'VIEWING_REQUEST_STATE') return STATE_REASONS[reason] ?? 'STATE_CHANGED';
  return (REFUSALS as readonly string[]).includes(error.code) ? (error.code as Refusal) : 'generic';
}

/** The `error` query parameter as a known key; anything else is the neutral sentence, and no parameter is nothing. */
export function parseRefusal(value: string | undefined): Refusal | null {
  if (!value) return null;
  return (REFUSALS as readonly string[]).includes(value) ? (value as Refusal) : 'generic';
}

export function parseDone(value: string | undefined): DoneNotice | null {
  return (DONE_NOTICES as readonly string[]).includes(value ?? '') ? (value as DoneNotice) : null;
}
