CREATE TABLE "viewing_request_receipts" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"introducer_agency_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text NOT NULL,
	"awaiting" text,
	"proposed_start_at" timestamp with time zone NOT NULL,
	"scheduled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"closed_by" text,
	"commission_bp" integer,
	"commission_fixed_cents" bigint,
	"commission_currency" char(3),
	"split_bp" integer NOT NULL,
	"commission_includes_vat" boolean NOT NULL,
	"terms_valid_until" timestamp with time zone NOT NULL,
	"terms_at" timestamp with time zone DEFAULT now() NOT NULL,
	"introducer_accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"introducer_accepted_by" uuid,
	"owner_accepted_at" timestamp with time zone,
	"owner_accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	CONSTRAINT "viewing_request_receipts_target_ck" CHECK ("viewing_request_receipts"."target_kind" in ('LISTING', 'DEVELOPMENT')),
	CONSTRAINT "viewing_request_receipts_status_ck" CHECK ("viewing_request_receipts"."status" in ('REQUESTED', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "viewing_request_receipts_awaiting_ck" CHECK (("viewing_request_receipts"."status" = 'REQUESTED') = ("viewing_request_receipts"."awaiting" is not null)
        and ("viewing_request_receipts"."awaiting" is null or "viewing_request_receipts"."awaiting" in ('OWNER', 'INTRODUCER'))
        and ("viewing_request_receipts"."status" <> 'REQUESTED' or "viewing_request_receipts"."expires_at" is not null)),
	CONSTRAINT "viewing_request_receipts_scheduled_ck" CHECK ("viewing_request_receipts"."status" not in ('SCHEDULED', 'COMPLETED') or ("viewing_request_receipts"."scheduled_at" is not null and "viewing_request_receipts"."owner_accepted_at" is not null)),
	CONSTRAINT "viewing_request_receipts_outcome_ck" CHECK (("viewing_request_receipts"."status" = 'COMPLETED') = ("viewing_request_receipts"."outcome" is not null)
        and ("viewing_request_receipts"."outcome" is null or ("viewing_request_receipts"."outcome" in ('ATTENDED', 'NO_SHOW') and "viewing_request_receipts"."outcome_at" is not null))),
	CONSTRAINT "viewing_request_receipts_closed_ck" CHECK (("viewing_request_receipts"."status" in ('DECLINED', 'CANCELLED', 'EXPIRED')) = ("viewing_request_receipts"."closed_by" is not null)
        and ("viewing_request_receipts"."closed_by" is null or "viewing_request_receipts"."closed_by" in ('OWNER', 'INTRODUCER', 'SYSTEM'))),
	CONSTRAINT "viewing_request_receipts_terms_ck" CHECK (("viewing_request_receipts"."commission_bp" is null) <> ("viewing_request_receipts"."commission_fixed_cents" is null)
        and ("viewing_request_receipts"."commission_bp" is null or "viewing_request_receipts"."commission_bp" between 1 and 10000)
        and ("viewing_request_receipts"."commission_fixed_cents" is null
             or ("viewing_request_receipts"."commission_fixed_cents" between 1 and 100000000000 and "viewing_request_receipts"."commission_currency" is not null))
        and "viewing_request_receipts"."split_bp" between 0 and 10000),
	CONSTRAINT "viewing_request_receipts_owner_accepted_ck" CHECK (("viewing_request_receipts"."owner_accepted_at" is null) = ("viewing_request_receipts"."owner_accepted_by" is null))
);
--> statement-breakpoint
CREATE TABLE "viewing_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agency_id" uuid NOT NULL,
	"owner_agency_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text NOT NULL,
	"awaiting" text,
	"proposed_start_at" timestamp with time zone NOT NULL,
	"scheduled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"closed_by" text,
	"commission_bp" integer,
	"commission_fixed_cents" bigint,
	"commission_currency" char(3),
	"split_bp" integer NOT NULL,
	"commission_includes_vat" boolean NOT NULL,
	"terms_valid_until" timestamp with time zone NOT NULL,
	"terms_at" timestamp with time zone DEFAULT now() NOT NULL,
	"introducer_accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"introducer_accepted_by" uuid,
	"owner_accepted_at" timestamp with time zone,
	"owner_accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	"idempotency_hash" text,
	"request_hash" text,
	CONSTRAINT "viewing_requests_owner_ck" CHECK ("viewing_requests"."owner_agency_id" <> "viewing_requests"."agency_id"),
	CONSTRAINT "viewing_requests_target_ck" CHECK ("viewing_requests"."target_kind" in ('LISTING', 'DEVELOPMENT')),
	CONSTRAINT "viewing_requests_status_ck" CHECK ("viewing_requests"."status" in ('REQUESTED', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "viewing_requests_awaiting_ck" CHECK (("viewing_requests"."status" = 'REQUESTED') = ("viewing_requests"."awaiting" is not null)
        and ("viewing_requests"."awaiting" is null or "viewing_requests"."awaiting" in ('OWNER', 'INTRODUCER'))
        and ("viewing_requests"."status" <> 'REQUESTED' or "viewing_requests"."expires_at" is not null)),
	CONSTRAINT "viewing_requests_scheduled_ck" CHECK ("viewing_requests"."status" not in ('SCHEDULED', 'COMPLETED') or ("viewing_requests"."scheduled_at" is not null and "viewing_requests"."owner_accepted_at" is not null)),
	CONSTRAINT "viewing_requests_outcome_ck" CHECK (("viewing_requests"."status" = 'COMPLETED') = ("viewing_requests"."outcome" is not null)
        and ("viewing_requests"."outcome" is null or ("viewing_requests"."outcome" in ('ATTENDED', 'NO_SHOW') and "viewing_requests"."outcome_at" is not null))),
	CONSTRAINT "viewing_requests_closed_ck" CHECK (("viewing_requests"."status" in ('DECLINED', 'CANCELLED', 'EXPIRED')) = ("viewing_requests"."closed_by" is not null)
        and ("viewing_requests"."closed_by" is null or "viewing_requests"."closed_by" in ('OWNER', 'INTRODUCER', 'SYSTEM'))),
	CONSTRAINT "viewing_requests_terms_ck" CHECK (("viewing_requests"."commission_bp" is null) <> ("viewing_requests"."commission_fixed_cents" is null)
        and ("viewing_requests"."commission_bp" is null or "viewing_requests"."commission_bp" between 1 and 10000)
        and ("viewing_requests"."commission_fixed_cents" is null
             or ("viewing_requests"."commission_fixed_cents" between 1 and 100000000000 and "viewing_requests"."commission_currency" is not null))
        and "viewing_requests"."split_bp" between 0 and 10000),
	CONSTRAINT "viewing_requests_owner_accepted_ck" CHECK (("viewing_requests"."owner_accepted_at" is null) = ("viewing_requests"."owner_accepted_by" is null))
);
--> statement-breakpoint
ALTER TABLE "client_registrations" ADD CONSTRAINT "client_registrations_viewing_key_uq" UNIQUE("id","agency_id","target_agency_id","target_kind","target_id");--> statement-breakpoint
ALTER TABLE "viewing_requests" ADD CONSTRAINT "viewing_requests_registration_fk" FOREIGN KEY ("registration_id","agency_id","owner_agency_id","target_kind","target_id") REFERENCES "public"."client_registrations"("id","agency_id","target_agency_id","target_kind","target_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viewing_request_receipts_agency_created_idx" ON "viewing_request_receipts" USING btree ("agency_id","created_ms","request_id");--> statement-breakpoint
CREATE INDEX "viewing_requests_agency_created_idx" ON "viewing_requests" USING btree ("agency_id","created_ms","id");--> statement-breakpoint
CREATE INDEX "viewing_requests_contact_idx" ON "viewing_requests" USING btree ("agency_id","contact_id");--> statement-breakpoint
CREATE INDEX "viewing_requests_registration_idx" ON "viewing_requests" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "viewing_requests_open_uq" ON "viewing_requests" USING btree ("agency_id","registration_id") WHERE "viewing_requests"."status" in ('REQUESTED', 'SCHEDULED');--> statement-breakpoint
CREATE INDEX "viewing_requests_expiry_idx" ON "viewing_requests" USING btree ("expires_at") WHERE "viewing_requests"."status" = 'REQUESTED';--> statement-breakpoint
CREATE INDEX "viewing_requests_lapse_idx" ON "viewing_requests" USING btree ("terms_valid_until") WHERE "viewing_requests"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE UNIQUE INDEX "viewing_requests_idempotency_uq" ON "viewing_requests" USING btree ("agency_id","idempotency_hash") WHERE "viewing_requests"."idempotency_hash" is not null;--> statement-breakpoint
-- S11-02 insert guard: a request (app_user) starts as a proposal awaiting the owner, nothing accepted, closed or
-- scheduled — a forged "accepted" row is refused — and its terms and the introducer's acceptance are stamped with the
-- database's now(). Workers and migrations are not restricted.
create function viewing_requests_insert_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    if new.status <> 'REQUESTED' or new.awaiting is distinct from 'OWNER'
       or new.owner_accepted_at is not null or new.owner_accepted_by is not null
       or new.outcome is not null or new.outcome_at is not null or new.closed_by is not null
       or new.scheduled_at is not null then
      raise exception 'viewing_requests: a request starts as a proposal awaiting the owner' using errcode = '42501';
    end if;
    new.terms_at := now();
    new.introducer_accepted_at := now();
    new.created_at := now();
    new.updated_at := now();
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function viewing_requests_insert_guard() from public;
--> statement-breakpoint
create trigger viewing_requests_insert_guard before insert on viewing_requests
  for each row execute function viewing_requests_insert_guard();
--> statement-breakpoint
-- S11-02 receipt writer: a new viewing request appends the owner's copy — the state and the terms snapshot, the
-- introducer agency, nothing of the client (no registration, no contact). SECURITY DEFINER owned by app_owner (this
-- migration's role), search_path pinned, executable by nobody: it appends through the copy's `definer_append` policy.
create function viewing_requests_receipt() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  insert into public.viewing_request_receipts
    (request_id, agency_id, introducer_agency_id, target_kind, target_id, status, awaiting, proposed_start_at,
     scheduled_at, expires_at, outcome, outcome_at, closed_by, commission_bp, commission_fixed_cents,
     commission_currency, split_bp, commission_includes_vat, terms_valid_until, terms_at, introducer_accepted_at,
     introducer_accepted_by, owner_accepted_at, owner_accepted_by, created_at, updated_at)
  values (new.id, new.owner_agency_id, new.agency_id, new.target_kind, new.target_id, new.status, new.awaiting,
     new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at, new.closed_by,
     new.commission_bp, new.commission_fixed_cents, new.commission_currency, new.split_bp,
     new.commission_includes_vat, new.terms_valid_until, new.terms_at, new.introducer_accepted_at,
     new.introducer_accepted_by, new.owner_accepted_at, new.owner_accepted_by, new.created_at, new.updated_at);
  return null;
end $$;
--> statement-breakpoint
revoke all on function viewing_requests_receipt() from public;
--> statement-breakpoint
create trigger viewing_requests_receipt after insert on viewing_requests
  for each row execute function viewing_requests_receipt();
--> statement-breakpoint
-- S11-02 sync, introducer → owner: a change of the shared state (status, times, outcome, the owner's acceptance as the
-- introducer row holds it — app_user cannot write it there) reaches the owner's copy in the same statement. Only the
-- pair of agencies on the row. A row whose shared state did not change copies nothing; the copy's own sync then finds
-- nothing different to copy back, which ends the exchange. A missing copy is an error (the two must stay in step).
create function viewing_requests_sync() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if (old.status, old.awaiting, old.proposed_start_at, old.scheduled_at, old.expires_at, old.outcome, old.outcome_at,
      old.closed_by, old.owner_accepted_at, old.owner_accepted_by, old.updated_at)
     is not distinct from
     (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at,
      new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at) then
    return null;
  end if;
  update public.viewing_request_receipts r
     set status = new.status, awaiting = new.awaiting, proposed_start_at = new.proposed_start_at,
         scheduled_at = new.scheduled_at, expires_at = new.expires_at, outcome = new.outcome,
         outcome_at = new.outcome_at, closed_by = new.closed_by, owner_accepted_at = new.owner_accepted_at,
         owner_accepted_by = new.owner_accepted_by, updated_at = new.updated_at
   where r.request_id = new.id and r.agency_id = new.owner_agency_id and r.introducer_agency_id = new.agency_id
     and (r.status, r.awaiting, r.proposed_start_at, r.scheduled_at, r.expires_at, r.outcome, r.outcome_at,
          r.closed_by, r.owner_accepted_at, r.owner_accepted_by, r.updated_at)
         is distinct from
         (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome,
          new.outcome_at, new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at);
  if not found and not exists (
    select 1 from public.viewing_request_receipts r
     where r.request_id = new.id and r.agency_id = new.owner_agency_id and r.introducer_agency_id = new.agency_id) then
    raise exception 'viewing_requests %: the owner''s copy is missing', new.id using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function viewing_requests_sync() from public;
--> statement-breakpoint
create trigger viewing_requests_sync after update on viewing_requests
  for each row execute function viewing_requests_sync();
--> statement-breakpoint
-- S11-02 sync, owner → introducer: the owner's answer (accept and with it the terms, decline, another time, outcome)
-- reaches the introducer's row in the same statement — the only way the owner's acceptance gets there.
create function viewing_request_receipts_sync() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if (old.status, old.awaiting, old.proposed_start_at, old.scheduled_at, old.expires_at, old.outcome, old.outcome_at,
      old.closed_by, old.owner_accepted_at, old.owner_accepted_by, old.updated_at)
     is not distinct from
     (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome, new.outcome_at,
      new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at) then
    return null;
  end if;
  update public.viewing_requests v
     set status = new.status, awaiting = new.awaiting, proposed_start_at = new.proposed_start_at,
         scheduled_at = new.scheduled_at, expires_at = new.expires_at, outcome = new.outcome,
         outcome_at = new.outcome_at, closed_by = new.closed_by, owner_accepted_at = new.owner_accepted_at,
         owner_accepted_by = new.owner_accepted_by, updated_at = new.updated_at
   where v.id = new.request_id and v.agency_id = new.introducer_agency_id and v.owner_agency_id = new.agency_id
     and (v.status, v.awaiting, v.proposed_start_at, v.scheduled_at, v.expires_at, v.outcome, v.outcome_at,
          v.closed_by, v.owner_accepted_at, v.owner_accepted_by, v.updated_at)
         is distinct from
         (new.status, new.awaiting, new.proposed_start_at, new.scheduled_at, new.expires_at, new.outcome,
          new.outcome_at, new.closed_by, new.owner_accepted_at, new.owner_accepted_by, new.updated_at);
  if not found and not exists (
    select 1 from public.viewing_requests v
     where v.id = new.request_id and v.agency_id = new.introducer_agency_id and v.owner_agency_id = new.agency_id) then
    raise exception 'viewing_request_receipts %: the introducer''s request is missing', new.request_id
      using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function viewing_request_receipts_sync() from public;
--> statement-breakpoint
create trigger viewing_request_receipts_sync after update on viewing_request_receipts
  for each row execute function viewing_request_receipts_sync();
--> statement-breakpoint
-- S11-02 terms (PLAN §3 #9). The snapshot (commission, split or fixed amount, VAT, validity), the parties, the target
-- and the introducer's acceptance never change after insert, for every role but app_owner (migrations; the sync
-- triggers never write them) — so neither copy can drift from the other. Once the owner accepted, its acceptance never
-- changes either, for every role: immutable after both acceptances.
create function viewing_terms_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  c text;
begin
  if current_user <> 'app_owner' then
    foreach c in array array['agency_id', 'owner_agency_id', 'introducer_agency_id', 'registration_id', 'target_kind',
        'target_id', 'commission_bp', 'commission_fixed_cents', 'commission_currency', 'split_bp',
        'commission_includes_vat', 'terms_valid_until', 'terms_at', 'introducer_accepted_at', 'introducer_accepted_by',
        'created_at'] loop
      if (o -> c) is distinct from (n -> c) then
        -- a row moved to another agency is a privilege error, as RLS reports it
        raise exception '%: % is fixed when the request is made', tg_table_name, c
          using errcode = case when c = 'agency_id' then '42501' else '23514' end;
      end if;
    end loop;
  end if;
  if old.owner_accepted_at is not null and (new.owner_accepted_at is distinct from old.owner_accepted_at
      or new.owner_accepted_by is distinct from old.owner_accepted_by) then
    raise exception '%: the accepted terms are immutable', tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;
--> statement-breakpoint
revoke all on function viewing_terms_guard() from public;
--> statement-breakpoint
create trigger viewing_terms_guard before update on viewing_requests
  for each row execute function viewing_terms_guard();
--> statement-breakpoint
create trigger viewing_terms_guard before update on viewing_request_receipts
  for each row execute function viewing_terms_guard();
--> statement-breakpoint
-- S11-02 guards: a viewing request is evidence for both sides — a request never deletes either copy, and the owner's
-- copy is appended only by `viewing_requests_receipt`. Only app_user is restricted (migrations, app_system are not).
create function viewing_requests_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
begin
  if current_user = 'app_user' then
    raise exception '%: % is not allowed for a request', tg_table_name, lower(tg_op) using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
--> statement-breakpoint
revoke all on function viewing_requests_guard() from public;
--> statement-breakpoint
create trigger viewing_requests_guard before delete on viewing_requests
  for each row execute function viewing_requests_guard();
--> statement-breakpoint
create trigger viewing_request_receipts_guard before insert or delete on viewing_request_receipts
  for each row execute function viewing_requests_guard();
