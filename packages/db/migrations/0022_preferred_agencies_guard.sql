-- S1-07 preferred agencies. Triggers keep tenants (and staff) to the service rules where RLS cannot.
-- Security invoker, EXECUTE revoked: triggers fire without it. `search_path = public, pg_temp`: pg_temp
-- last, so a temporary object can never shadow a table these functions read.
-- Triggers are dropped first (`if exists`) so this file can be re-applied while it is uncommitted.
--
-- agency_directory mirrors `agencies` (name, kind, listed = VERIFIED) in the same transaction as the
-- change: staff decisions run as app_staff (registry `staff` predicates on agency_directory), seeds and
-- workers as app_system. PENDING agencies are not listed and need no row: sign-up (app_auth) and the
-- onboarding rename (app_user, only while PENDING — guard 0020) never reach the directory. A rename or
-- kind change of a listed (or once-listed) agency — staff or system only — is copied too.
create or replace function agencies_directory_sync() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.status <> 'VERIFIED' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if (new.status, new.name, new.kind) is not distinct from (old.status, old.name, old.kind) then
      return null;
    end if;
    if new.status = 'PENDING' and old.status = 'PENDING' then
      return null;
    end if;
  end if;
  insert into agency_directory (agency_id, name, kind, listed, updated_at)
  values (new.agency_id, new.name, new.kind, new.status = 'VERIFIED', now())
  on conflict (agency_id) do update
    set name = excluded.name, kind = excluded.kind, listed = excluded.listed, updated_at = excluded.updated_at;
  return null;
end $$;
--> statement-breakpoint
revoke all on function agencies_directory_sync() from public;
--> statement-breakpoint
drop trigger if exists agencies_directory_sync on agencies;
--> statement-breakpoint
create trigger agencies_directory_sync after insert or update of status, name, kind on agencies
  for each row execute function agencies_directory_sync();
--> statement-breakpoint
-- Tenants never write the directory (a no-op update is let through: the isolation suite proves the grant
-- with one). Staff write only what `agencies` says, i.e. the sync above.
create or replace function agency_directory_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'UPDATE' and new is not distinct from old then
      return new;
    end if;
    raise exception 'agency_directory: the directory follows the agency, tenants do not write it' using errcode = '42501';
  end if;
  if current_user = 'app_staff' then
    if tg_op = 'DELETE' or not exists (
         select 1 from agencies a
          where a.agency_id = new.agency_id and a.name = new.name and a.kind = new.kind
            and (a.status = 'VERIFIED') = new.listed) then
      raise exception 'agency_directory: staff rows mirror the agency' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
--> statement-breakpoint
revoke all on function agency_directory_guard() from public;
--> statement-breakpoint
drop trigger if exists agency_directory_guard on agency_directory;
--> statement-breakpoint
create trigger agency_directory_guard before insert or update or delete on agency_directory
  for each row execute function agency_directory_guard();
--> statement-breakpoint
-- preferred_agencies (tenant sessions): only an active admin adds or removes; only a VERIFIED agency
-- adds, only an agency listed in the directory (VERIFIED now), and at most 200 — the same number as
-- `MAX_PREFERRED_AGENCIES` in packages/contracts/src/preferred-agencies.ts (change both together). The
-- agency row is locked first (as the service does), so concurrent direct inserts cannot pass the cap.
-- A relationship is never changed (a no-op update is let through for the isolation suite); duplicates
-- hit the primary key. NOT checked here: that the admin is not staff impersonating them — the database
-- does not know about impersonation, so "add is refused while impersonating" is a service rule only
-- (agencies policy `agencies.preferred.add`).
create or replace function preferred_agencies_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    if new is not distinct from old then
      return new;
    end if;
    raise exception 'preferred_agencies: a relationship is added or removed, never changed' using errcode = '42501';
  end if;
  if not exists (
       select 1 from agency_members m
        where m.agency_id = app_agency() and m.user_id = app_user_id() and m.deactivated_at is null
          and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')) then
    raise exception 'preferred_agencies: only an agency admin manages preferred agencies' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  perform 1 from agencies a where a.agency_id = new.agency_id for no key update;
  if not exists (select 1 from agencies a where a.agency_id = new.agency_id and a.status = 'VERIFIED') then
    raise exception 'preferred_agencies: only a verified agency prefers agencies' using errcode = '42501';
  end if;
  if not exists (select 1 from agency_directory d where d.agency_id = new.preferred_agency_id and d.listed) then
    raise exception 'preferred_agencies: only a verified agency can be preferred' using errcode = '42501';
  end if;
  if (select count(*) from preferred_agencies p where p.agency_id = new.agency_id) >= 200 then
    raise exception 'preferred_agencies: the list is full (200)' using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end $$;
--> statement-breakpoint
revoke all on function preferred_agencies_guard() from public;
--> statement-breakpoint
drop trigger if exists preferred_agencies_guard on preferred_agencies;
--> statement-breakpoint
create trigger preferred_agencies_guard before insert or update or delete on preferred_agencies
  for each row execute function preferred_agencies_guard();
--> statement-breakpoint
-- preferred_agency_notes (tenant sessions): only an active admin writes; created by the caller. Deletes
-- cascading from preferred_agencies run as the table owner and pass.
create or replace function preferred_agency_notes_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;
  if not exists (
       select 1 from agency_members m
        where m.agency_id = app_agency() and m.user_id = app_user_id() and m.deactivated_at is null
          and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')) then
    raise exception 'preferred_agency_notes: only an agency admin writes notes' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.created_by is distinct from app_user_id() then
    raise exception 'preferred_agency_notes: created by the caller' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.created_by, new.name_when_added) is distinct from (old.created_by, old.name_when_added) then
    raise exception 'preferred_agency_notes: only the note changes' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
--> statement-breakpoint
revoke all on function preferred_agency_notes_guard() from public;
--> statement-breakpoint
drop trigger if exists preferred_agency_notes_guard on preferred_agency_notes;
--> statement-breakpoint
create trigger preferred_agency_notes_guard before insert or update or delete on preferred_agency_notes
  for each row execute function preferred_agency_notes_guard();
--> statement-breakpoint
-- Backfill the directory with the agencies verified before this migration. `agencies` FORCEs row level
-- security (pnpm db:rls), which hides its rows from the owner running this migration: lift it for the
-- backfill, inside the migration transaction, and restore it.
DO $$
DECLARE agencies_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO agencies_forced FROM pg_class WHERE oid = 'public.agencies'::regclass;
  ALTER TABLE "agencies" NO FORCE ROW LEVEL SECURITY;
  INSERT INTO "agency_directory" (agency_id, name, kind, listed)
    SELECT a.agency_id, a.name, a.kind, true FROM "agencies" a WHERE a.status = 'VERIFIED'
    ON CONFLICT (agency_id) DO NOTHING;
  IF agencies_forced THEN ALTER TABLE "agencies" FORCE ROW LEVEL SECURITY; END IF;
END $$;
