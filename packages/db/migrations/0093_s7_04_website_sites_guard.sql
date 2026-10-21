-- S7-04 (S7-01 security review, Decision 6): tenants (`app_user`) create a site as the session user at version 1,
-- change it only with the version moved on by one (optimistic concurrency cannot be skipped or replayed), never
-- change who created it, when, or whose it is, and never delete one (keys reference their site; there is no delete
-- use case). Other roles (migrations, app_system, the isolation suite's admin) are not checked.
create or replace function website_sites_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'website_sites: sites are not deleted by tenants' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.created_by is distinct from app_user_id() or new.version <> 1 then
      raise exception 'website_sites: a site starts at version 1, created by the session user' using errcode = '42501';
    end if;
    return new;
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if (new.id, new.agency_id, new.created_by, new.created_at)
     is distinct from (old.id, old.agency_id, old.created_by, old.created_at) then
    raise exception 'website_sites: owner, creator and creation time are not changed' using errcode = '42501';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'website_sites: a change moves the version on by one' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function website_sites_guard() from public;
--> statement-breakpoint
create trigger website_sites_guard before insert or update or delete on website_sites
  for each row execute function website_sites_guard();
