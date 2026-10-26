/**
 * Which outbox events staff may replay (S13-03 security review). A replay re-runs **every** subscriber of an event, so
 * an event is only as safe as its noisiest subscriber: a password-reset e-mail, a lead notification, a saved-search
 * alert or an AI call must never go out twice because an index was rebuilt.
 *
 * - `SAFE`: every subscriber is a projection or cache (read models, search index, quality scores, edge / feed caches,
 *   portal feed regeneration, override clean-up) — rebuilt from current state, nothing reaches a person. Data ops and
 *   super admins replay them.
 * - `REFUSED`: identity, billing, notification, chat, e-mail, AI, social, CRM-timeline and job-starting events — never
 *   replayed by anyone (`OUTBOX_REPLAY_TYPE_REFUSED`).
 * - anything else: super admins only, naming the type.
 *
 * `apps/worker/src/replay-policy.test.ts` checks this against the real subscriber registry: every `SAFE` type's
 * subscribers are projections, and every type with a messaging, notifying or job-starting subscriber is `REFUSED`.
 */

export type ReplayClass = 'SAFE' | 'REFUSED' | 'SUPER_ADMIN';

/** Events whose subscribers only rebuild projections and caches (see the worker test). */
export const REPLAY_SAFE_TYPES: ReadonlySet<string> = new Set([
  'agencies.preferred.added',
  'agencies.preferred.removed',
  'agencies.settings.changed',
  'developments.development.accessChanged',
  'developments.development.deleted',
  'developments.development.updated',
  'developments.priceList.approved',
  'developments.unit.created',
  'developments.unit.deleted',
  'developments.unit.priceChanged',
  'developments.unit.statusChanged',
  'developments.unit.updated',
  'exports.connection.changed',
  'imports.run.finished',
  'media.listing.changed',
  'media.object.referencesChanged',
  'properties.listing.confirmationDue',
  'properties.listing.created',
  'properties.listing.deleted',
  'properties.listing.restored',
  'properties.listing.updated',
  'properties.listing.visibilityChanged',
  'properties.listings.imported',
  'taxonomy.data.changed',
  'websites.feed.changed',
  'websites.site.changed',
]);

/** Whole areas never replayed: they mail, notify, bill, call AI, post, or start work for a person. */
export const REPLAY_REFUSED_PREFIXES: readonly string[] = [
  'identity.',
  'billing.',
  'notifications.',
  'chat.',
  'compliance.',
  'crm.',
  'mls.',
  'network.',
  'social.',
  'aiFeatures.',
  'admin.',
  'support.', // S13-05: ticket e-mails
];

/** Single events never replayed (a subscriber mails, alerts, calls AI or starts a run). */
export const REPLAY_REFUSED_TYPES: ReadonlySet<string> = new Set([
  'agencies.details.updated', // billing trial start
  'agencies.profile.updated', // S13-F25: an owner identity change queues the white-label backfill walk (AI calls)
  'agencies.verification.decided', // decision e-mail
  'imports.connection.paused', // pause notice
  'imports.run.requested', // starts a feed run
  'properties.bulkAction.requested', // runs a bulk action
  'properties.listing.factsChanged', // S13-F14: Listing Studio auto-drafts (AI calls)
  'properties.listing.purged', // CRM timeline entry
  'properties.listing.statusChanged', // CRM timeline entry
  'presentations.selection.interacted', // CRM timeline entry
  'search.listings.changed', // saved-search alerts (e-mail)
  'search.publicDocs.changed', // white-label AI pass
  'websites.lead.received', // lead promotion and notification
]);

export function replayClass(type: string): ReplayClass {
  if (REPLAY_REFUSED_TYPES.has(type) || REPLAY_REFUSED_PREFIXES.some((p) => type.startsWith(p))) return 'REFUSED';
  if (REPLAY_SAFE_TYPES.has(type)) return 'SAFE';
  return 'SUPER_ADMIN';
}
