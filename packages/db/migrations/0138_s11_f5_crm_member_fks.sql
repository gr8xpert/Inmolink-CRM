-- S11-F5: CRM member columns reference agency_members(agency_id, user_id), so a non-member (or another agency's member)
-- can never be an assignee, organizer, attendee or feed owner. Members are deactivated, never deleted on a request path
-- (identity keeps the row with deactivated_at), so an FK cannot express "active" — the services still check that. When
-- a member row is deleted (an agency or user hard delete): work items (leads, tasks, events, prospects) block it (NO
-- ACTION, as properties_owner_member_fk); the member's own attendance and feed go with it (CASCADE, as listing_views).
-- Added NOT VALID (new and changed rows are checked at once, no scan under the lock); the small tables are validated
-- here (SHARE UPDATE EXCLUSIVE: blocks neither reads nor writes); leads, the large one, in a later migration.
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_member_fk" FOREIGN KEY ("agency_id","user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organizer_member_fk" FOREIGN KEY ("agency_id","organizer_user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_member_fk" FOREIGN KEY ("agency_id","user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assignee_member_fk" FOREIGN KEY ("agency_id","assigned_user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "seller_prospects" ADD CONSTRAINT "seller_prospects_assignee_member_fk" FOREIGN KEY ("agency_id","assigned_user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_member_fk" FOREIGN KEY ("agency_id","assigned_user_id") REFERENCES "public"."agency_members"("agency_id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" VALIDATE CONSTRAINT "calendar_event_attendees_member_fk";--> statement-breakpoint
ALTER TABLE "calendar_events" VALIDATE CONSTRAINT "calendar_events_organizer_member_fk";--> statement-breakpoint
ALTER TABLE "calendar_feeds" VALIDATE CONSTRAINT "calendar_feeds_member_fk";--> statement-breakpoint
ALTER TABLE "seller_prospects" VALIDATE CONSTRAINT "seller_prospects_assignee_member_fk";--> statement-breakpoint
ALTER TABLE "tasks" VALIDATE CONSTRAINT "tasks_assignee_member_fk";--> statement-breakpoint
CREATE INDEX "calendar_events_organizer_idx" ON "calendar_events" USING btree ("agency_id","organizer_user_id");--> statement-breakpoint
CREATE INDEX "calendar_feeds_member_idx" ON "calendar_feeds" USING btree ("agency_id","user_id");--> statement-breakpoint
CREATE INDEX "seller_prospects_assigned_idx" ON "seller_prospects" USING btree ("agency_id","assigned_user_id") WHERE "seller_prospects"."assigned_user_id" is not null;--> statement-breakpoint
-- S11-F5: the stage-history writer (S10-03, migration 0124) with a search_path that holds no schema a role can create
-- objects in (pg_catalog, then pg_temp last) and every non-catalog name schema-qualified. Same owner (app_owner), same
-- grants (create or replace keeps the revoke of 0124), same trigger.
create or replace function public.lead_stage_history_append() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then
    return null;
  end if;
  insert into public.lead_stage_history
    (id, agency_id, lead_id, from_stage_id, from_entered_at, to_stage_id, changed_at, actor_user_id)
  values (
    pg_catalog.encode(pg_catalog.set_bit(pg_catalog.set_bit(pg_catalog.overlay(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()),
      pg_catalog.substring(pg_catalog.int8send((pg_catalog.extract('epoch', pg_catalog.clock_timestamp()) * 1000)::pg_catalog.int8), 3),
      1, 6), 52, 1), 53, 1), 'hex')::pg_catalog.uuid,
    new.agency_id, new.id,
    case when tg_op = 'UPDATE' then old.stage_id end,
    case when tg_op = 'UPDATE' then old.stage_entered_at end,
    new.stage_id, new.stage_entered_at,
    public.app_user_id()
  );
  return null;
end $$;
