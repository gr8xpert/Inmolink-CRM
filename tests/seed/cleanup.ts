import { adminQuery } from '@inmolink/db/testing';
import { seededId } from '../../scripts/seed/rng';

/**
 * Removes what the S16-F4 seeders wrote for agencies `[0, agencies)` of `seed` — before a test deletes the seed's users:
 * leads, tasks and calendar events name the agency's members (NO ACTION foreign keys), so the users' delete (which
 * cascades to `agency_members`) would be refused. As the admin role (no RLS, every grant), `AGENCIES_PER_STATEMENT`
 * agencies a statement. Every table is listed, children before parents, so the order does not lean on a cascade
 * (each child's cascade from its parent would remove it too).
 */
const AGENCIES_PER_STATEMENT = 20;
const TABLES = [
  // notifications.notifications
  'notification_preferences',
  'notifications',
  // matching.saved_searches (alerts: matching's, of a storm or a worker run)
  'saved_search_alerts',
  'saved_searches',
  // imports.feed_connections (runs: an import storm's)
  'feed_runs',
  'feed_connections',
  // crm.contacts
  'calendar_event_attendees',
  'calendar_events',
  'tasks',
  'activities',
  'lead_stage_history',
  'leads',
  'contact_facets',
  'contact_phones',
  'contact_emails',
  'contacts',
  'pipeline_stages',
] as const;

export async function removeSeededLoadData(seed: number, agencies: number): Promise<void> {
  const ids = Array.from({ length: agencies }, (_, a) => seededId(seed, 'agencies', a));
  for (const table of TABLES) {
    for (let i = 0; i < ids.length; i += AGENCIES_PER_STATEMENT) {
      await adminQuery(`delete from ${table} where agency_id = any($1::uuid[])`, [
        ids.slice(i, i + AGENCIES_PER_STATEMENT),
      ]);
    }
  }
}
