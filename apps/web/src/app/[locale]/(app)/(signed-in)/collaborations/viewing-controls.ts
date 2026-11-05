import type { ViewingRequestDto } from '@inmolink/contracts';

/**
 * Which answers a viewing row offers (S17-F56, the S17-F34 rule: no control the API would refuse). Mirrors the state rules
 * of `packages/core/src/modules/mls/viewings.ts`; only what the screen shows, the API still decides. The time checks use
 * the page's clock: when it differs from the database's, the API's `VIEWING_REQUEST_STATE` has its own sentence.
 */
export type ViewingAction = 'ACCEPT' | 'DECLINE' | 'RESCHEDULE' | 'CANCEL' | 'OUTCOME';

/** Why something is not offered: keys under `network.collaborations.hints`. */
export type ViewingHint = 'BIND_LISTING' | 'BIND_DEVELOPMENT' | 'OUTCOME_LATER' | 'LAPSED';

type Row = Pick<ViewingRequestDto, 'side' | 'status' | 'awaiting' | 'expiresAt' | 'scheduledAt' | 'target'> & {
  terms: Pick<ViewingRequestDto['terms'], 'validUntil'>;
};

/**
 * `assertMayBind`: on the owner's side, accepting or proposing a time binds the agency to the commission, so only its
 * admins or the listing's own agent may; a development has no agent of its own. The introducer accepted by requesting.
 */
export function mayBind(
  v: Pick<ViewingRequestDto, 'side' | 'target'>,
  member: { isAdmin: boolean; userId: string },
  listingOwners: ReadonlyMap<string, string | null>,
): boolean {
  if (v.side !== 'OWNER' || member.isAdmin) return true;
  return v.target.kind === 'LISTING' && listingOwners.get(v.target.id) === member.userId;
}

export function viewingControls(
  v: Row,
  o: { now: Date; blocked: boolean; mayBind: boolean },
): { actions: ViewingAction[]; hints: ViewingHint[] } {
  if (v.status !== 'REQUESTED' && v.status !== 'SCHEDULED') return { actions: [], hints: [] };
  const passed = (iso: string | null) => iso !== null && new Date(iso).getTime() <= o.now.getTime();
  if (v.status === 'REQUESTED' && passed(v.expiresAt)) return { actions: [], hints: ['LAPSED'] };
  if (o.blocked) return { actions: [], hints: [] };

  const actions: ViewingAction[] = [];
  const hints: ViewingHint[] = [];
  const due = v.status === 'SCHEDULED' && passed(v.scheduledAt);
  const answering = v.status === 'REQUESTED' && v.awaiting === v.side;
  if (due) actions.push('OUTCOME');
  if (answering && o.mayBind) actions.push('ACCEPT');
  if (answering) actions.push('DECLINE');
  // a new time must fall inside the terms, so none can once they ended
  if (!due && o.mayBind && !passed(v.terms.validUntil)) actions.push('RESCHEDULE');
  actions.push('CANCEL');
  if (!due && !o.mayBind) hints.push(v.target.kind === 'LISTING' ? 'BIND_LISTING' : 'BIND_DEVELOPMENT');
  if (v.status === 'SCHEDULED' && !due) hints.push('OUTCOME_LATER');
  return { actions, hints };
}
