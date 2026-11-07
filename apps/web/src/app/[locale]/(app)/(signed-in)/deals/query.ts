import { DEAL_STAGES, type DealDto, type DealPrice, type DealStage } from '@inmolink/contracts';

/**
 * The deal room's URL and form state (R2-04c): pure parsers, unit-tested. Anything unknown is dropped; the API is the
 * authority on every value (these only keep a malformed form from reaching it).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const CURRENCY = /^[A-Z]{3}$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export interface DealsState {
  stage?: DealStage;
  cursor?: string;
}

export function parseDealsState(q: Record<string, string | string[] | undefined>): DealsState {
  const stage = DEAL_STAGES.find((s) => s === one(q.stage));
  const cursor = one(q.cursor);
  return { ...(stage ? { stage } : {}), ...(cursor && CURSOR.test(cursor) ? { cursor } : {}) };
}

/**
 * A price typed in whole units or with cents (`250000`, `250000,50`, `250.000,50` — thousands dots or spaces dropped)
 * in `currency`; null when it is not one.
 */
export function parsePrice(amount: string, currency: string): DealPrice | null {
  // \s covers the no-break space of a formatted number
  const plain = amount.trim().replace(/[\s.,](?=\d{3}(\D|$))/g, '');
  if (!/^\d{1,11}([.,]\d{1,2})?$/.test(plain) || !CURRENCY.test(currency)) return null;
  const [whole = '0', frac = ''] = plain.split(/[.,]/);
  const amountCents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return amountCents >= 1 ? { amountCents, currency } : null;
}

/** The price fields of a form (`amount`, `currency`). */
export const priceOf = (form: FormData): DealPrice | null =>
  parsePrice(text(form, 'amount'), text(form, 'currency').toUpperCase());

/** The price a member saw (hidden `seenCents`, `currency`): what confirming the completion names. */
export function seenPriceOf(form: FormData): DealPrice | null {
  const cents = text(form, 'seenCents');
  const currency = text(form, 'currency');
  if (!/^\d{1,14}$/.test(cents) || !CURRENCY.test(currency)) return null;
  const amountCents = Number(cents);
  return amountCents >= 1 ? { amountCents, currency } : null;
}

/** A free-text reason or note (1–2,000 characters after trimming). */
export function reasonOf(form: FormData, name = 'reason'): string | null {
  const v = text(form, name);
  return v.length >= 1 && v.length <= 2_000 ? v : null;
}

/** The open stages in order, as the timeline shows them; the deal's place on it. */
export const TIMELINE: readonly DealStage[] = ['OFFER', 'RESERVATION', 'ARRAS', 'COMPLETION'];

export type StepState = 'done' | 'current' | 'next' | 'skipped';

/**
 * Each timeline step's state: before the current stage `done`, the current one `current` (`done` once completed),
 * later ones `next`. A deal that fell through shows every step `skipped` (the fall-through is shown on its own).
 */
export function timelineSteps(d: Pick<DealDto, 'stage' | 'completedAt'>): { stage: DealStage; state: StepState }[] {
  if (d.stage === 'FELL_THROUGH') return TIMELINE.map((stage) => ({ stage, state: 'skipped' }));
  const at = TIMELINE.indexOf(d.stage);
  return TIMELINE.map((stage, i) => ({
    stage,
    state: i < at || (i === at && d.completedAt !== null) ? 'done' : i === at ? 'current' : 'next',
  }));
}

/** The stages a party may move an open deal forward to by hand (never back; completion is the handshake's). */
export function advanceTargets(stage: DealStage): ('RESERVATION' | 'ARRAS')[] {
  if (stage === 'OFFER') return ['RESERVATION', 'ARRAS'];
  if (stage === 'RESERVATION') return ['ARRAS'];
  return [];
}

/** Whose half of the handshake is in (the caller's side first). */
export function handshake(d: Pick<DealDto, 'party' | 'ownerConfirmedAt' | 'introducerConfirmedAt'>): {
  mine: string | null;
  theirs: string | null;
} {
  return d.party === 'OWNER'
    ? { mine: d.ownerConfirmedAt, theirs: d.introducerConfirmedAt }
    : { mine: d.introducerConfirmedAt, theirs: d.ownerConfirmedAt };
}

const NOTICES = [
  'opened',
  'advanced',
  'priced',
  'confirmed',
  'withdrawn',
  'fellThrough',
  'uploaded',
  'removed',
  'taskAdded',
  'disputed',
] as const;
export type DealNotice = (typeof NOTICES)[number];

export const noticeOf = (v: string | string[] | undefined): DealNotice | null =>
  NOTICES.find((n) => n === one(v)) ?? null;
