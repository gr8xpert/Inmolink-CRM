import { CLIENT_PROFILE_MATCH_STATUSES, type ClientProfileMatchStatus } from '@inmolink/contracts';

/** The review queue's URL state (R2-02d): pure parsers, unit-tested. Anything unknown is dropped, never passed on. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

export interface MatchQueueState {
  status: 'PENDING_REVIEW' | 'DISMISSED';
  contact?: string;
  profile?: string;
  cursor?: string;
}

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export function parseQueueState(q: Record<string, string | string[] | undefined>): MatchQueueState {
  const status = one(q.status) === 'DISMISSED' ? 'DISMISSED' : 'PENDING_REVIEW';
  const contact = one(q.contact);
  const profile = one(q.profile);
  const cursor = one(q.cursor);
  return {
    status,
    // one filter at a time (the API refuses both): a profile is the narrower one
    ...(profile && UUID.test(profile) ? { profile } : contact && UUID.test(contact) ? { contact } : {}),
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
  };
}

/** The view's query without the page position (a move returns to the first page of the same view). */
export function viewQuery(s: MatchQueueState): Record<string, string> {
  return {
    ...(s.status === 'DISMISSED' ? { status: s.status } : {}),
    ...(s.contact ? { contact: s.contact } : {}),
    ...(s.profile ? { profile: s.profile } : {}),
  };
}

/** The view a move form came from (`back.*` fields), re-validated. */
export function backQuery(form: FormData): Record<string, string> {
  const get = (k: string) => {
    const v = form.get(`back.${k}`);
    return typeof v === 'string' ? v : undefined;
  };
  return viewQuery(parseQueueState({ status: get('status'), contact: get('contact'), profile: get('profile') }));
}

const MOVES = ['approve', 'dismiss', 'restore'] as const;

export function parseMove(form: FormData): { id: string; move: (typeof MOVES)[number] } | null {
  const id = form.get('id');
  const move = form.get('move');
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const known = MOVES.find((m) => m === move);
  return known ? { id, move: known } : null;
}

/** A move's outcome from the URL (`done`): a match status, else nothing. */
export function doneStatus(v: string | string[] | undefined): ClientProfileMatchStatus | null {
  return CLIENT_PROFILE_MATCH_STATUSES.find((s) => s === v) ?? null;
}

export const isUuid = (v: string | string[] | undefined): v is string => typeof v === 'string' && UUID.test(v);
