ALTER TABLE "agency_settings" ADD COLUMN "ai_features" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_settings" ADD CONSTRAINT "agency_settings_ai_features_ck" CHECK ("agency_settings"."ai_features" <@ array['WEBSITE_SEARCH', 'WHITE_LABEL', 'LISTING_STUDIO', 'SOCIAL_CAPTIONS', 'TRANSLATION_DRAFTS']::text[]);--> statement-breakpoint
-- S13-F17 review: the AI feature toggles are an admin's decision (they spend the agency's money). A tenant session
-- (app_user) changes `ai_features` only as an active admin of the agency, never while staff impersonate — the service
-- rule (`agencies.setAgencyAiFeature`, which also audits) enforced where RLS cannot. Workers and scripts pass.
-- Security invoker, EXECUTE revoked: triggers fire without it. `search_path = public, pg_temp`: pg_temp last.
create or replace function agency_settings_ai_features_guard() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'app_user' or new.ai_features is not distinct from old.ai_features then
    return new;
  end if;
  if app_impersonated_by() is not null then
    raise exception 'agency_settings: AI features are not switched while impersonating' using errcode = '42501';
  end if;
  if not exists (
       select 1 from agency_members m
        where m.agency_id = app_agency() and m.user_id = app_user_id() and m.deactivated_at is null
          and m.role in ('AGENCY_ADMIN', 'DEVELOPER_ADMIN')) then
    raise exception 'agency_settings: only an agency admin switches AI features' using errcode = '42501';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function agency_settings_ai_features_guard() from public;
--> statement-breakpoint
drop trigger if exists agency_settings_ai_features_guard on agency_settings;
--> statement-breakpoint
create trigger agency_settings_ai_features_guard before update of ai_features on agency_settings
  for each row execute function agency_settings_ai_features_guard();
