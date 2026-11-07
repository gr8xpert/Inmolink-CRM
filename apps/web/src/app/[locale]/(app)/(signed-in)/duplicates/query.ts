import { DEDUPE_DISPUTE_KINDS, DEDUPE_REVIEW_STATUSES, type DedupeReviewStatus } from '@inmolink/contracts';

/** The duplicate pages' URL and form state (R2-03b): pure parsers, unit-tested. Anything unknown is dropped. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

export interface DuplicatesState {
  view: 'reviews' | 'clusters';
  status: DedupeReviewStatus;
  cursor?: string;
}

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export function parseDuplicatesState(q: Record<string, string | string[] | undefined>): DuplicatesState {
  const view = one(q.view) === 'clusters' ? 'clusters' : 'reviews';
  const status = DEDUPE_REVIEW_STATUSES.find((s) => s === one(q.status)) ?? 'PENDING';
  const cursor = one(q.cursor);
  return { view, status, ...(cursor && CURSOR.test(cursor) ? { cursor } : {}) };
}

/** The view's query without the page position. */
export function viewQuery(s: DuplicatesState): Record<string, string> {
  return {
    ...(s.view === 'clusters' ? { view: s.view } : {}),
    ...(s.view === 'reviews' && s.status !== 'PENDING' ? { status: s.status } : {}),
  };
}

/** The view a form came from (`back.*` fields), re-validated. */
export function backQuery(form: FormData): Record<string, string> {
  const get = (k: string) => {
    const v = form.get(`back.${k}`);
    return typeof v === 'string' ? v : undefined;
  };
  return viewQuery(parseDuplicatesState({ view: get('view'), status: get('status') }));
}

const MOVES = ['confirm', 'not-duplicate'] as const;

export function parseDecision(form: FormData): { id: string; move: (typeof MOVES)[number] } | null {
  const id = form.get('id');
  const move = MOVES.find((m) => m === form.get('move'));
  return typeof id === 'string' && UUID.test(id) && move ? { id, move } : null;
}

export function parseDispute(
  form: FormData,
): { listingId: string; kind: (typeof DEDUPE_DISPUTE_KINDS)[number]; reason: string } | null {
  const listingId = form.get('listingId');
  const kind = DEDUPE_DISPUTE_KINDS.find((k) => k === form.get('kind'));
  const reason = form.get('reason');
  if (typeof listingId !== 'string' || !UUID.test(listingId) || !kind || typeof reason !== 'string') return null;
  const text = reason.trim();
  return text.length > 0 && text.length <= 1000 ? { listingId, kind, reason: text } : null;
}

/** A move's outcome from the URL (`done`). */
export function doneOf(v: string | string[] | undefined): 'CONFIRMED' | 'NOT_DUPLICATE' | 'disputed' | null {
  return (['CONFIRMED', 'NOT_DUPLICATE', 'disputed'] as const).find((s) => s === v) ?? null;
}
