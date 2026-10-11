-- S1-01: tenant roles cannot verify, suspend, re-kind or delete their own agency, nor change a
-- member's role. RLS (STRICT own_rows) lets a tenant update its own rows; these triggers pin the
-- columns only staff (app_system, via withSystem) may change. Sign-up (app_auth) may re-kind its own
-- PENDING agency and the founder's role on a repeated sign-up (RLS limits it to that agency).
-- Security invoker, EXECUTE revoked: triggers fire without it, and the RLS guard sees no new callable function.
create function agencies_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- Only the request roles are restricted; staff (app_system), migrations and admins are not.
  if current_user not in ('app_user', 'app_auth') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'agencies: only staff delete agencies' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     or (new.kind is distinct from old.kind and current_user <> 'app_auth')
     or (old.onboarded_at is not null and new.onboarded_at is distinct from old.onboarded_at) then
    raise exception 'agencies: status, kind and onboarding date change through staff only' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agencies_guard() from public;
--> statement-breakpoint
create trigger agencies_guard before update or delete on agencies
  for each row execute function agencies_guard();
--> statement-breakpoint
create function agency_members_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return new;
  end if;
  -- S1-02 (roles, invites) replaces this with "only an AGENCY_ADMIN changes roles, never their own".
  if new.role is distinct from old.role or new.user_id is distinct from old.user_id then
    raise exception 'agency_members: roles change through staff only (until S1-02)' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_members_guard() from public;
--> statement-breakpoint
create trigger agency_members_guard before update on agency_members
  for each row execute function agency_members_guard();
