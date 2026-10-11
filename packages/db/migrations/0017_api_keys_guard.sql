-- S1-05: column rules for API keys. RLS (PUBLIC_READ own_rows) lets a tenant update its own keys; this
-- trigger pins what a tenant session may change: rotation (prefix, hash, rotated_at) and revocation
-- (revoked_at, revoked_by), never the owner, kind, creator, the mirrored agency status or the usage
-- time (workers, app_system). A revoked key is final, and keys are never deleted by tenants (history).
-- Security invoker, EXECUTE revoked (as in 0006): triggers fire without it.
create function api_keys_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  -- Only the tenant request role is restricted; workers (app_system), migrations and admins are not.
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'api_keys: keys are revoked, not deleted' using errcode = '42501';
  end if;
  if new is not distinct from old then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception 'api_keys: a revoked key cannot change' using errcode = '42501';
  end if;
  if (new.id, new.agency_id, new.kind, new.agency_active, new.created_by, new.created_at, new.last_used_at)
     is distinct from (old.id, old.agency_id, old.kind, old.agency_active, old.created_by, old.created_at, old.last_used_at) then
    raise exception 'api_keys: owner, kind, creator, agency status and usage are not changed by tenants'
      using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function api_keys_guard() from public;
--> statement-breakpoint
create trigger api_keys_guard before update or delete on api_keys
  for each row execute function api_keys_guard();
