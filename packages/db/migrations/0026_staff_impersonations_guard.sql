-- S1-09: guard on staff impersonation sessions (registry `staff_impersonations`).
--   * Tenants (app_user) read their own agency's rows (the request ctx checks that an impersonated
--     call's session is still open) but never write them. A no-op update is let through: the isolation
--     suite proves the grant with one.
--   * Staff (app_staff) start sessions only as themselves, now, at most 60 minutes long, for an active
--     member of an agency that is not suspended; they end only their own open session, once, and change
--     nothing else. RLS (`staff_user_id = app_user_id()`) already limits them to their own rows.
--   * app_system (pnpm staff:revoke) may end sessions; app_auth only reads.
-- Security invoker, EXECUTE revoked: triggers fire without it.
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
--> statement-breakpoint
drop trigger if exists staff_impersonations_guard on staff_impersonations;
--> statement-breakpoint
create trigger staff_impersonations_guard before insert or update or delete on staff_impersonations
  for each row execute function staff_impersonations_guard();
