CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "client_registration_fingerprints" (
	"registration_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_registration_fingerprints_pk" PRIMARY KEY("agency_id","registration_id","fingerprint"),
	CONSTRAINT "client_registration_fingerprints_validity_ck" CHECK ("client_registration_fingerprints"."expires_at" > "client_registration_fingerprints"."registered_at" and "client_registration_fingerprints"."expires_at" <= "client_registration_fingerprints"."registered_at" + interval '1095 days')
);
--> statement-breakpoint
CREATE TABLE "client_registration_receipts" (
	"registration_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"introducer_agency_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"registered_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', registered_at, 'UTC')) STORED NOT NULL,
	CONSTRAINT "client_registration_receipts_target_ck" CHECK ("client_registration_receipts"."target_kind" in ('LISTING', 'DEVELOPMENT'))
);
--> statement-breakpoint
CREATE TABLE "client_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"target_agency_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"registered_by_user_id" uuid,
	"details_enc" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"registered_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', registered_at, 'UTC')) STORED NOT NULL,
	CONSTRAINT "client_registrations_fingerprint_key_uq" UNIQUE("agency_id","id","target_id","registered_at","expires_at"),
	CONSTRAINT "client_registrations_owner_ck" CHECK ("client_registrations"."target_agency_id" <> "client_registrations"."agency_id"),
	CONSTRAINT "client_registrations_target_ck" CHECK ("client_registrations"."target_kind" in ('LISTING', 'DEVELOPMENT')),
	CONSTRAINT "client_registrations_validity_ck" CHECK ("client_registrations"."expires_at" > "client_registrations"."registered_at" and "client_registrations"."expires_at" <= "client_registrations"."registered_at" + interval '1095 days')
);
--> statement-breakpoint
ALTER TABLE "client_registration_fingerprints" ADD CONSTRAINT "client_registration_fingerprints_registration_fk" FOREIGN KEY ("agency_id","registration_id","target_id","registered_at","expires_at") REFERENCES "public"."client_registrations"("agency_id","id","target_id","registered_at","expires_at") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "client_registration_fingerprints_expires_idx" ON "client_registration_fingerprints" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "client_registration_receipts_agency_registered_idx" ON "client_registration_receipts" USING btree ("agency_id","registered_ms","registration_id");--> statement-breakpoint
CREATE INDEX "client_registrations_agency_registered_idx" ON "client_registrations" USING btree ("agency_id","registered_ms","id");--> statement-breakpoint
CREATE INDEX "client_registrations_contact_idx" ON "client_registrations" USING btree ("agency_id","contact_id");--> statement-breakpoint
CREATE INDEX "client_registrations_agency_expires_idx" ON "client_registrations" USING btree ("agency_id","expires_at","id");--> statement-breakpoint
-- S11-01, first valid wins (PLAN §3 #8): one client (fingerprint) per target while a registration is valid, across
-- agencies — a constraint, so it holds whatever rows RLS lets the inserting agency see. An expired registration's
-- [registered_at, expires_at) ended before a new one starts and no longer overlaps.
ALTER TABLE "client_registration_fingerprints" ADD CONSTRAINT "client_registration_fingerprints_valid_ex" EXCLUDE USING gist ("target_id" WITH =, "fingerprint" WITH =, tstzrange("registered_at", "expires_at") WITH &&);
--> statement-breakpoint
-- S11-01 receipt writer: the registration starts at the database's now() (whatever was inserted: priority is the start),
-- keeps the requested length capped at the target owner's `registration_validity_days` (the shorter of both agencies'
-- settings), and appends the owner's receipt — nothing of the client. SECURITY DEFINER owned by app_owner (this
-- migration's role), search_path pinned, executable by nobody: it reads `agency_settings` through its `definer_read`
-- policy and appends through the receipts' `definer_append` policy.
create function client_registrations_receipt() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare
  owner_days integer;
  requested interval := new.expires_at - new.registered_at;
begin
  new.registered_at := now();
  new.expires_at := new.registered_at + requested;
  select s.registration_validity_days into owner_days
    from public.agency_settings s where s.agency_id = new.target_agency_id;
  if owner_days is not null then
    new.expires_at := least(new.expires_at, new.registered_at + make_interval(days => owner_days));
  end if;
  insert into public.client_registration_receipts
    (registration_id, agency_id, introducer_agency_id, target_kind, target_id, registered_at, expires_at)
  values (new.id, new.target_agency_id, new.agency_id, new.target_kind, new.target_id, new.registered_at, new.expires_at);
  return new;
end $$;
--> statement-breakpoint
revoke all on function client_registrations_receipt() from public;
--> statement-breakpoint
create trigger client_registrations_receipt before insert on client_registrations
  for each row execute function client_registrations_receipt();
--> statement-breakpoint
-- S11-01 guard: a registration is evidence for both sides (who registered the client first) and its fingerprints are
-- what makes it block: a request never deletes either. Only app_user is restricted (migrations, app_system are not).
create function client_registrations_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    raise exception '%: rows are never deleted by a request', tg_table_name using errcode = '42501';
  end if;
  return old;
end $$;
--> statement-breakpoint
revoke all on function client_registrations_guard() from public;
--> statement-breakpoint
create trigger client_registrations_guard before delete on client_registrations
  for each row execute function client_registrations_guard();
--> statement-breakpoint
create trigger client_registration_fingerprints_guard before delete on client_registration_fingerprints
  for each row execute function client_registrations_guard();
