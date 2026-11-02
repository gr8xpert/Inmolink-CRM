-- S17-F4: the legacy /v1 shim is retired, and with it the migrated-legacy-key mark (S8-02, S8-F26). The api_keys guard
-- (0118) is replaced first without the legacy_query_key check (it would fail once the column is gone); everything
-- else as in 0118. The column grant lock (db:rls `userNoUpdateColumns`) goes with it.
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
-- S17-F4 review: a key flagged for the legacy `?api_key=` parameter has lived in URLs (CDN, proxy and site logs) and
-- would keep working by header once the flag is gone: revoke every such key before the only record of it is dropped.
-- The guard lets this through (it checks app_user only); revoked_by stays null (a system revocation). Few rows (only
-- imported legacy keys were ever flagged): no batching. The table FORCEs row level security (pnpm db:rls), which hides
-- its rows from the owner running this migration: lifted for the update inside the migration transaction, then restored
-- (as 0033).
DO $$
DECLARE keys_forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO keys_forced FROM pg_class WHERE oid = 'public.api_keys'::regclass;
  ALTER TABLE "api_keys" NO FORCE ROW LEVEL SECURITY;
  UPDATE "api_keys" SET "revoked_at" = now(), "updated_at" = now() WHERE "legacy_query_key" AND "revoked_at" IS NULL;
  IF keys_forced THEN ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "legacy_query_key";
