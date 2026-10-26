import type { OnboardingStep } from '@inmolink/contracts';
import { withSystem } from '@inmolink/db';
import { createLogger, type Logger } from '@inmolink/platform/logger';
import { type EventDef, type EventMeta, type EventPayload, subscribe } from '@inmolink/platform/outbox';
import { isMissingAgencyError } from '@inmolink/platform/queue';
import { PLATFORM_AGENCY_ID } from '@inmolink/platform/tenancy';
import * as agencies from '../agencies';
import * as developments from '../developments';
import * as identity from '../identity';
import * as properties from '../properties';
import * as websites from '../websites';
import * as repo from './repo';

/**
 * The onboarding checklist's projection (S13-04): each step completes from the agency's real event — never a manual
 * tick. Every subscriber only writes `onboarding_steps` (upsert, earliest event wins), so redelivery, out-of-order
 * delivery and an outbox replay are harmless (`onboarding.progress.*` count as projections in the replay policy test).
 *
 * - IMPORT_LISTINGS: a feed run brought listings in (`properties.listings.imported`), a listing was added
 *   (`properties.listing.created`) or a developer added a development (`developments.development.created`).
 * - SHARE_LISTING: a listing went on the network for every agency — SHARED or PUBLIC with scope ALL
 *   (`properties.listing.visibilityChanged`; never the freshness sweep's hide, `networkHidden`). Feed runs never change
 *   a listing's visibility (imports write listings PRIVATE and keep a stored listing's visibility), so they need no check.
 * - CONNECT_WEBSITE: a website was created (`websites.site.created`).
 * - INVITE_TEAM: an admin invited someone (`identity.invite.created`).
 * - VERIFY_AGENCY: staff approved the verification (`agencies.verification.decided`, APPROVED).
 *
 * The tenant is the outbox row's agency (`meta.agencyId`, RLS-checked at emit); an event whose payload names another
 * agency is ignored.
 */

type Meta = Pick<EventMeta, 'eventId' | 'agencyId' | 'createdAt'>;

/**
 * The earliest completion this process wrote per agency and step, so hot events (a listing created or shared) cost no
 * statement after the first — unless an older event arrives late. Bounded: cleared when full (a later event then just
 * repeats one idempotent upsert).
 */
const seen = new Map<string, number>();
const SEEN_MAX = 50_000;

const key = (agencyId: string, step: OnboardingStep) => `${agencyId}:${step}`;

let log: Logger | undefined;

/**
 * Completes `step` for the event's agency (nothing for platform events, or when this process wrote an earlier one).
 * S13 review: an event whose agency no longer exists (deleted or pruned while the event waited: FK 23503 on
 * `onboarding_steps`) is skipped and logged at debug — there is no checklist left to complete, and a throw would only
 * dead-letter the event after burning the dispatcher's retries.
 */
export async function recordStep(step: OnboardingStep, meta: Meta): Promise<void> {
  const { agencyId } = meta;
  if (agencyId === PLATFORM_AGENCY_ID) return;
  const at = meta.createdAt.getTime();
  const known = seen.get(key(agencyId, step));
  if (known !== undefined && known <= at) return;
  try {
    await withSystem('onboarding.progress', (tx) =>
      repo.completeStep(tx, { agencyId, step, completedAt: meta.createdAt, eventId: meta.eventId }),
    );
  } catch (err) {
    if (!isMissingAgencyError(err)) throw err;
    log ??= createLogger({ service: 'onboarding' });
    log.debug({ agencyId, step, eventId: meta.eventId }, 'onboarding: event of a deleted agency skipped');
    return;
  }
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.set(key(agencyId, step), at);
}

/** Subscribes `step` to `def`: events of the row's own agency that pass `when`. */
function on<E extends EventDef>(
  def: E,
  step: OnboardingStep,
  name: string,
  when: (payload: EventPayload<E>) => boolean = () => true,
): () => void {
  return subscribe(
    def,
    async (payload, meta) => {
      const named = (payload as { agencyId?: unknown }).agencyId;
      if (named !== undefined && named !== meta.agencyId) return;
      if (when(payload)) await recordStep(step, meta);
    },
    { name: `onboarding.progress.${name}` },
  );
}

let unsubscribe: (() => void)[] | undefined;

/** Outbox → `onboarding_steps` (S13-04). Called once by the worker; idempotent. */
export function registerOnboardingSubscriptions(): void {
  if (unsubscribe) return;
  const { propertiesEvents } = properties;
  unsubscribe = [
    on(propertiesEvents.imported, 'IMPORT_LISTINGS', 'listingsImported'),
    on(propertiesEvents.created, 'IMPORT_LISTINGS', 'listingCreated'),
    on(developments.developmentsEvents.created, 'IMPORT_LISTINGS', 'developmentCreated'),
    on(
      propertiesEvents.visibilityChanged,
      'SHARE_LISTING',
      'listingShared',
      (p) => p.visibility !== 'PRIVATE' && p.shareScope === 'ALL' && p.networkHidden !== true,
    ),
    on(websites.websitesEvents.siteCreated, 'CONNECT_WEBSITE', 'siteCreated'),
    on(identity.identityEvents.inviteCreated, 'INVITE_TEAM', 'inviteCreated'),
    on(
      agencies.agenciesEvents.verificationDecided,
      'VERIFY_AGENCY',
      'verificationApproved',
      (p) => p.decision === 'APPROVED',
    ),
  ];
}

/** Tests. */
export function unregisterOnboardingSubscriptions(): void {
  for (const off of unsubscribe ?? []) off();
  unsubscribe = undefined;
  seen.clear();
}
