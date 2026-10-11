-- S1-02: replaces the S1-01 member guard (0006). RLS (STRICT own_rows) lets a tenant session write its
-- own agency's rows; these triggers narrow what app_user may do. Members join only through sign-up or
-- an invite (app_auth) and are deactivated, never deleted. Only an active admin of the agency changes a
-- member's role or deactivates them, and never on their own row. Invites are created and revoked by an
-- admin only; the token, acceptance and every other column belong to the email job (app_system) and
-- the accept flow (app_auth). Staff (app_system), migrations and admins are not restricted.
-- Security invoker, EXECUTE revoked: triggers fire without it, and the RLS guard sees no new callable function.
create or replace function agency_members_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'agency_members: members join through sign-up or an invite and are deactivated, not deleted'
      using errcode = '42501';
  end if;
  if (new.agency_id, new.user_id, new.name, new.email, new.created_at)
     is distinct from (old.agency_id, old.user_id, old.name, old.email, old.created_at) then
    raise exception 'agency_members: a tenant session changes only role and deactivation' using errcode = '42501';
  end if;
  if (new.role, new.deactivated_at) is distinct from (old.role, old.deactivated_at) then
    if old.user_id = app_user_id() then
      raise exception 'agency_members: nobody changes their own role or deactivates themselves' using errcode = '42501';
    end if;
    if not exists (
      select 1 from agency_members a
       where a.agency_id = old.agency_id and a.user_id = app_user_id()
         and a.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN') and a.deactivated_at is null
    ) then
      raise exception 'agency_members: only an agency admin changes roles' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
drop trigger agency_members_guard on agency_members;
--> statement-breakpoint
create trigger agency_members_guard before insert or update or delete on agency_members
  for each row execute function agency_members_guard();
--> statement-breakpoint
create function agency_invites_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'agency_invites: invites are revoked, not deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;
  if not exists (
    select 1 from agency_members a
     where a.agency_id = new.agency_id and a.user_id = app_user_id()
       and a.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN') and a.deactivated_at is null
  ) then
    raise exception 'agency_invites: only an agency admin invites' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.invited_by is distinct from app_user_id() or new.token_hash is not null or new.accepted_at is not null
       or new.accepted_user_id is not null or new.revoked_at is not null then
      raise exception 'agency_invites: a new invite is open, tokenless and by the caller' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.id, new.agency_id, new.email, new.role, new.invited_by, new.locale, new.token_hash, new.expires_at,
      new.accepted_at, new.accepted_user_id, new.created_at)
     is distinct from (old.id, old.agency_id, old.email, old.role, old.invited_by, old.locale, old.token_hash,
      old.expires_at, old.accepted_at, old.accepted_user_id, old.created_at)
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'agency_invites: a tenant session only revokes an invite' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_invites_guard() from public;
--> statement-breakpoint
create trigger agency_invites_guard before insert or update or delete on agency_invites
  for each row execute function agency_invites_guard();
