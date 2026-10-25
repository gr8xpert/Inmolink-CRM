/**
 * Onboarding backfill (S13-F26, PLAN §7 M21): completes the checklist steps of agencies that did them before the
 * projection (S13-04) shipped — from their CURRENT state, not from events, each with the earliest known timestamp.
 * Also run per agency after the legacy import (S14). State comes only through the owning modules' public reads.
 *
 * - IMPORT_LISTINGS: any listing or development.
 * - SHARE_LISTING: any listing SHARED / PUBLIC with scope ALL (not hidden by the freshness sweep).
 * - CONNECT_WEBSITE: any site.
 * - INVITE_TEAM: any invite, or a second member.
 * - VERIFY_AGENCY: status VERIFIED.
 *
 * Idempotent (earliest wins, like the event subscribers: a rerun writes nothing; a real event that is earlier still
 * wins), batched (one keyset page of agencies = one transaction, a handful of grouped reads) and resumable (`after`).
 */
import type { OnboardingStep } from '@inmolink/contracts';
import { type Tx, withSystem } from '@inmolink/db';
import { NIL_UUID } from '@inmolink/platform/tenancy';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as identity from '../identity';
import * as properties from '../properties';
import * as websites from '../websites';
import * as repo from './repo';

/** `onboarding_steps.event_id` of a backfilled step: no outbox event completed it (support: "ticked by the backfill"). */
export const BACKFILL_EVENT_ID = NIL_UUID;
/** Agencies per page (one transaction); the cap keeps the grouped reads bounded. */
export const BACKFILL_MAX_BATCH = 1_000;

export type BackfillProgress = { agencies: number; changed: number; lastAgencyId: string | null };

function earliest(...maps: Map<string, Date>[]): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const m of maps) {
    for (const [id, at] of m) {
      const known = out.get(id);
      if (!known || at < known) out.set(id, at);
    }
  }
  return out;
}

/** Backfills the given agencies (at most 1,000) in the caller's system transaction; returns rows inserted or moved. */
export async function backfillAgencySteps(tx: Tx, agencyIds: string[]): Promise<number> {
  if (agencyIds.length === 0) return 0;
  if (agencyIds.length > BACKFILL_MAX_BATCH) throw new RangeError(`at most ${BACKFILL_MAX_BATCH} agencies per page`);
  const [listing, development, shared, site, team, verified] = await Promise.all([
    properties.earliestListingByAgency(tx, agencyIds),
    developments.earliestDevelopmentByAgency(tx, agencyIds),
    properties.earliestSharedListingByAgency(tx, agencyIds),
    websites.earliestSiteByAgency(tx, agencyIds),
    identity.earliestTeamInviteByAgency(tx, agencyIds),
    agencies.verifiedAtByAgency(tx, agencyIds),
  ]);
  const byStep: [OnboardingStep, Map<string, Date>][] = [
    ['IMPORT_LISTINGS', earliest(listing, development)],
    ['SHARE_LISTING', shared],
    ['CONNECT_WEBSITE', site],
    ['INVITE_TEAM', team],
    ['VERIFY_AGENCY', verified],
  ];
  const rows = byStep.flatMap(([step, m]) =>
    [...m].map(([agencyId, completedAt]) => ({ agencyId, step, completedAt, eventId: BACKFILL_EVENT_ID })),
  );
  return repo.completeSteps(tx, rows);
}

/** One agency, e.g. right after its legacy import (S14). Returns rows inserted or moved. */
export function backfillAgency(agencyId: string, reason = 'onboarding.backfill'): Promise<number> {
  return withSystem(reason, (tx) => backfillAgencySteps(tx, [agencyId]));
}

/**
 * Walks every agency (or only `agencyId`) page by page in id order after `after`. `onPage` gets the running totals
 * after each page — keep `lastAgencyId` to resume an interrupted run with `after`.
 */
export async function backfillOnboarding(
  options: {
    agencyId?: string;
    after?: string | null;
    batch?: number;
    reason?: string;
    onPage?: (p: BackfillProgress) => void;
  } = {},
): Promise<BackfillProgress> {
  const batch = Math.max(1, Math.min(options.batch ?? BACKFILL_MAX_BATCH, BACKFILL_MAX_BATCH));
  const reason = options.reason ?? 'onboarding.backfill';
  if (options.agencyId) {
    return { agencies: 1, changed: await backfillAgency(options.agencyId, reason), lastAgencyId: options.agencyId };
  }
  const total: BackfillProgress = { agencies: 0, changed: 0, lastAgencyId: options.after ?? null };
  for (;;) {
    const page = await withSystem(reason, async (tx) => {
      const ids = await agencies.agencyIdsPage(tx, total.lastAgencyId, batch);
      return { ids, changed: await backfillAgencySteps(tx, ids) };
    });
    if (page.ids.length === 0) return total;
    total.agencies += page.ids.length;
    total.changed += page.changed;
    total.lastAgencyId = page.ids[page.ids.length - 1] ?? total.lastAgencyId;
    options.onPage?.({ ...total });
    if (page.ids.length < batch) return total;
  }
}
