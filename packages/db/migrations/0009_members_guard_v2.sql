-- S1-02 review follow-up: the guards from 0008 also check role families, and narrow what the anonymous
-- invite-accept flow (app_auth) may change. An admin hands out only roles of their own family (agency:
-- AGENCY_ADMIN/AGENT; developer: DEVELOPER_ADMIN/DEVELOPER_AGENT) and edits only members of that
-- family. app_auth may only mark an open invite accepted by the user it scoped to.
create or replace function agency_members_guard() returns trigger language plpgsql security invoker set search_path = public as $$
declare
  caller_role member_role;
  family member_role[];
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
    select a.role into caller_role from agency_members a
     where a.agency_id = old.agency_id and a.user_id = app_user_id() and a.deactivated_at is null;
    family := case caller_role
      when 'AGENCY_ADMIN' then array['AGENCY_ADMIN', 'AGENT']::member_role[]
      when 'DEVELOPER_ADMIN' then array['DEVELOPER_ADMIN', 'DEVELOPER_AGENT']::member_role[]
    end;
    if family is null then
      raise exception 'agency_members: only an agency admin changes roles' using errcode = '42501';
    end if;
    if not (old.role = any (family) and new.role = any (family)) then
      raise exception 'agency_members: an admin manages only the roles of their own family' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
create or replace function agency_invites_guard() returns trigger language plpgsql security invoker set search_path = public as $$
declare
  caller_role member_role;
begin
  if current_user = 'app_auth' then
    -- Accept flow: only an open invite, only the acceptance columns, only for the scoped user.
    if tg_op <> 'UPDATE' or old.accepted_at is not null or old.revoked_at is not null
       or new.accepted_at is null or new.accepted_user_id is distinct from app_user_id()
       or (new.id, new.agency_id, new.email, new.role, new.invited_by, new.locale, new.token_hash, new.expires_at,
           new.revoked_at, new.created_at)
          is distinct from (old.id, old.agency_id, old.email, old.role, old.invited_by, old.locale, old.token_hash,
           old.expires_at, old.revoked_at, old.created_at) then
      raise exception 'agency_invites: the accept flow only marks an open invite accepted' using errcode = '42501';
    end if;
    return new;
  end if;
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'agency_invites: invites are revoked, not deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new is not distinct from old then
    return new;
  end if;
  select a.role into caller_role from agency_members a
   where a.agency_id = new.agency_id and a.user_id = app_user_id() and a.deactivated_at is null;
  if caller_role is null or caller_role not in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN') then
    raise exception 'agency_invites: only an agency admin invites' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.invited_by is distinct from app_user_id() or new.token_hash is not null or new.accepted_at is not null
       or new.accepted_user_id is not null or new.revoked_at is not null then
      raise exception 'agency_invites: a new invite is open, tokenless and by the caller' using errcode = '42501';
    end if;
    if not (new.role = any (case caller_role
        when 'AGENCY_ADMIN' then array['AGENCY_ADMIN', 'AGENT']::member_role[]
        else array['DEVELOPER_ADMIN', 'DEVELOPER_AGENT']::member_role[] end)) then
      raise exception 'agency_invites: an admin invites only to the roles of their own family' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Revoking: own or another admin's invite (an admin removing a colleague revokes their invites).
  if (new.id, new.agency_id, new.email, new.role, new.invited_by, new.locale, new.token_hash, new.expires_at,
      new.accepted_at, new.accepted_user_id, new.created_at)
     is distinct from (old.id, old.agency_id, old.email, old.role, old.invited_by, old.locale, old.token_hash,
      old.expires_at, old.accepted_at, old.accepted_user_id, old.created_at)
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'agency_invites: a tenant session only revokes an invite' using errcode = '42501';
  end if;
  return new;
end $$;
