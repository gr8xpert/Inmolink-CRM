/**
 * Scale ratios per agency (PLAN §4.1 "Load assumptions"). The scale generator multiplies these by
 * `--agencies`; each module's seeder reads its own ratio. Entities whose module has not landed yet
 * are listed so the profile (and `docs/runbooks/scale-seed.md`) shows the full target.
 *
 * S16-F4: PLAN §4.1 fixes users, listings, media, contacts, client profiles and feed connections. The CRM's other
 * tables are not in §4.1; their ratios are this seed's assumption (STATUS Decisions): a fifth of the contacts made an
 * enquiry (a lead), 30 tasks and ~50 notifications per member, one activity per contact and two more per lead, and a
 * calendar of ~3 events a week per member around the seed day.
 */
export const PER_AGENCY = {
  users: 5,
  ownListings: 150,
  /** 150k new-build units at 5,000 agencies. */
  newBuildUnits: 30,
  mediaPerListing: 30,
  contacts: 2_000,
  clientProfiles: 200,
  feedConnections: 1,
  /** One contact in five (`contact % 5 === 0`). */
  leads: 400,
  /** A task each for 150 of the contacts (30 per member). */
  tasks: 150,
  /** One per contact, two more per lead: 2,000 + 2 × 400. */
  activities: 2_800,
  /** Over 16 weeks around the seed day (`CALENDAR_WEEKS`): 15 a week per agency. */
  calendarEvents: 240,
  /** 50 per member, over the 30 days before the seed day. */
  notifications: 250,
} as const;

export type ScaleEntity =
  | 'users'
  | 'listings'
  | 'media'
  | 'contacts'
  | 'clientProfiles'
  | 'feedConnections'
  | 'leads'
  | 'tasks'
  | 'activities'
  | 'calendarEvents'
  | 'notifications';

export function scaleCounts(agencies: number): Record<ScaleEntity | 'agencies', number> {
  const listings = agencies * (PER_AGENCY.ownListings + PER_AGENCY.newBuildUnits);
  return {
    agencies,
    users: agencies * PER_AGENCY.users,
    listings,
    media: listings * PER_AGENCY.mediaPerListing,
    contacts: agencies * PER_AGENCY.contacts,
    clientProfiles: agencies * PER_AGENCY.clientProfiles,
    feedConnections: agencies * PER_AGENCY.feedConnections,
    leads: agencies * PER_AGENCY.leads,
    tasks: agencies * PER_AGENCY.tasks,
    activities: agencies * PER_AGENCY.activities,
    calendarEvents: agencies * PER_AGENCY.calendarEvents,
    notifications: agencies * PER_AGENCY.notifications,
  };
}
