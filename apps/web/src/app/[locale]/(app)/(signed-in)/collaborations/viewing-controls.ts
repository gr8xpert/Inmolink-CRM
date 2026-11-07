import type { ViewingRequestDto } from '@inmolink/contracts';

/**
 * Why a viewing row offers less than it might (S17-F56). What it offers is the API's (`allowedActions`, by the database's
 * clock); these are display-only sentences from the state, keys under `network.collaborations.hints`.
 */
export type ViewingHint = 'BIND_LISTING' | 'BIND_DEVELOPMENT' | 'OUTCOME_LATER' | 'LAPSED';

export function viewingHints(
  v: Pick<ViewingRequestDto, 'status' | 'expiresAt' | 'target' | 'mayBind' | 'allowedActions'>,
  now: Date,
): ViewingHint[] {
  if (v.status !== 'REQUESTED' && v.status !== 'SCHEDULED') return [];
  if (v.status === 'REQUESTED' && v.expiresAt && new Date(v.expiresAt).getTime() <= now.getTime()) return ['LAPSED'];
  // no answers at all: the member's role or mode, which the page says once at the top
  if (v.allowedActions.length === 0 || v.allowedActions.includes('OUTCOME')) return [];
  const hints: ViewingHint[] = [];
  if (!v.mayBind) hints.push(v.target.kind === 'LISTING' ? 'BIND_LISTING' : 'BIND_DEVELOPMENT');
  if (v.status === 'SCHEDULED') hints.push('OUTCOME_LATER');
  return hints;
}

/**
 * R2-04c: whether the row offers "open the deal" — the owner accepted the terms and the viewing is scheduled or was
 * attended, and this member binds the agency. Display only: the API decides (`DEAL_VIEWING_NOT_ELIGIBLE`), and a viewing
 * that has its deal already answers with it, so the form also leads into an existing deal room.
 */
export function dealEligible(v: Pick<ViewingRequestDto, 'status' | 'outcome' | 'mayBind' | 'terms'>): boolean {
  if (!v.mayBind || !v.terms.accepted) return false;
  return v.status === 'SCHEDULED' || (v.status === 'COMPLETED' && v.outcome === 'ATTENDED');
}
