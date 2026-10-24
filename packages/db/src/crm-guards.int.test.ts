import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../test/test-db';
import { closeDb } from './client';

/** CRM database defence in depth (S11-F5): the stage-history definer's pinned path and the member foreign keys. */

let admin: pg.Client;

beforeAll(async () => {
  await setupTestDb('script');
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await closeDb();
});

describe('CRM database guards (S11-F5)', () => {
  it('[S11-F5] the lead_stage_history_append definer pins search_path = pg_catalog, pg_temp', async () => {
    const { rows } = await admin.query<{ config: string[] | null; definer: boolean; owner: string; body: string }>(
      `select p.proconfig as config, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.prosrc as body
         from pg_proc p where p.proname = 'lead_stage_history_append' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ config: ['search_path=pg_catalog, pg_temp'], definer: true, owner: 'app_owner' });
    // every non-catalog name is schema-qualified (nothing resolves through a schema a role can create objects in)
    expect(rows[0]?.body).toContain('insert into public.lead_stage_history');
    expect(rows[0]?.body).toContain('public.app_user_id()');
    // still executable by nobody but its owner (the trigger runs it)
    const grants = await admin.query<{ grantee: string }>(
      `select grantee from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = 'lead_stage_history_append' and grantee <> 'app_owner'`,
    );
    expect(grants.rows).toEqual([]);
  });

  it('[S11-F5] member columns reference agency_members(agency_id, user_id): work blocks a delete, own rows cascade', async () => {
    const { rows } = await admin.query<{ name: string; cols: string; del: string }>(
      `select c.conname as name, pg_get_constraintdef(c.oid) as cols, c.confdeltype::text as del
         from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'public.agency_members'::regclass
          and c.conname in ('tasks_assignee_member_fk', 'leads_assignee_member_fk', 'calendar_events_organizer_member_fk',
                            'calendar_event_attendees_member_fk', 'calendar_feeds_member_fk',
                            'seller_prospects_assignee_member_fk')
        order by c.conname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual([
      'calendar_event_attendees_member_fk',
      'calendar_events_organizer_member_fk',
      'calendar_feeds_member_fk',
      'leads_assignee_member_fk',
      'seller_prospects_assignee_member_fk',
      'tasks_assignee_member_fk',
    ]);
    for (const r of rows)
      expect(r.cols, r.name).toMatch(/^FOREIGN KEY \(agency_id, \w+\) REFERENCES agency_members\(agency_id, user_id\)/);
    // 'a' = NO ACTION, 'c' = CASCADE
    expect(byName.tasks_assignee_member_fk?.del).toBe('a');
    expect(byName.leads_assignee_member_fk?.del).toBe('a');
    expect(byName.calendar_events_organizer_member_fk?.del).toBe('a');
    expect(byName.seller_prospects_assignee_member_fk?.del).toBe('a');
    expect(byName.calendar_event_attendees_member_fk?.del).toBe('c');
    expect(byName.calendar_feeds_member_fk?.del).toBe('c');
  });
});
