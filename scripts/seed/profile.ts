/**
 * Scale ratios per agency (PLAN §4.1 "Load assumptions"). The scale generator multiplies these by
 * `--agencies`; each module's seeder reads its own ratio. Entities whose module has not landed yet
 * are listed so the profile (and `docs/runbooks/scale-seed.md`) shows the full target.
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
} as const;

export type ScaleEntity = 'users' | 'listings' | 'media' | 'contacts' | 'clientProfiles' | 'feedConnections';

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
  };
}
