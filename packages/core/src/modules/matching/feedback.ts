import { type Tx, withSystem } from '@inmolink/db';
import * as presentations from '../presentations';
import { affinityDeltas, affinityKeys, EMPTY_SUMMARY, type FeedbackSignal, withDeltas } from './boost';
import * as repo from './repo';

/**
 * The learned boost's feedback (R2-02c, PLAN §7 M9), worker-only (`app_system`, the agency an explicit predicate):
 * each client profile keeps one signal per listing (`client_profile_feedback`) and a summary of them per affinity key
 * (`client_profile_affinities`, `boost.ts`), moved by deltas in the signal's transaction — never rebuilt per match.
 *
 * - a client's like on a selection of the profile's contact (`presentations.selection.interacted`): `LIKE` on every
 *   profile of that contact while the client's latest word on the listing, across all the contact's selections, is a
 *   like; an unlike takes the like back;
 * - a member's dismissal of a match (`matching.clientProfileMatch.dismissed`, R2-02d): `DISLIKE` on that profile while
 *   the match is `DISMISSED`; a restored match (R2-02d emits the same event) takes it back.
 *
 * The current state is read **after** the profiles are locked (id order), so two jobs of one profile serialize and
 * the later one sees the other's committed state. Each signal carries when it was given (`signal_at`: the
 * interaction's or the match's time): an older one never replaces a newer one (a delayed like job after a dismissal).
 * The listing's keys come from `matching_listing_facts` when the signal is given (a listing the engine no longer
 * offers teaches nothing) and are kept on the signal, so a change takes back exactly what it added. Idempotent: the
 * same state twice changes nothing.
 */

/** Profiles of one contact a like reaches (R2-02a caps creates at 10; a merge can add more). */
export const FEEDBACK_PROFILES_PER_CONTACT = 50;

type Change = { set: FeedbackSignal; at: Date } | { clear: FeedbackSignal; at: Date };

/** Applies one change to these locked profiles' signals on the listing; answers how many profiles changed. */
async function applyLocked(
  tx: Tx,
  agencyId: string,
  listingId: string,
  locked: Awaited<ReturnType<typeof repo.lockFeedback>>,
  change: Change,
): Promise<number> {
  let keys: number[] = [];
  if ('set' in change) {
    const facts = await repo.affinityFactsOf(tx, listingId);
    if (!facts) return 0;
    keys = affinityKeys(facts);
  }
  const set: { profileId: string; signal: FeedbackSignal; at: Date; keys: number[] }[] = [];
  const remove: string[] = [];
  const summaries: ({ profileId: string } & repo.AffinityRow)[] = [];
  for (const profileId of locked.profileIds) {
    const before = locked.signals.get(profileId) ?? null;
    if (before && before.at > change.at) continue; // a newer signal stands
    let after: { signal: FeedbackSignal; keys: number[] } | null;
    if ('set' in change) {
      if (before?.signal === change.set) continue; // the same signal again: nothing moves
      after = { signal: change.set, keys };
    } else {
      if (before?.signal !== change.clear) continue;
      after = null;
    }
    const next = withDeltas(locked.summaries.get(profileId) ?? EMPTY_SUMMARY, affinityDeltas(before, after));
    summaries.push({ profileId, keys: [...next.keys], likes: [...next.likes], dislikes: [...next.dislikes] });
    if (after) set.push({ profileId, ...after, at: change.at });
    else remove.push(profileId);
  }
  if (summaries.length === 0) return 0;
  await repo.writeFeedback(tx, { agencyId, listingId, set, remove });
  await repo.writeAffinities(tx, agencyId, summaries);
  return summaries.length;
}

/**
 * `matching.selectionFeedback` (on `presentations.selection.interacted`, likes and unlikes only): the client's latest
 * like / unlike of the item across the contact's selections, on every profile of the selection's contact (at most
 * `FEEDBACK_PROFILES_PER_CONTACT`; `truncated` when there were more). A selection of another agency, without a
 * contact, or a contact without profiles: nothing.
 */
export async function recordSelectionFeedback(p: {
  agencyId: string;
  selectionId: string;
  targetId: string;
}): Promise<{ profiles: number; truncated: boolean }> {
  return withSystem(`matching.selectionFeedback: agency ${p.agencyId}`, async (tx) => {
    const sel = await presentations.selectionContactOf(tx, p.selectionId);
    if (!sel || sel.agencyId !== p.agencyId || !sel.contactId) return { profiles: 0, truncated: false };
    const ids = await repo.profileIdsOfContact(tx, {
      agencyId: p.agencyId,
      contactId: sel.contactId,
      limit: FEEDBACK_PROFILES_PER_CONTACT + 1,
    });
    const truncated = ids.length > FEEDBACK_PROFILES_PER_CONTACT;
    const locked = await repo.lockFeedback(tx, {
      agencyId: p.agencyId,
      profileIds: ids.slice(0, FEEDBACK_PROFILES_PER_CONTACT),
      listingId: p.targetId,
    });
    if (locked.profileIds.length === 0) return { profiles: 0, truncated };
    // read under the locks: a concurrent job of these profiles has committed what it saw
    const state = await presentations.contactLikeState(tx, {
      agencyId: p.agencyId,
      contactId: sel.contactId,
      targetId: p.targetId,
    });
    if (!state) return { profiles: 0, truncated };
    const profiles = await applyLocked(
      tx,
      p.agencyId,
      p.targetId,
      locked,
      state.liked ? { set: 'LIKE', at: state.at } : { clear: 'LIKE', at: state.at },
    );
    return { profiles, truncated };
  });
}

/**
 * `matching.dismissalFeedback` (on `matching.clientProfileMatch.dismissed`): while the match is `DISMISSED`, its
 * listing is one its profile's client turned down; once it is not (restored), that dislike is taken back.
 */
export async function recordDismissalFeedback(p: { agencyId: string; matchId: string }): Promise<{ profiles: number }> {
  return withSystem(`matching.dismissalFeedback: agency ${p.agencyId}`, async (tx) => {
    const first = await repo.matchOf(tx, p.agencyId, p.matchId);
    if (!first) return { profiles: 0 };
    const locked = await repo.lockFeedback(tx, {
      agencyId: p.agencyId,
      profileIds: [first.profileId],
      listingId: first.listingId,
    });
    if (locked.profileIds.length === 0) return { profiles: 0 };
    const match = (await repo.matchOf(tx, p.agencyId, p.matchId)) ?? first; // the status under the lock
    const at = new Date(match.updatedAt);
    const profiles = await applyLocked(
      tx,
      p.agencyId,
      match.listingId,
      locked,
      match.status === 'DISMISSED' ? { set: 'DISLIKE', at } : { clear: 'DISLIKE', at },
    );
    return { profiles };
  });
}
