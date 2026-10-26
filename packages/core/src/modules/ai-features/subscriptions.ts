import { clock } from '@inmolink/platform/clock';
import { subscribe } from '@inmolink/platform/outbox';
import * as agencies from '../agencies';
import * as identity from '../identity';
import * as properties from '../properties';
import * as search from '../search';
import { aiFeaturesEvents } from './events';
import { aiFeaturesJobs, whiteLabelJobs } from './jobs';
import { autoDraftListing } from './studio';
import { whiteLabelModelOn } from './white-label';

let unsubscribe: (() => void)[] | undefined;
let unsubscribeWhiteLabel: (() => void)[] | undefined;

/**
 * Outbox → ai-features worker (S12-02). Each `aiFeatures.listingStudio.requested` event becomes one job (job ID =
 * the request id): SINGLE → `generateListingCopy`, BULK → `submitListingStudioBatch`. The tenant is `meta.agencyId`
 * (RLS-checked when the event was written), the fair-share group. S13-F14: listing created / facts changed →
 * `autoDraftListing` (behind its flag). Called once by the worker.
 */
export function registerAiFeaturesSubscriptions(): void {
  if (unsubscribe) return;
  unsubscribe = [
    subscribe(
      aiFeaturesEvents.listingStudioRequested,
      (payload, meta) => {
        const { mode, ...rest } = payload;
        const p = { ...rest, agencyId: meta.agencyId };
        return mode === 'SINGLE'
          ? aiFeaturesJobs.generateListingCopy.enqueue(p)
          : aiFeaturesJobs.submitListingStudioBatch.enqueue(p);
      },
      { name: 'aiFeatures.listingStudio.run' },
    ),
    // S13-F14: auto-drafts on create / a facts change (flag `ai.listing-studio.auto-drafts`, off by default); a
    // queued draft is an `aiFeatures.listingStudio.requested` event like a member's own request.
    subscribe(
      properties.propertiesEvents.factsChanged,
      async (payload, meta) => {
        await autoDraftListing({ agencyId: meta.agencyId, listingId: payload.listingId });
      },
      { name: 'aiFeatures.listingStudio.autoDraft' },
    ),
  ];
}

/** Tests only. */
export function unregisterAiFeaturesSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
}

/**
 * Outbox → the model pass: what websites show of these targets changed (S7-06's event). Called once by the worker.
 * S13-F7: only the targets network sites show with text new to them (`networkShownIds`): an event without any (a price
 * edit, a re-written row with the same text, a private or own-only change) queues no job. Events from before the field
 * existed name every target, as before.
 */
export function registerWhiteLabelSubscriptions(): void {
  if (unsubscribeWhiteLabel) return;
  unsubscribeWhiteLabel = [
    subscribe(
      search.searchEvents.publicDocsChanged,
      async (payload, meta) => {
        const targetIds = payload.networkShownIds ?? payload.targetIds;
        if (targetIds.length === 0) return;
        // S13-F17: an agency with the model pass switched off queues nothing (the job would check it again).
        if (!(await whiteLabelModelOn(payload.agencyId))) return;
        await whiteLabelJobs.sanitizeTexts.enqueue({ eventId: meta.eventId, agencyId: payload.agencyId, targetIds });
      },
      { name: 'aiFeatures.whiteLabel.publicDocsChanged' },
    ),
    // S13-F25: the owner's identity changed — its name, tax id or address (S7-F5 `identityChanged`; absent: unknown).
    subscribe(
      agencies.agenciesEvents.detailsUpdated,
      async (payload, meta) => {
        if (payload.identityChanged !== false) await queueOwnerChangeWalk(meta.agencyId);
      },
      { name: 'aiFeatures.whiteLabel.ownerDetailsChanged' },
    ),
    // … its published contacts (colours or the logo alone change nothing a text is cleaned of).
    subscribe(
      agencies.agenciesEvents.profileUpdated,
      async (payload, meta) => {
        if (payload.identityChanged ?? !payload.logoChanged) await queueOwnerChangeWalk(meta.agencyId);
      },
      { name: 'aiFeatures.whiteLabel.ownerProfileChanged' },
    ),
    // … or an agent joined (a platform event: the agency is in the payload, written by app_auth only).
    subscribe(
      identity.identityEvents.memberNamed,
      async (payload) => {
        await queueOwnerChangeWalk(payload.memberAgencyId);
      },
      { name: 'aiFeatures.whiteLabel.memberNamed' },
    ),
  ];
}

/** S13-F25: owner identity changes within one window of this length run one walk of the agency. */
export const OWNER_CHANGE_WINDOW_MS = 10 * 60_000;
/** … which starts this long after the window closed (the last change of the window committed and visible). */
const OWNER_CHANGE_SLACK_MS = 60_000;

/** The window `at` falls in, as a run id: `i-` and the window's start (UTC, `YYYYMMDDHHmm`). */
export function ownerChangeRun(at: Date): { run: string; delayMs: number } {
  const start = Math.floor(at.getTime() / OWNER_CHANGE_WINDOW_MS) * OWNER_CHANGE_WINDOW_MS;
  const stamp = new Date(start).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return { run: `i-${stamp}`, delayMs: start + OWNER_CHANGE_WINDOW_MS + OWNER_CHANGE_SLACK_MS - at.getTime() };
}

/**
 * S13-F25: an owner identity change queues the agency's backfill walk early (not at the next monthly sweep), with
 * `force` — the deterministic pass's output its cached answers were for changed. Debounced per agency (security
 * review): every change of one `OWNER_CHANGE_WINDOW_MS` window queues the same job (run = the window, job id = run +
 * agency + page), delayed until the window closed — a burst of renames, new agents and contact edits (or a redelivered
 * event) runs one walk, which reads the identity after the last of them. Nothing for an agency with the model pass off.
 */
export async function queueOwnerChangeWalk(agencyId: string): Promise<void> {
  if (!(await whiteLabelModelOn(agencyId))) return;
  const { run, delayMs } = ownerChangeRun(clock.now());
  await whiteLabelJobs.whiteLabelBackfill.enqueue({ run, agencyId, after: null, force: true }, { delayMs });
}

/** Tests. */
export function unregisterWhiteLabelSubscriptions(): void {
  for (const off of unsubscribeWhiteLabel ?? []) off();
  unsubscribeWhiteLabel = undefined;
}
