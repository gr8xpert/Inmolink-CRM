-- S7-01: replaces the 0018 guard. Keys are bound to a website site: a tenant creates a key only with a site
-- (the composite FK api_keys_site_fk keeps it in the key's agency), and never moves a key to another site.
-- Everything else as in 0018 (see there).
create or replace function api_keys_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'api_keys: keys are revoked, not deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.site_id is null then
      raise exception 'api_keys: a key is bound to a website site' using errcode = '42501';
    end if;
    if new.created_by is distinct from app_user_id() or new.rate_tier <> 'STANDARD'
       or new.last_used_at is not null or new.rotated_at is not null
       or new.revoked_at is not null or new.revoked_by is not null then
      raise exception 'api_keys: a key starts unused, unrevoked, STANDARD, created by the session user'
        using errcode = '42501';
    end if;
    new.agency_active := exists (select 1 from agencies a where a.agency_id = new.agency_id and a.status = 'VERIFIED');
    return new;
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception 'api_keys: a revoked key cannot change' using errcode = '42501';
  end if;
  if (new.id, new.agency_id, new.kind, new.created_by, new.created_at, new.last_used_at, new.rate_tier,
      new.scopes, new.allowed_origins, new.site_id)
     is distinct from (old.id, old.agency_id, old.kind, old.created_by, old.created_at, old.last_used_at,
      old.rate_tier, old.scopes, old.allowed_origins, old.site_id) then
    raise exception 'api_keys: owner, kind, creator, usage, tier, scopes, origins and site are not changed by tenants'
      using errcode = '42501';
  end if;
  if (new.prefix, new.key_hash) is distinct from (old.prefix, old.key_hash)
     and (new.rotated_at is null or new.rotated_at is not distinct from old.rotated_at) then
    raise exception 'api_keys: a new secret comes with a new rotated_at' using errcode = '42501';
  end if;
  if new.rotated_at is distinct from old.rotated_at
     and (new.prefix, new.key_hash) is not distinct from (old.prefix, old.key_hash) then
    raise exception 'api_keys: rotated_at changes only with a new secret' using errcode = '42501';
  end if;
  if (new.revoked_at, new.revoked_by) is distinct from (old.revoked_at, old.revoked_by)
     and (new.revoked_at is null or new.revoked_by is distinct from app_user_id()) then
    raise exception 'api_keys: a key is revoked with a time, by the session user' using errcode = '42501';
  end if;
  new.agency_active := exists (select 1 from agencies a where a.agency_id = new.agency_id and a.status = 'VERIFIED');
  return new;
end $$;
--> statement-breakpoint
revoke all on function api_keys_guard() from public;
--> statement-breakpoint
drop trigger api_keys_guard on api_keys;
--> statement-breakpoint
create trigger api_keys_guard before insert or update or delete on api_keys
  for each row execute function api_keys_guard();
