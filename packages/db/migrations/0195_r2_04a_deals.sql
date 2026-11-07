CREATE TABLE "deals" (
	"agency_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"party" text NOT NULL,
	"peer_agency_id" uuid NOT NULL,
	"viewing_request_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"commission_bp" integer,
	"commission_fixed_cents" bigint,
	"commission_currency" char(3),
	"split_bp" integer NOT NULL,
	"commission_includes_vat" boolean NOT NULL,
	"terms_at" timestamp with time zone NOT NULL,
	"stage" text NOT NULL,
	"stage_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"commission_total_cents" bigint GENERATED ALWAYS AS (case when commission_bp is not null then (price_cents * commission_bp + 5000) / 10000 else commission_fixed_cents end) STORED NOT NULL,
	"introducer_share_cents" bigint GENERATED ALWAYS AS (((case when commission_bp is not null then (price_cents * commission_bp + 5000) / 10000 else commission_fixed_cents end) * split_bp + 5000) / 10000) STORED NOT NULL,
	"owner_share_cents" bigint GENERATED ALWAYS AS ((case when commission_bp is not null then (price_cents * commission_bp + 5000) / 10000 else commission_fixed_cents end) - ((case when commission_bp is not null then (price_cents * commission_bp + 5000) / 10000 else commission_fixed_cents end) * split_bp + 5000) / 10000) STORED NOT NULL,
	"owner_confirmed_at" timestamp with time zone,
	"owner_confirmed_by" uuid,
	"introducer_confirmed_at" timestamp with time zone,
	"introducer_confirmed_by" uuid,
	"completed_at" timestamp with time zone,
	"fell_through_at" timestamp with time zone,
	"fell_through_reason" text,
	"closed_by" text,
	"mediated_at" timestamp with time zone,
	"mediated_by" uuid,
	"mediation_reason" text,
	"opened_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ms" timestamp with time zone GENERATED ALWAYS AS (date_trunc('milliseconds', created_at, 'UTC')) STORED NOT NULL,
	CONSTRAINT "deals_pk" PRIMARY KEY("agency_id","id"),
	CONSTRAINT "deals_party_ck" CHECK ("deals"."party" in ('OWNER', 'INTRODUCER') and "deals"."peer_agency_id" <> "deals"."agency_id"),
	CONSTRAINT "deals_target_ck" CHECK ("deals"."target_kind" in ('LISTING', 'DEVELOPMENT')),
	CONSTRAINT "deals_stage_ck" CHECK ("deals"."stage" in ('OFFER', 'RESERVATION', 'ARRAS', 'COMPLETION', 'FELL_THROUGH')),
	CONSTRAINT "deals_terms_ck" CHECK (("deals"."commission_bp" is null) <> ("deals"."commission_fixed_cents" is null)
        and ("deals"."commission_bp" is null or "deals"."commission_bp" between 1 and 10000)
        and ("deals"."commission_fixed_cents" is null
             or ("deals"."commission_fixed_cents" between 1 and 100000000000 and "deals"."commission_currency" = "deals"."currency"))
        and "deals"."split_bp" between 0 and 10000),
	CONSTRAINT "deals_price_ck" CHECK ("deals"."price_cents" between 1 and 10000000000000 and "deals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "deals_completion_ck" CHECK (("deals"."stage" = 'COMPLETION') = ("deals"."completed_at" is not null)),
	CONSTRAINT "deals_fell_through_ck" CHECK (("deals"."stage" = 'FELL_THROUGH') = ("deals"."fell_through_at" is not null)
        and ("deals"."stage" = 'FELL_THROUGH') = ("deals"."fell_through_reason" is not null)
        and ("deals"."stage" = 'FELL_THROUGH') = ("deals"."closed_by" is not null)
        and ("deals"."closed_by" is null or "deals"."closed_by" in ('OWNER', 'INTRODUCER', 'STAFF'))
        and ("deals"."fell_through_reason" is null or length("deals"."fell_through_reason") between 1 and 2000)),
	CONSTRAINT "deals_confirmed_ck" CHECK (("deals"."owner_confirmed_at" is null) = ("deals"."owner_confirmed_by" is null)
        and ("deals"."introducer_confirmed_at" is null) = ("deals"."introducer_confirmed_by" is null)),
	CONSTRAINT "deals_mediated_ck" CHECK (("deals"."mediated_at" is null) = ("deals"."mediated_by" is null)
        and ("deals"."mediated_at" is null) = ("deals"."mediation_reason" is null)
        and ("deals"."mediation_reason" is null or length("deals"."mediation_reason") between 1 and 2000))
);
--> statement-breakpoint
CREATE INDEX "deals_agency_created_idx" ON "deals" USING btree ("agency_id","created_ms","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_id_party_uq" ON "deals" USING btree ("id","party");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_viewing_open_uq" ON "deals" USING btree ("agency_id","viewing_request_id") WHERE "deals"."stage" <> 'FELL_THROUGH';--> statement-breakpoint
-- R2-04a insert guard: app_user opens its own copy of a deal only for a viewing request of its own side between exactly
-- these two agencies whose terms the owner accepted — scheduled (terms still binding) or completed with the client
-- attended. The target and the terms snapshot are copied from that request, whatever the insert says; a deal starts at
-- OFFER with nothing confirmed, closed or mediated, opened by the member itself, stamped with the database's now().
-- Workers and migrations are not restricted.
create function deals_insert_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
declare
  v record;
begin
  if current_user <> 'app_user' then
    return new;
  end if;
  if new.party = 'INTRODUCER' then
    select r.target_kind, r.target_id, r.commission_bp, r.commission_fixed_cents, r.commission_currency, r.split_bp,
           r.commission_includes_vat, r.terms_at, r.status, r.outcome, r.owner_accepted_at, r.terms_valid_until
      into v
      from public.viewing_requests r
     where r.id = new.viewing_request_id and r.agency_id = new.agency_id and r.owner_agency_id = new.peer_agency_id;
  elsif new.party = 'OWNER' then
    select r.target_kind, r.target_id, r.commission_bp, r.commission_fixed_cents, r.commission_currency, r.split_bp,
           r.commission_includes_vat, r.terms_at, r.status, r.outcome, r.owner_accepted_at, r.terms_valid_until
      into v
      from public.viewing_request_receipts r
     where r.request_id = new.viewing_request_id and r.agency_id = new.agency_id
       and r.introducer_agency_id = new.peer_agency_id;
  else
    raise exception 'deals: no such party' using errcode = '23514';
  end if;
  if not found or v.owner_accepted_at is null
     or not ((v.status = 'SCHEDULED' and v.terms_valid_until > now())
             or (v.status = 'COMPLETED' and v.outcome = 'ATTENDED')) then
    raise exception 'deals: no accepted viewing request between these agencies' using errcode = '42501';
  end if;
  if new.stage <> 'OFFER' or new.owner_confirmed_at is not null or new.owner_confirmed_by is not null
     or new.introducer_confirmed_at is not null or new.introducer_confirmed_by is not null
     or new.completed_at is not null or new.fell_through_at is not null or new.fell_through_reason is not null
     or new.closed_by is not null or new.mediated_at is not null or new.mediated_by is not null
     or new.mediation_reason is not null then
    raise exception 'deals: a deal starts as an offer' using errcode = '42501';
  end if;
  new.target_kind := v.target_kind;
  new.target_id := v.target_id;
  new.commission_bp := v.commission_bp;
  new.commission_fixed_cents := v.commission_fixed_cents;
  new.commission_currency := v.commission_currency;
  new.split_bp := v.split_bp;
  new.commission_includes_vat := v.commission_includes_vat;
  new.terms_at := v.terms_at;
  new.opened_by_user_id := public.app_user_id();
  new.stage_at := now();
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
--> statement-breakpoint
revoke all on function deals_insert_guard() from public;
--> statement-breakpoint
create trigger deals_insert_guard before insert on deals
  for each row execute function deals_insert_guard();
--> statement-breakpoint
-- R2-04a mirror: a new deal appends the peer agency's copy (the other party, the same id, terms and state; nobody of
-- the holder's members). SECURITY DEFINER owned by app_owner, search_path pinned, executable by nobody: it appends
-- through the table's `definer_append` policy. Its own insert (depth 2) mirrors nothing.
create function deals_mirror() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  insert into public.deals
    (agency_id, id, party, peer_agency_id, viewing_request_id, target_kind, target_id, commission_bp,
     commission_fixed_cents, commission_currency, split_bp, commission_includes_vat, terms_at, stage, stage_at,
     price_cents, currency, opened_by_user_id, created_at, updated_at)
  values (new.peer_agency_id, new.id, case new.party when 'OWNER' then 'INTRODUCER' else 'OWNER' end, new.agency_id,
     new.viewing_request_id, new.target_kind, new.target_id, new.commission_bp, new.commission_fixed_cents,
     new.commission_currency, new.split_bp, new.commission_includes_vat, new.terms_at, new.stage, new.stage_at,
     new.price_cents, new.currency, null, new.created_at, new.updated_at);
  return null;
end $$;
--> statement-breakpoint
revoke all on function deals_mirror() from public;
--> statement-breakpoint
create trigger deals_mirror after insert on deals
  for each row execute function deals_mirror();
--> statement-breakpoint
-- R2-04a sync: a change of the shared state (stage, price, the handshake, the fall-through, a staff mediation) reaches
-- the peer's copy in the same statement. A row whose shared state did not change copies nothing; the copy's own update
-- (depth 2) copies nothing back. A missing copy is an error (the two must stay in step).
create function deals_sync() returns trigger language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if (old.stage, old.stage_at, old.price_cents, old.currency, old.owner_confirmed_at, old.owner_confirmed_by,
      old.introducer_confirmed_at, old.introducer_confirmed_by, old.completed_at, old.fell_through_at,
      old.fell_through_reason, old.closed_by, old.mediated_at, old.mediated_by, old.mediation_reason, old.updated_at)
     is not distinct from
     (new.stage, new.stage_at, new.price_cents, new.currency, new.owner_confirmed_at, new.owner_confirmed_by,
      new.introducer_confirmed_at, new.introducer_confirmed_by, new.completed_at, new.fell_through_at,
      new.fell_through_reason, new.closed_by, new.mediated_at, new.mediated_by, new.mediation_reason, new.updated_at) then
    return null;
  end if;
  update public.deals d
     set stage = new.stage, stage_at = new.stage_at, price_cents = new.price_cents, currency = new.currency,
         owner_confirmed_at = new.owner_confirmed_at, owner_confirmed_by = new.owner_confirmed_by,
         introducer_confirmed_at = new.introducer_confirmed_at, introducer_confirmed_by = new.introducer_confirmed_by,
         completed_at = new.completed_at, fell_through_at = new.fell_through_at,
         fell_through_reason = new.fell_through_reason, closed_by = new.closed_by, mediated_at = new.mediated_at,
         mediated_by = new.mediated_by, mediation_reason = new.mediation_reason, updated_at = new.updated_at
   where d.agency_id = new.peer_agency_id and d.id = new.id and d.peer_agency_id = new.agency_id
     and d.party <> new.party;
  if not found then
    raise exception 'deals %: the peer''s copy is missing', new.id using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
revoke all on function deals_sync() from public;
--> statement-breakpoint
create trigger deals_sync after update on deals
  for each row execute function deals_sync();
--> statement-breakpoint
-- R2-04a guard (PLAN §3 #10). For every role but app_owner (migrations, the definer triggers): the parties, the viewing
-- request, the target, the terms snapshot, the opener and the creation never change, and a completed or fallen-through
-- deal changes only by staff mediation (app_staff: every change stamps a mediation by the staff member, with a reason).
-- app_user (a party, on its own copy): never mediates; confirms or withdraws only its own side of the handshake; moves
-- the stage forward only — to COMPLETION only when both sides confirmed, to FELL_THROUGH from any open stage with a
-- reason, closed by its own side; a price change clears both confirmations (the handshake is on the price). A request
-- never deletes a deal (evidence for both sides).
create function deals_guard() returns trigger language plpgsql security invoker
  set search_path = pg_catalog, public as $$
declare
  generated constant text[] := array['commission_total_cents', 'introducer_share_cents', 'owner_share_cents',
    'created_ms'];
  o jsonb;
  n jsonb;
  c text;
  ranks constant jsonb := '{"OFFER": 1, "RESERVATION": 2, "ARRAS": 3, "COMPLETION": 4}';
begin
  if current_user = 'app_owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if current_user = 'app_user' then
      raise exception 'deals: delete is not allowed for a request' using errcode = '42501';
    end if;
    return old;
  end if;
  o := to_jsonb(old) - generated;
  n := to_jsonb(new) - generated;
  foreach c in array array['agency_id', 'id', 'party', 'peer_agency_id', 'viewing_request_id', 'target_kind',
      'target_id', 'commission_bp', 'commission_fixed_cents', 'commission_currency', 'split_bp',
      'commission_includes_vat', 'terms_at', 'opened_by_user_id', 'created_at'] loop
    if (o -> c) is distinct from (n -> c) then
      raise exception 'deals: % is fixed when the deal is opened', c
        using errcode = case when c = 'agency_id' then '42501' else '23514' end;
    end if;
  end loop;
  if o = n then
    return new;
  end if;
  if current_user = 'app_staff' then
    if new.mediation_reason is null or new.mediated_by is distinct from public.app_user_id() then
      raise exception 'deals: staff change a deal only by a mediation with a reason' using errcode = '23514';
    end if;
    new.mediated_at := now();
    new.updated_at := now();
    return new;
  end if;
  if old.stage in ('COMPLETION', 'FELL_THROUGH') then
    raise exception 'deals: a closed deal changes only by staff mediation' using errcode = '23514';
  end if;
  if current_user <> 'app_user' then
    return new;
  end if;
  if (new.mediated_at, new.mediated_by, new.mediation_reason)
     is distinct from (old.mediated_at, old.mediated_by, old.mediation_reason) then
    raise exception 'deals: only staff mediate' using errcode = '42501';
  end if;
  if (old.party = 'OWNER' and (new.introducer_confirmed_at, new.introducer_confirmed_by)
        is distinct from (old.introducer_confirmed_at, old.introducer_confirmed_by))
     or (old.party = 'INTRODUCER' and (new.owner_confirmed_at, new.owner_confirmed_by)
        is distinct from (old.owner_confirmed_at, old.owner_confirmed_by)) then
    raise exception 'deals: a party confirms only its own side' using errcode = '42501';
  end if;
  if (old.party = 'OWNER' and new.owner_confirmed_by is distinct from old.owner_confirmed_by
        and new.owner_confirmed_by is not null and new.owner_confirmed_by <> public.app_user_id())
     or (old.party = 'INTRODUCER' and new.introducer_confirmed_by is distinct from old.introducer_confirmed_by
        and new.introducer_confirmed_by is not null and new.introducer_confirmed_by <> public.app_user_id()) then
    raise exception 'deals: a member confirms as themself' using errcode = '42501';
  end if;
  -- a confirmation is stamped with the database's clock, and only by a new confirmation (never backdated)
  if new.owner_confirmed_by is distinct from old.owner_confirmed_by then
    new.owner_confirmed_at := case when new.owner_confirmed_by is null then null else now() end;
  else
    new.owner_confirmed_at := old.owner_confirmed_at;
  end if;
  if new.introducer_confirmed_by is distinct from old.introducer_confirmed_by then
    new.introducer_confirmed_at := case when new.introducer_confirmed_by is null then null else now() end;
  else
    new.introducer_confirmed_at := old.introducer_confirmed_at;
  end if;
  if (new.price_cents, new.currency) is distinct from (old.price_cents, old.currency) then
    if new.stage = 'COMPLETION' then
      raise exception 'deals: the price cannot change in the completing update' using errcode = '23514';
    end if;
    new.owner_confirmed_at := null;
    new.owner_confirmed_by := null;
    new.introducer_confirmed_at := null;
    new.introducer_confirmed_by := null;
  end if;
  if new.stage = 'FELL_THROUGH' then
    if new.fell_through_reason is null or new.closed_by is distinct from old.party then
      raise exception 'deals: a deal falls through with a reason, closed by its party' using errcode = '23514';
    end if;
    new.fell_through_at := now();
  elsif (new.fell_through_at, new.fell_through_reason, new.closed_by)
        is distinct from (old.fell_through_at, old.fell_through_reason, old.closed_by) then
    raise exception 'deals: only a fall-through closes a deal' using errcode = '23514';
  elsif (ranks ->> new.stage)::int < (ranks ->> old.stage)::int then
    raise exception 'deals: the stage moves forward only' using errcode = '23514';
  end if;
  if new.stage = 'COMPLETION' then
    if new.owner_confirmed_at is null or new.introducer_confirmed_at is null then
      raise exception 'deals: completion needs both sides'' confirmation' using errcode = '23514';
    end if;
    new.completed_at := now();
  elsif new.completed_at is distinct from old.completed_at then
    raise exception 'deals: only the handshake completes a deal' using errcode = '23514';
  end if;
  -- the stage time is the database's, moved only by a stage change (never backdated)
  new.stage_at := case when new.stage <> old.stage then now() else old.stage_at end;
  new.updated_at := now();
  return new;
end $$;
--> statement-breakpoint
revoke all on function deals_guard() from public;
--> statement-breakpoint
create trigger deals_guard before update or delete on deals
  for each row execute function deals_guard();
