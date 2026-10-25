ALTER TABLE "billing_catalog_items" ADD COLUMN "limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "website_sites" ADD COLUMN "plan_code" text;--> statement-breakpoint
ALTER TABLE "website_sites" ADD COLUMN "plan_ends_at" timestamp with time zone;--> statement-breakpoint
-- S13-F21: the site's plan columns are the worker's (`websites.syncSitePlan`, app_system): tenants (`app_user`) create
-- a site without them and never change them (a member must not lift its own website API cut-off). Otherwise as 0093.
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
    if new.plan_code is not null or new.plan_ends_at is not null then
      raise exception 'website_sites: the plan columns are set by the worker' using errcode = '42501';
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
  if (new.plan_code, new.plan_ends_at) is distinct from (old.plan_code, old.plan_ends_at) then
    raise exception 'website_sites: the plan columns are set by the worker' using errcode = '42501';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'website_sites: a change moves the version on by one' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function website_sites_guard() from public;
