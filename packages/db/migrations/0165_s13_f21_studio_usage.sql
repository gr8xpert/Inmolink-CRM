CREATE TABLE "listing_studio_usage" (
	"agency_id" uuid NOT NULL,
	"month" date NOT NULL,
	"listings" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_studio_usage_agency_id_month_pk" PRIMARY KEY("agency_id","month"),
	CONSTRAINT "listing_studio_usage_listings_ck" CHECK ("listing_studio_usage"."listings" >= 0)
);
--> statement-breakpoint
ALTER TABLE "listing_studio_usage" ADD CONSTRAINT "listing_studio_usage_agency_id_agencies_agency_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("agency_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- S13-F21 (security review): the monthly Listing Studio count is the plan quota's — members (`app_user`) only add to
-- it: no delete, no lower count, no other agency or month on an existing row. Other roles are not checked.
create or replace function listing_studio_usage_guard() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'app_user' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'listing_studio_usage: usage is not deleted by tenants' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if (new.agency_id, new.month) is distinct from (old.agency_id, old.month) or new.listings < old.listings then
      raise exception 'listing_studio_usage: usage only grows' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function listing_studio_usage_guard() from public;
--> statement-breakpoint
create trigger listing_studio_usage_guard before update or delete on listing_studio_usage
  for each row execute function listing_studio_usage_guard();
