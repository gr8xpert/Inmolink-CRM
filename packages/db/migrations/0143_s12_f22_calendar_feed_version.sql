ALTER TABLE "calendar_feeds" ADD COLUMN "content_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD COLUMN "live" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- S12-F22: the ICS feed's 304 from the feed row alone. `calendar_feeds.content_version` is bumped in the transaction of
-- every change to what the feed renders — an event's visible columns, its attendees (added, removed, re-pointed by a
-- merge), an attendee contact's or member's name, a contact closed — and `calendar_feeds.live` says whether its member
-- may still use it (an active membership in a CRM role, an agency not SUSPENDED); feed-api's `calendar_feed_tag(hash)`
-- reads only those (plus the login's status). Trigger functions: SECURITY DEFINER owned by app_owner (this migration's
-- role), search_path pinned, executable by no role (triggers fire without EXECUTE); app_owner reads the calendar,
-- contact and member tables through their `definer_read` policies and writes `calendar_feeds` through `definer_update`
-- (registry `definerSync`). Feed rows are locked in id order before they are bumped: two transactions touching the
-- same members never deadlock on them.

-- whether a member may still use a calendar feed (same rules as `calendar_feed_by_token`, the login aside)
create function public.calendar_feed_member_live(a_id uuid, u_id uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.agency_members m
                   join public.agencies g on g.agency_id = m.agency_id and g.status <> 'SUSPENDED'
                  where m.agency_id = a_id and m.user_id = u_id and m.deactivated_at is null
                    and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN', 'AGENT', 'DEVELOPER_AGENT')) $$;
--> statement-breakpoint
revoke all on function public.calendar_feed_member_live(uuid, uuid) from public;
--> statement-breakpoint
-- bumps the live feeds of the member attendees of these events, and of these members
create function public.calendar_feeds_touch(ev_agency uuid[], ev_id uuid[], m_agency uuid[], m_user uuid[])
  returns void language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  with t as (
    select a.agency_id, a.user_id from public.calendar_event_attendees a
      join unnest(ev_agency, ev_id) as e(agency_id, event_id) on a.agency_id = e.agency_id and a.event_id = e.event_id
     where a.user_id is not null
    union
    select m.agency_id, m.user_id from unnest(m_agency, m_user) as m(agency_id, user_id) where m.user_id is not null
  ),
  locked as (
    select f.id from public.calendar_feeds f join t on f.agency_id = t.agency_id and f.user_id = t.user_id
     where f.revoked_at is null order by f.id for update of f
  )
  update public.calendar_feeds f set content_version = f.content_version + 1 from locked where f.id = locked.id $$;
--> statement-breakpoint
revoke all on function public.calendar_feeds_touch(uuid[], uuid[], uuid[], uuid[]) from public;
--> statement-breakpoint
-- attendees added, removed or re-pointed (a merge): every member attendee's feed of those events, and the members
-- added or removed (an UPDATE that changes none of them — the reminder claim — touches nothing)
create function public.calendar_event_attendees_feed_touch() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare ea uuid[]; ei uuid[]; ma uuid[]; mu uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(n.agency_id), array_agg(n.event_id), array_agg(n.agency_id), array_agg(n.user_id)
      into ea, ei, ma, mu from new_rows n;
  elsif tg_op = 'DELETE' then
    select array_agg(o.agency_id), array_agg(o.event_id), array_agg(o.agency_id), array_agg(o.user_id)
      into ea, ei, ma, mu from old_rows o;
  else
    select array_agg(x.agency_id), array_agg(x.event_id), array_agg(x.agency_id), array_agg(x.user_id)
      into ea, ei, ma, mu
      from (select n.agency_id, n.event_id, n.user_id from new_rows n join old_rows o on o.id = n.id
             where (n.event_id, n.user_id, n.contact_id, n.starts_at)
                   is distinct from (o.event_id, o.user_id, o.contact_id, o.starts_at)
            union all
            select o.agency_id, o.event_id, o.user_id from new_rows n join old_rows o on o.id = n.id
             where (n.event_id, n.user_id, n.contact_id, n.starts_at)
                   is distinct from (o.event_id, o.user_id, o.contact_id, o.starts_at)) x;
  end if;
  if ei is not null then
    perform public.calendar_feeds_touch(ea, ei, ma, mu);
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function public.calendar_event_attendees_feed_touch() from public;
--> statement-breakpoint
create trigger calendar_event_attendees_feed_insert after insert on public.calendar_event_attendees
  referencing new table as new_rows for each statement execute function public.calendar_event_attendees_feed_touch();
--> statement-breakpoint
create trigger calendar_event_attendees_feed_update after update on public.calendar_event_attendees
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.calendar_event_attendees_feed_touch();
--> statement-breakpoint
create trigger calendar_event_attendees_feed_delete after delete on public.calendar_event_attendees
  referencing old table as old_rows for each statement execute function public.calendar_event_attendees_feed_touch();
--> statement-breakpoint
-- an event's visible change (not the reminder sweep's columns): its member attendees' feeds
create function public.calendar_events_feed_touch() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  perform public.calendar_feeds_touch(array[new.agency_id], array[new.id], '{}'::uuid[], '{}'::uuid[]);
  return null;
end $$;
--> statement-breakpoint
revoke all on function public.calendar_events_feed_touch() from public;
--> statement-breakpoint
create trigger calendar_events_feed_touch after update on public.calendar_events for each row
  when ((new.type, new.title, new.description, new.location, new.starts_at, new.ends_at, new.status, new.version,
         new.updated_at)
        is distinct from (old.type, old.title, old.description, old.location, old.starts_at, old.ends_at, old.status,
                          old.version, old.updated_at))
  execute function public.calendar_events_feed_touch();
--> statement-breakpoint
-- an attendee contact renamed or closed: the member attendees' feeds of the events it attends
create function public.contacts_calendar_feed_touch() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare ea uuid[]; ei uuid[];
begin
  select array_agg(a.agency_id), array_agg(a.event_id) into ea, ei
    from public.calendar_event_attendees a where a.agency_id = new.agency_id and a.contact_id = new.id;
  if ei is not null then
    perform public.calendar_feeds_touch(ea, ei, '{}'::uuid[], '{}'::uuid[]);
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function public.contacts_calendar_feed_touch() from public;
--> statement-breakpoint
create trigger contacts_calendar_feed_touch after update on public.contacts for each row
  when ((new.first_name, new.last_name, new.deleted_at) is distinct from (old.first_name, old.last_name, old.deleted_at))
  execute function public.contacts_calendar_feed_touch();
--> statement-breakpoint
-- a member renamed: the feeds of everyone attending an event with them; a member deactivated, reactivated or moved in
-- or out of the CRM roles: their own feed's `live` (and version)
create function public.agency_members_calendar_feed_touch() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare ea uuid[]; ei uuid[];
begin
  if new.name is distinct from old.name then
    select array_agg(a.agency_id), array_agg(a.event_id) into ea, ei
      from public.calendar_event_attendees a where a.agency_id = new.agency_id and a.user_id = new.user_id;
    if ei is not null then
      perform public.calendar_feeds_touch(ea, ei, '{}'::uuid[], '{}'::uuid[]);
    end if;
  end if;
  if (new.role, new.deactivated_at) is distinct from (old.role, old.deactivated_at) then
    update public.calendar_feeds f
       set live = public.calendar_feed_member_live(f.agency_id, f.user_id), content_version = f.content_version + 1
     where f.agency_id = new.agency_id and f.user_id = new.user_id and f.revoked_at is null;
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function public.agency_members_calendar_feed_touch() from public;
--> statement-breakpoint
create trigger agency_members_calendar_feed_touch after update on public.agency_members for each row
  when ((new.name, new.role, new.deactivated_at) is distinct from (old.name, old.role, old.deactivated_at))
  execute function public.agency_members_calendar_feed_touch();
--> statement-breakpoint
-- an agency suspended or reinstated: its members' feeds' `live`
create function public.agencies_calendar_feed_live() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  with locked as (
    select f.id from public.calendar_feeds f where f.agency_id = new.agency_id and f.revoked_at is null
     order by f.id for update of f
  )
  update public.calendar_feeds f
     set live = public.calendar_feed_member_live(f.agency_id, f.user_id), content_version = f.content_version + 1
    from locked where f.id = locked.id;
  return null;
end $$;
--> statement-breakpoint
revoke all on function public.agencies_calendar_feed_live() from public;
--> statement-breakpoint
create trigger agencies_calendar_feed_live after update on public.agencies for each row
  when (new.status is distinct from old.status)
  execute function public.agencies_calendar_feed_live();
--> statement-breakpoint
-- the live feeds as their members stand now (`calendar_feeds` FORCEs row level security, which binds this migration's
-- role too: lifted for the backfill, inside the migration transaction, and restored — as 0124)
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'public.calendar_feeds'::regclass;
  ALTER TABLE public.calendar_feeds NO FORCE ROW LEVEL SECURITY;
  UPDATE public.calendar_feeds f SET live = public.calendar_feed_member_live(f.agency_id, f.user_id)
   WHERE f.revoked_at IS NULL;
  IF forced THEN
    ALTER TABLE public.calendar_feeds FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
