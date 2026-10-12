-- S1-09 review: replaces the 0026 guard on staff impersonation sessions. Adds: staff start a session only
-- with a role that may impersonate (SUPER_ADMIN, STAFF_SUPPORT — mirrors identity `canStaff`). The staff
-- member's own `staff_users` row is visible to app_staff (policy staff_self). Whether the target is staff
-- cannot be checked here (staff see only their own row): the access-token mint refuses that (app_auth).
create or replace function staff_impersonations_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user = 'app_user' then
    if tg_op = 'UPDATE' and new is not distinct from old then
      return new;
    end if;
    raise exception 'staff_impersonations: tenants do not write impersonation sessions' using errcode = '42501';
  end if;
  if current_user = 'app_staff' then
    if tg_op = 'DELETE' then
      raise exception 'staff_impersonations: sessions are ended, never deleted' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' then
      if new.staff_user_id is distinct from app_user_id() or new.ended_at is not null
         or new.started_at is distinct from now() or new.expires_at > now() + interval '60 minutes' then
        raise exception 'staff_impersonations: staff start their own session, now, for at most 60 minutes' using errcode = '42501';
      end if;
      if not exists (
           select 1 from staff_users s
            where s.user_id = app_user_id() and s.deactivated_at is null and s.role in ('SUPER_ADMIN', 'STAFF_SUPPORT')) then
        raise exception 'staff_impersonations: this staff role may not impersonate' using errcode = '42501';
      end if;
      if not exists (
           select 1 from agency_members m
            where m.agency_id = new.agency_id and m.user_id = new.target_user_id and m.deactivated_at is null)
         or not exists (
           select 1 from agencies a where a.agency_id = new.agency_id and a.status <> 'SUSPENDED') then
        raise exception 'staff_impersonations: only an active member of an agency that is not suspended' using errcode = '42501';
      end if;
      return new;
    end if;
    -- UPDATE: end the open session once; nothing else changes.
    if old.ended_at is not null or new.ended_at is null
       or (to_jsonb(new) - array['ended_at', 'updated_at']) is distinct from (to_jsonb(old) - array['ended_at', 'updated_at']) then
      raise exception 'staff_impersonations: staff only end an open session' using errcode = '42501';
    end if;
    return new;
  end if;
  return coalesce(new, old);
end $$;
--> statement-breakpoint
revoke all on function staff_impersonations_guard() from public;
