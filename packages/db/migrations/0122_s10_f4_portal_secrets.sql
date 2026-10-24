CREATE INDEX "agency_portal_connections_lane_idx" ON "agency_portal_connections" USING btree (hashtext("agency_id"::text),"agency_id","nightly_at") WHERE "agency_portal_connections"."enabled" and "agency_portal_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "portal_listing_sync_live_idx" ON "portal_listing_sync" USING btree ("agency_id","connection_id","property_id") WHERE "portal_listing_sync"."remote_id" is not null and "portal_listing_sync"."state" <> 'WITHDRAWN';--> statement-breakpoint
-- S10-F4: app_user may not write push_error (registry userNoUpdateColumns); a change of a push connection's credentials
-- or on/off state still lets the push job try again: this trigger clears the standing stop, whoever makes the change.
create or replace function agency_portal_connections_push_retry() returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.credentials_enc is distinct from old.credentials_enc or new.enabled is distinct from old.enabled then
    new.push_error := null;
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_portal_connections_push_retry() from public;
--> statement-breakpoint
create trigger agency_portal_connections_push_retry before update of credentials_enc, enabled on agency_portal_connections
  for each row execute function agency_portal_connections_push_retry();
